/**
 * Runtime registration for the tasks extension.
 *
 * Contains the main `tasksExtension` closure that wires tools, commands,
 * shortcuts, event handlers, and the status widget.  Domain logic is imported
 * from sibling modules (`../parsing`, `../agents`, `../state`, `../ui`).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon, getSpinner } from "../../_icons/index.js";
import {
	INTEROP_EVENT_NAMES,
	onInteropEvent,
	requestInteropState,
	startLegacyInteropBridge,
} from "../../_shared/interop-events.js";
import {
	formatIdentityText,
	formatPresentationText,
	type PresentationRole,
} from "../../tool-display/index.js";
import {
	type AgentActivity,
	type AgentIdentity,
	classifyAgent,
	refineAgentIdentityAsync,
	summarizeToolCall,
} from "../agents/index.js";
import { findCompletedTasks } from "../parsing/index.js";
import {
	type BgTaskView,
	cleanupStaleTeams,
	getTextContent,
	isAssistantMessage,
	MIN_SIDE_BY_SIDE_WIDTH,
	nextTaskId,
	type SubagentView,
	shouldClearOnAgentEnd,
	type Task,
	type TaskComment,
	type TaskListStore,
	type TaskStatus,
	type TasksState,
	type TeamWidgetView,
} from "../state/index.js";
import { mergeSideBySide } from "../ui/index.js";

// ── Module-level mutable singletons ──────────────────────────────────────────
// These live outside the closure so they survive extension reloads.

/** Interval driving spinner animation and periodic widget refresh. */
let tasksAnimationInterval: ReturnType<typeof setInterval> | undefined;
/** Cleanup for typed interop event subscriptions. */
let interopEventsCleanup: (() => void) | undefined;
/** Cleanup for legacy globalThis compatibility bridge polling. */
let legacyInteropBridgeCleanup: (() => void) | undefined;
/** Cleanup for subagent activity listeners. */
let subagentEventsCleanup: (() => void) | undefined;

/**
 * Tracks the current activity of each running subagent by agent_id.
 * Populated from subagent_tool_call events, cleared on subagent_stop.
 */
const agentActivity = new Map<string, AgentActivity>();

/** Cached agent identities keyed by subagent ID. */
const agentIdentities = new Map<string, AgentIdentity>();

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Registers task management tools, commands, and widget.
 *
 * @param pi - Extension API for registering tools, commands, and event handlers
 * @param store - Pre-constructed {@link TaskListStore} for file persistence
 * @param teamName - Active team name (or null for session-only mode)
 */
export function registerTasksExtension(
	pi: ExtensionAPI,
	store: TaskListStore,
	teamName: string | null
): void {
	const isSubagent = process.env.PI_IS_SUBAGENT === "1";
	const state: TasksState = {
		tasks: [],
		visible: true,
		activeTaskId: null,
		nextId: 1,
	};

	/** Turns since last manage_tasks tool use. Reset on tool call, incremented on turn_end. */
	let turnsSinceLastTaskTool = 0;
	/** Auto-clear orphaned tasks after this many turns of silence. */
	const STALE_TURN_THRESHOLD = 3;

	// Render the task widget
	let lastWidgetContent = "";

	// Spinner frames for animation
	const SPINNER_FRAMES = getSpinner() ?? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let spinnerFrame = 0;
	let foregroundSubagents: SubagentView[] = [];
	let backgroundSubagents: SubagentView[] = [];
	let backgroundTasks: BgTaskView[] = [];
	let activeTeams: TeamWidgetView[] = [];
	let teamDashboardActive = false;

	if (tasksAnimationInterval) clearInterval(tasksAnimationInterval);
	tasksAnimationInterval = undefined;
	interopEventsCleanup?.();
	interopEventsCleanup = undefined;
	legacyInteropBridgeCleanup?.();
	legacyInteropBridgeCleanup = undefined;
	subagentEventsCleanup?.();
	subagentEventsCleanup = undefined;

	/**
	 * Apply shared semantic presentation styling for task-widget fragments.
	 * @param ctx - Extension context containing the active theme
	 * @param role - Semantic role for hierarchy styling
	 * @param text - Raw text fragment
	 * @returns Styled text fragment
	 */
	function formatWidgetRole(ctx: ExtensionContext, role: PresentationRole, text: string): string {
		return formatPresentationText(ctx.ui.theme, role, text);
	}

	/**
	 * Format an identity token with deterministic shared colors.
	 * @param identity - Identity seed (without @ prefix)
	 * @param highlighted - Whether to apply bold emphasis
	 * @returns Styled identity token
	 */
	function formatWidgetIdentity(identity: string, highlighted = true): string {
		return formatIdentityText(`@${identity}`, identity, highlighted);
	}

	/**
	 * Render task list lines (left column in side-by-side mode)
	 */
	function renderTaskLines(ctx: ExtensionContext, maxTitleLen: number): string[] {
		if (state.tasks.length === 0) return [];

		const lines: string[] = [];
		const completed = state.tasks.filter((t) => t.status === "completed").length;
		const maxVisible = Math.min(10, state.tasks.length);
		const visibleTasks = state.tasks.slice(0, maxVisible);

		lines.push(formatWidgetRole(ctx, "title", `Tasks (${completed}/${state.tasks.length})`));

		for (let i = 0; i < visibleTasks.length; i++) {
			const task = visibleTasks[i];
			const isLast = i === visibleTasks.length - 1 && state.tasks.length <= maxVisible;
			const treeChar = isLast ? "└─" : "├─";
			let icon: string;
			let textStyle: (value: string) => string;

			// Check if a running agent is actively working on this task.
			// No owner = main agent is working on it (always active while in_progress).
			// With owner = check if that subagent or team teammate is still running.
			const hasActiveAgent = task.owner
				? [...agentIdentities.values()].some((id) => id.displayName === task.owner) ||
					foregroundSubagents.some((s) => s.agent === task.owner && s.status === "running") ||
					backgroundSubagents.some((s) => s.agent === task.owner && s.status === "running") ||
					activeTeams
						.flatMap((team) => team.teammates)
						.some((teammate) => teammate.name === task.owner && teammate.status === "working")
				: true;

			switch (task.status) {
				case "completed":
					icon = formatWidgetRole(ctx, "status_success", getIcon("success"));
					textStyle = (value) => formatWidgetRole(ctx, "meta", ctx.ui.theme.strikethrough(value));
					break;
				case "in_progress":
					// Only animate spinner when a real agent is working; otherwise static indicator.
					if (hasActiveAgent) {
						icon = formatWidgetRole(
							ctx,
							"status_warning",
							SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
						);
					} else {
						icon = formatWidgetRole(ctx, "status_warning", getIcon("in_progress"));
					}
					textStyle = (value) => formatWidgetRole(ctx, "action", value);
					break;
				default:
					icon = getIcon("pending");
					textStyle = (value) => formatWidgetRole(ctx, "action", value);
			}

			const label =
				task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;

			const ownerSuffix = task.owner
				? ` ${formatWidgetRole(ctx, "meta", "(")}${formatWidgetIdentity(task.owner)}${formatWidgetRole(ctx, "meta", ")")}`
				: "";
			const ownerVisibleLen = task.owner ? 4 + task.owner.length : 0; // " (@name)"
			const titleBudget = Math.max(10, maxTitleLen - ownerVisibleLen - task.id.length - 2);
			const title =
				label.length > titleBudget ? `${label.substring(0, titleBudget - 3)}...` : label;
			lines.push(
				`${formatWidgetRole(ctx, "meta", treeChar)} ${icon} ${formatWidgetRole(ctx, "meta", `#${task.id}`)} ${textStyle(title)}${ownerSuffix}`
			);

			// Blocked-by tree: show blocking agent names as a subdued sub-tree.
			if (task.blockedBy.length > 0 && task.status !== "completed") {
				const contChar = isLast ? " " : "│";
				const blockerNames = task.blockedBy
					.map((depId) => {
						const dep = state.tasks.find((t) => t.id === depId);
						return dep?.owner
							? formatWidgetIdentity(dep.owner, false)
							: formatWidgetRole(ctx, "meta", `#${depId}`);
					})
					.join(formatWidgetRole(ctx, "meta", ", "));
				lines.push(
					`${formatWidgetRole(ctx, "meta", `${contChar}  └─`)} ${formatWidgetRole(ctx, "hint", "blocked by")} ${blockerNames}`
				);
			}
		}

		if (state.tasks.length > maxVisible) {
			lines.push(
				formatWidgetRole(ctx, "hint", `└─ ... and ${state.tasks.length - maxVisible} more`)
			);
		}

		return lines;
	}

	/**
	 * Render subagent lines (right column in side-by-side mode, or below tasks in stacked mode).
	 */
	function renderSubagentLines(
		ctx: ExtensionContext,
		spinner: string,
		fgRunning: Array<{
			id: string;
			agent: string;
			model?: string;
			task: string;
			startTime: number;
		}>,
		bgRunning: Array<{
			id: string;
			agent: string;
			model?: string;
			task: string;
			startTime: number;
		}>,
		maxTaskPreviewLen: number,
		_standalone: boolean
	): string[] {
		const allRunning = [...fgRunning, ...bgRunning];
		if (allRunning.length === 0) return [];

		/**
		 * Build a compact model label for widget rows.
		 * @param model - Optional model identifier
		 * @returns Styled model label, or empty string
		 */
		function getModelLabel(model: string | undefined): string {
			if (!model) return "";
			const modelId = model.split("/").at(-1) ?? model;
			const shortModel = modelId.length > 18 ? `${modelId.slice(0, 15)}...` : modelId;
			return ` ${formatWidgetRole(ctx, "hint", `(${shortModel})`)}`;
		}

		const models = [...new Set(allRunning.map((sub) => sub.model).filter(Boolean))];
		const modelSummary =
			models.length > 0
				? formatWidgetRole(
						ctx,
						"meta",
						` · ${models
							.map((model) => {
								const modelId = String(model).split("/").at(-1) ?? String(model);
								return modelId.length > 12 ? `${modelId.slice(0, 9)}...` : modelId;
							})
							.join(", ")}`
					)
				: "";

		const lines: string[] = [];
		const count = allRunning.length;
		lines.push(`${formatWidgetRole(ctx, "title", `Subagents (${count} running)`)}${modelSummary}`);

		for (let i = 0; i < allRunning.length; i++) {
			const sub = allRunning[i];
			const isLast = i === allRunning.length - 1;
			const treeChar = isLast ? "└─" : "├─";
			const contChar = isLast ? " " : "│";
			const ms = Date.now() - sub.startTime;
			const secs = Math.floor(ms / 1000);
			const duration = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;

			// Line 1: spinner + @display-name + model + role + duration.
			const identity = agentIdentities.get(sub.id);
			const displayName = identity?.displayName ?? sub.agent;
			const typeSuffix = identity?.typeLabel
				? ` ${formatWidgetRole(ctx, "meta", `(${identity.typeLabel})`)}`
				: "";
			lines.push(
				`${formatWidgetRole(ctx, "meta", treeChar)} ${formatWidgetRole(ctx, "status_warning", spinner)} ${formatWidgetIdentity(displayName)}${getModelLabel(sub.model)}${typeSuffix} ${formatWidgetRole(ctx, "meta", `· ${duration}`)}`
			);

			// Line 2: assigned action preview.
			const flatTask = sub.task.replace(/\n+/g, " ").replace(/\s{2,}/g, " ");
			const taskPreview =
				flatTask.length > maxTaskPreviewLen
					? `${flatTask.slice(0, maxTaskPreviewLen - 3)}...`
					: flatTask;
			lines.push(
				`${formatWidgetRole(ctx, "meta", `${contChar}  `)} ${formatWidgetRole(ctx, "action", taskPreview)}`
			);

			// Line 3: live tool chatter (subdued vs identity + action context).
			const activity = agentActivity.get(sub.id);
			if (activity) {
				const activityText =
					activity.summary.length > maxTaskPreviewLen
						? `${activity.summary.slice(0, maxTaskPreviewLen - 3)}...`
						: activity.summary;
				lines.push(
					`${formatWidgetRole(ctx, "meta", `${contChar}  `)} ${formatWidgetRole(ctx, "process_output", activityText)}`
				);
			}
		}

		return lines;
	}

	/**
	 * Render background bash task lines
	 */
	function renderBgBashLines(
		ctx: ExtensionContext,
		maxCmdLen: number,
		running: BgTaskView[]
	): string[] {
		if (running.length === 0) return [];

		const lines: string[] = [];
		lines.push(formatWidgetRole(ctx, "title", `Background Tasks (${running.length})`));

		for (let i = 0; i < Math.min(running.length, 5); i++) {
			const task = running[i];
			const isLast = i === Math.min(running.length, 5) - 1 && running.length <= 5;
			const treeChar = isLast ? "└─" : "├─";
			const ms = Date.now() - task.startTime;
			const secs = Math.floor(ms / 1000);
			const duration = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
			// Collapse newlines and truncate to max length.
			const flatCmd = task.command.replace(/\n/g, " ↵ ");
			const cmd = flatCmd.length > maxCmdLen ? `${flatCmd.slice(0, maxCmdLen - 3)}...` : flatCmd;
			lines.push(
				`${formatWidgetRole(ctx, "meta", treeChar)} ${formatWidgetRole(ctx, "status_warning", getIcon("in_progress"))} ${formatWidgetRole(ctx, "process_output", cmd)} ${formatWidgetRole(ctx, "meta", `(${duration})`)}`
			);
		}

		if (running.length > 5) {
			lines.push(formatWidgetRole(ctx, "hint", `└─ ... and ${running.length - 5} more`));
		}

		return lines;
	}

	/**
	 * Render active team lines for the widget.
	 * Shows team name, task progress, and teammate status.
	 * @param ctx - Extension context for theme access
	 * @param spinner - Current spinner frame for working teammates
	 * @param teams - Array of team views to render
	 * @param maxLen - Max title length before truncation
	 * @returns Array of styled lines
	 */
	function renderTeamLines(
		ctx: ExtensionContext,
		spinner: string,
		teams: TeamWidgetView[],
		maxLen: number
	): string[] {
		const lines: string[] = [];

		for (let ti = 0; ti < teams.length; ti++) {
			const team = teams[ti];
			if (ti > 0) lines.push(""); // spacer between teams

			const completed = team.tasks.filter((t) => t.status === "completed").length;
			const total = team.tasks.length;
			const allDone = completed === total && total > 0;

			// Header: "Team: name (2/3 tasks)" or "Team: name ✓ 3/3 complete"
			if (allDone) {
				lines.push(
					formatWidgetRole(ctx, "status_success", `Team: ${team.name}`) +
						formatWidgetRole(
							ctx,
							"status_success",
							` ${getIcon("success")} ${total}/${total} complete`
						)
				);
			} else {
				lines.push(
					formatWidgetRole(ctx, "title", `Team: ${team.name}`) +
						formatWidgetRole(ctx, "meta", ` (${completed}/${total} tasks)`)
				);
			}

			// Teammates with their current task.
			for (let i = 0; i < team.teammates.length; i++) {
				const mate = team.teammates[i];
				const isLast = i === team.teammates.length - 1;
				const treeChar = isLast ? "└─" : "├─";

				const isFinished =
					allDone &&
					mate.status === "idle" &&
					!mate.currentTask &&
					Math.max(0, Math.floor(mate.completedTaskCount ?? 0)) > 0;
				const statusIcon =
					mate.status === "working"
						? formatWidgetRole(ctx, "status_warning", spinner)
						: isFinished
							? formatWidgetRole(ctx, "status_success", getIcon("success"))
							: mate.status === "idle"
								? formatWidgetRole(ctx, "meta", getIcon("blocked"))
								: formatWidgetRole(ctx, "meta", "⏹");

				const taskSuffix = mate.currentTask
					? ` ${formatWidgetRole(ctx, "meta", "→")} ${formatWidgetRole(ctx, "action", mate.currentTask.length > maxLen ? `${mate.currentTask.slice(0, maxLen - 3)}...` : mate.currentTask)}`
					: isFinished
						? formatWidgetRole(ctx, "status_success", " (done)")
						: mate.status === "idle"
							? formatWidgetRole(ctx, "hint", " (idle)")
							: "";

				lines.push(
					`${formatWidgetRole(ctx, "meta", treeChar)} ${statusIcon} ${formatWidgetIdentity(mate.name)}${taskSuffix}`
				);
			}
		}

		return lines;
	}

	/**
	 * Update the footer status bar with colored agent names.
	 * Shows: @main @alice @bob · shift+↑ to expand
	 * @param ctx - Extension context for UI access
	 */
	function updateAgentBar(ctx: ExtensionContext): void {
		if (isSubagent) return;

		const fgRunning = foregroundSubagents.filter((subagent) => subagent.status === "running");
		const bgRunning = backgroundSubagents.filter((subagent) => subagent.status === "running");
		const allAgents = [...fgRunning, ...bgRunning];

		// Collect team teammate names
		const teamMates: Array<{ name: string; status: string }> = [];
		for (const team of activeTeams) {
			for (const teammate of team.teammates) {
				if (teammate.status === "working" || teammate.status === "idle") {
					teamMates.push(teammate);
				}
			}
		}

		if (allAgents.length === 0 && teamMates.length === 0) {
			ctx.ui.setStatus("agents", undefined);
			return;
		}

		// Build colored agent name list using generated display names
		const agentNames = new Set<string>();
		agentNames.add("main"); // Lead agent is always present
		for (const sub of allAgents) {
			const identity = agentIdentities.get(sub.id);
			agentNames.add(identity?.displayName ?? sub.agent);
		}
		for (const m of teamMates) {
			agentNames.add(m.name);
		}

		const totalCount = allAgents.length + teamMates.length;
		const coloredNames = [...agentNames].map((name) => formatWidgetIdentity(name)).join(" ");

		ctx.ui.setStatus(
			"agents",
			`${coloredNames} ${formatWidgetRole(ctx, "meta", "·")} ${formatWidgetRole(ctx, "hint", `${totalCount} teammate${totalCount > 1 ? "s" : ""}`)}`
		);
	}

	function updateWidget(ctx: ExtensionContext): void {
		// Subagents have no UI — skip all widget rendering
		if (isSubagent) return;

		// If every task is completed and the 2s completion window has passed,
		// clear the list. This covers extension reloads where the original
		// setTimeout callback was lost before it could run.
		if (state.tasks.length > 0 && state.tasks.every((task) => task.status === "completed")) {
			const latestCompletedAt = Math.max(
				...state.tasks.map((task) => task.completedAt ?? task.createdAt)
			);
			if (Date.now() - latestCompletedAt >= 2000) {
				clearTasks();
			}
		}

		if (teamDashboardActive) {
			if (lastWidgetContent !== "") {
				ctx.ui.setWidget("1-tasks", undefined);
				lastWidgetContent = "";
			}
			return;
		}

		const fgRunning = foregroundSubagents.filter((subagent) => subagent.status === "running");
		const bgRunning = backgroundSubagents.filter((subagent) => subagent.status === "running");
		const runningBgTasks = backgroundTasks.filter((task) => task.status === "running");

		const hasSubagents = fgRunning.length > 0 || bgRunning.length > 0;
		const hasBgTasks = runningBgTasks.length > 0;
		const hasTeams = activeTeams.length > 0;
		const hasRightColumn = hasSubagents || hasBgTasks || hasTeams;
		const hasTasks = state.tasks.length > 0;

		if (!(state.visible && (hasTasks || hasRightColumn))) {
			if (lastWidgetContent !== "") {
				ctx.ui.setWidget("1-tasks", undefined);
				lastWidgetContent = "";
			}
			return;
		}

		const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];

		// Build stable key for structure changes
		const taskStates = state.tasks.map((t) => `${t.id}:${t.status}`).join(",");
		const fgIds = fgRunning.map((s) => s.id).join(",");
		const bgIds = bgRunning.map((s) => s.id).join(",");
		const bgTaskIds = runningBgTasks.map((t) => t.id).join(",");
		const teamKey = activeTeams
			.map(
				(t) =>
					`${t.name}:${t.tasks.map((tk) => tk.status).join("")}:${t.teammates.map((m) => m.status).join("")}`
			)
			.join("|");
		const stableKey = `${taskStates}|${fgIds}|${bgIds}|${bgTaskIds}|${teamKey}`;

		// Re-render when structure changes, background items running (for animation),
		// or in_progress tasks exist (spinner needs to animate every frame).
		const hasInProgressTasks = state.tasks.some((t) => t.status === "in_progress");
		const hasWorkingTeammates = activeTeams.some((t) =>
			t.teammates.some((m) => m.status === "working")
		);
		if (
			!(hasRightColumn || hasInProgressTasks || hasWorkingTeammates) &&
			stableKey === lastWidgetContent
		) {
			return;
		}
		lastWidgetContent = stableKey;

		// Use function form of setWidget for responsive width-based layout
		ctx.ui.setWidget("1-tasks", (_tui, _theme) => ({
			render(width: number): string[] {
				const useSideBySide = width >= MIN_SIDE_BY_SIDE_WIDTH && hasTasks && hasRightColumn;

				if (useSideBySide) {
					// Side-by-side: tasks on left, subagents + bg tasks on right (bottom-aligned)
					const separator = "\x1b[38;2;60;60;70m  │  \x1b[0m"; // Dark gray
					const separatorWidth = 5; // "  │  " is 5 visible chars
					const columnWidth = Math.floor((width - separatorWidth) / 2);

					// Adjust max lengths for column width
					const maxTitleLen = Math.max(20, columnWidth - 8);
					const maxTaskPreviewLen = Math.max(15, columnWidth - 25);
					const maxCmdLen = Math.max(15, columnWidth - 15);

					const taskLines = renderTaskLines(ctx, maxTitleLen);

					// Build right column: teams, then subagents, then bg tasks
					const rightLines: string[] = [];
					if (hasTeams) {
						rightLines.push(...renderTeamLines(ctx, spinner, activeTeams, maxTaskPreviewLen));
					}
					if (hasSubagents) {
						if (rightLines.length > 0) rightLines.push(""); // Spacer
						rightLines.push(
							...renderSubagentLines(ctx, spinner, fgRunning, bgRunning, maxTaskPreviewLen, true)
						);
					}
					if (hasBgTasks) {
						if (rightLines.length > 0) rightLines.push(""); // Spacer
						rightLines.push(...renderBgBashLines(ctx, maxCmdLen, runningBgTasks));
					}

					return mergeSideBySide(taskLines, rightLines, columnWidth, separator, width);
				}

				// Stacked layout (narrow terminal or only one section)
				// "├─ ◐ " prefix = 5 visible chars, leave room for width
				const maxTitleLen = Math.max(10, width - 5);
				const maxTaskPreviewLen = Math.max(15, width - 25);
				const maxCmdLen = Math.max(15, width - 15);
				const lines: string[] = [];

				if (hasTasks) {
					lines.push(...renderTaskLines(ctx, maxTitleLen));
				}

				if (hasTeams) {
					if (lines.length > 0) lines.push(""); // Spacer
					lines.push(...renderTeamLines(ctx, spinner, activeTeams, maxTaskPreviewLen));
				}

				if (hasSubagents) {
					if (lines.length > 0) lines.push(""); // Spacer
					lines.push(
						...renderSubagentLines(ctx, spinner, fgRunning, bgRunning, maxTaskPreviewLen, !hasTasks)
					);
				}

				if (hasBgTasks) {
					if (lines.length > 0) lines.push(""); // Spacer
					lines.push(...renderBgBashLines(ctx, maxCmdLen, runningBgTasks));
				}

				// Safety net: truncate all lines to terminal width
				return lines.map((line) =>
					visibleWidth(line) > width ? truncateToWidth(line, width, "") : line
				);
			},
			invalidate(): void {
				// No caching needed - state is external
			},
		}));
	}

	// ── Persistence ─────────────────────────────────────────────────

	/**
	 * Persist current state. Routes to file store (shared mode) or session
	 * entries (session-only mode).
	 */
	function persistState(): void {
		if (store.isShared) {
			// In shared mode, individual task saves happen at mutation sites.
			// This saves the meta state (visibility, nextId) as a session entry
			// so widget prefs survive compaction even in shared mode.
			pi.appendEntry("tasks-state", {
				visible: state.visible,
				nextId: state.nextId,
				activeTaskId: state.activeTaskId,
			});
		} else {
			pi.appendEntry("tasks-state", {
				tasks: state.tasks,
				activeTaskId: state.activeTaskId,
				visible: state.visible,
				nextId: state.nextId,
			});
		}
	}

	/**
	 * Save a single task to the file store (no-op in session-only mode).
	 * @param task - Task to persist
	 */
	function persistTask(task: Task): void {
		store.saveTask(task);
	}

	/**
	 * Load tasks from the file store into state (shared mode only).
	 * @returns True if tasks were loaded from store
	 */
	function loadFromStore(): boolean {
		const tasks = store.loadAll();
		if (tasks === null) return false;
		state.tasks = tasks;
		// Recalculate nextId from loaded tasks
		const maxId = tasks.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0);
		state.nextId = maxId + 1;
		// Restore activeTaskId from in_progress task
		const active = tasks.find((t) => t.status === "in_progress");
		state.activeTaskId = active?.id ?? null;
		return true;
	}

	// ── Task operations ─────────────────────────────────────────────

	/**
	 * Create a new task.
	 * @param subject - Short summary
	 * @param opts - Optional description, activeForm, metadata
	 * @returns The created task
	 */
	function addTask(
		subject: string,
		opts?: { description?: string; activeForm?: string; metadata?: Record<string, unknown> }
	): Task {
		const task: Task = {
			id: nextTaskId(state),
			subject,
			description: opts?.description,
			activeForm: opts?.activeForm,
			status: "pending",
			blocks: [],
			blockedBy: [],
			comments: [],
			metadata: opts?.metadata,
			createdAt: Date.now(),
		};
		state.tasks.push(task);
		persistTask(task);
		return task;
	}

	/**
	 * Update a task's status with dependency enforcement.
	 * @param taskId - Task ID to update
	 * @param status - New status
	 * @returns True if update succeeded
	 */
	function updateTaskStatus(taskId: string, status: TaskStatus): boolean {
		const task = state.tasks.find((t) => t.id === taskId);
		if (!task) return false;

		// If completing, check blockedBy deps
		if (status === "completed") {
			const unmetDeps = task.blockedBy.filter((depId) => {
				const dep = state.tasks.find((t) => t.id === depId);
				return dep && dep.status !== "completed";
			});
			if (unmetDeps.length > 0) {
				return false; // Can't complete task with unmet dependencies
			}
			task.completedAt = Date.now();
		}

		// Track active task (last one set to in_progress)
		if (status === "in_progress") {
			state.activeTaskId = taskId;
		}

		task.status = status;
		persistTask(task);
		return true;
	}

	/**
	 * Return blocking dependency IDs that are not completed yet.
	 */
	function getUnmetDependencyIds(task: Task): string[] {
		return task.blockedBy.filter((depId) => {
			const dep = state.tasks.find((t) => t.id === depId);
			return dep && dep.status !== "completed";
		});
	}

	/**
	 * Find the next pending task that is unblocked and ready to start.
	 */
	function findNextRunnablePendingTask(): Task | undefined {
		return state.tasks.find((t) => t.status === "pending" && getUnmetDependencyIds(t).length === 0);
	}

	/**
	 * Auto-start one next task only when no task is currently in progress.
	 */
	function autoStartNextPendingTask(): void {
		const hasInProgress = state.tasks.some((t) => t.status === "in_progress");
		if (hasInProgress) return;
		const nextPending = findNextRunnablePendingTask();
		if (nextPending) {
			updateTaskStatus(nextPending.id, "in_progress");
		}
	}

	/**
	 * Add bidirectional blocking relationships.
	 * @param taskId - Task to modify
	 * @param addBlocks - Task IDs this task should block
	 * @param addBlockedBy - Task IDs that should block this task
	 */
	function updateTaskDeps(taskId: string, addBlocks?: string[], addBlockedBy?: string[]): void {
		const task = state.tasks.find((t) => t.id === taskId);
		if (!task) return;

		if (addBlocks) {
			for (const targetId of addBlocks) {
				if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
				// Mirror: add this task to target's blockedBy
				const target = state.tasks.find((t) => t.id === targetId);
				if (target && !target.blockedBy.includes(taskId)) {
					target.blockedBy.push(taskId);
					persistTask(target);
				}
			}
		}

		if (addBlockedBy) {
			for (const blockerId of addBlockedBy) {
				if (!task.blockedBy.includes(blockerId)) task.blockedBy.push(blockerId);
				// Mirror: add this task to blocker's blocks
				const blocker = state.tasks.find((t) => t.id === blockerId);
				if (blocker && !blocker.blocks.includes(taskId)) {
					blocker.blocks.push(taskId);
					persistTask(blocker);
				}
			}
		}

		persistTask(task);
	}

	/**
	 * Add a comment to a task.
	 * @param taskId - Task to add comment to
	 * @param author - Who wrote the comment
	 * @param content - Comment text
	 * @returns True if comment was added
	 */
	function addComment(taskId: string, author: string, content: string): boolean {
		const task = state.tasks.find((t) => t.id === taskId);
		if (!task) return false;

		task.comments.push({ author, content, timestamp: Date.now() });
		persistTask(task);
		return true;
	}

	/**
	 * Delete a task and clean up dep references.
	 * @param taskId - Task ID to remove
	 * @returns True if task was found and deleted
	 */
	function deleteTask(taskId: string): boolean {
		const index = state.tasks.findIndex((t) => t.id === taskId);
		if (index === -1) return false;

		state.tasks.splice(index, 1);

		// Remove from other tasks' deps (both directions)
		for (const task of state.tasks) {
			const hadBlock = task.blocks.includes(taskId);
			const hadBlockedBy = task.blockedBy.includes(taskId);
			task.blocks = task.blocks.filter((id) => id !== taskId);
			task.blockedBy = task.blockedBy.filter((id) => id !== taskId);
			if (hadBlock || hadBlockedBy) persistTask(task);
		}

		if (state.activeTaskId === taskId) {
			state.activeTaskId = null;
		}

		store.deleteTask(taskId);
		return true;
	}

	/**
	 * Clear all tasks.
	 */
	function clearTasks(): void {
		store.deleteAll();
		state.tasks = [];
		state.activeTaskId = null;
		state.nextId = 1;
	}

	// Toggle visibility
	function toggleVisibility(ctx: ExtensionContext): void {
		state.visible = !state.visible;
		updateWidget(ctx);
		persistState();
		ctx.ui.notify(state.visible ? "Task list shown" : "Task list hidden", "info");
	}

	// Register /tasks command (main process only — subagents have no interactive UI)
	if (!isSubagent)
		pi.registerCommand("tasks", {
			description: "Manage tasks - list, add, complete, delete, clear",
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/);
				const subcommand = parts[0]?.toLowerCase() || "list";
				const rest = parts.slice(1).join(" ");

				switch (subcommand) {
					case "list":
					case "show": {
						if (state.tasks.length === 0) {
							ctx.ui.notify(
								"No tasks. Ask Claude to create a plan or use /tasks add <task>",
								"info"
							);
							return;
						}
						const list = state.tasks
							.map((t) => {
								const icon =
									t.status === "completed"
										? getIcon("success")
										: t.status === "in_progress"
											? getIcon("in_progress")
											: getIcon("pending");
								const blocked =
									t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
								const comments =
									t.comments.length > 0 ? ` ${getIcon("comment")}${t.comments.length}` : "";
								return `${t.id}. ${icon} ${t.subject}${blocked}${comments}`;
							})
							.join("\n");
						const mode = store.isShared
							? ` [team: ${process.env.PI_TEAM_NAME}]`
							: " [session-only]";
						ctx.ui.notify(`Tasks${mode}:\n${list}`, "info");
						break;
					}

					case "add": {
						if (!rest) {
							ctx.ui.notify("Usage: /tasks add <task subject>", "error");
							return;
						}
						const task = addTask(rest, {});
						updateWidget(ctx);
						persistState();
						ctx.ui.notify(`Added #${task.id}: ${task.subject}`, "info");
						break;
					}

					case "complete":
					case "done": {
						const num = Number.parseInt(rest, 10);
						if (Number.isNaN(num) || num < 1 || num > state.tasks.length) {
							ctx.ui.notify(`Usage: /tasks complete <number> (1-${state.tasks.length})`, "error");
							return;
						}
						const task = state.tasks[num - 1];
						if (updateTaskStatus(task.id, "completed")) {
							updateWidget(ctx);
							persistState();
							ctx.ui.notify(`Completed: ${task.subject}`, "info");
						} else {
							ctx.ui.notify("Cannot complete task - blocked by unfinished dependencies", "error");
						}
						break;
					}

					case "start":
					case "active": {
						const num = Number.parseInt(rest, 10);
						if (Number.isNaN(num) || num < 1 || num > state.tasks.length) {
							ctx.ui.notify(`Usage: /tasks start <number> (1-${state.tasks.length})`, "error");
							return;
						}
						const task = state.tasks[num - 1];
						updateTaskStatus(task.id, "in_progress");
						updateWidget(ctx);
						persistState();
						ctx.ui.notify(`Started: ${task.subject}`, "info");
						break;
					}

					case "delete":
					case "remove": {
						const num = Number.parseInt(rest, 10);
						if (Number.isNaN(num) || num < 1 || num > state.tasks.length) {
							ctx.ui.notify(`Usage: /tasks delete <number> (1-${state.tasks.length})`, "error");
							return;
						}
						const task = state.tasks[num - 1];
						deleteTask(task.id);
						updateWidget(ctx);
						persistState();
						ctx.ui.notify(`Deleted: ${task.subject}`, "info");
						break;
					}

					case "team": {
						const current = store.isShared ? process.env.PI_TEAM_NAME : "(none — session-only)";
						const teamPath = store.path ?? "N/A";
						ctx.ui.notify(`Team: ${current}\nPath: ${teamPath}`, "info");
						break;
					}

					case "clear": {
						const count = state.tasks.length;
						clearTasks();
						updateWidget(ctx);
						persistState();
						ctx.ui.notify(`Cleared ${count} tasks`, "info");
						break;
					}

					case "toggle":
					case "hide": {
						toggleVisibility(ctx);
						break;
					}

					default:
						ctx.ui.notify(
							"Usage: /tasks [list|add|complete|start|delete|clear|toggle|team]\n" +
								"  list          - Show all tasks\n" +
								"  add <task>    - Add a new task\n" +
								"  complete <n>  - Mark task n as completed\n" +
								"  start <n>     - Mark task n as in-progress\n" +
								"  delete <n>    - Delete task n\n" +
								"  clear         - Clear all tasks\n" +
								"  toggle        - Show/hide task widget\n" +
								"  team          - Show current team name and path",
							"info"
						);
				}
			},
		});

	// Register Ctrl+Shift+T shortcut for task list (Ctrl+T is built-in)
	if (!isSubagent)
		pi.registerShortcut(Key.ctrlShift("t"), {
			description: "Toggle task list visibility",
			handler: async (ctx) => toggleVisibility(ctx),
		});

	// Tool for agent to manage tasks programmatically
	pi.registerTool({
		name: "manage_tasks",
		label: "manage_tasks",
		description: `Manage the task list - clear all tasks, complete specific tasks, or add new ones.

WHEN TO CREATE TASKS:
- User explicitly asks for a task list or plan
- Multi-step work spanning multiple conversation turns (3+ steps)
- User provides multiple tasks (numbered or comma-separated)
- Non-trivial tasks requiring careful planning or multiple operations
- After receiving new instructions — immediately capture requirements as tasks

WHEN TO SKIP:
- Single, straightforward task completable in 1-2 steps
- Purely conversational or informational requests
- User didn't ask and work is trivial

TASK STATES:
- pending: not yet started
- in_progress: currently being worked on (multiple allowed for parallel agent work)
- completed: finished successfully
- deleted: permanently removed (via update with status "deleted")

IMPORTANT RULES:
- If user explicitly asks for tasks, ALWAYS create them
- If [ACTIVE TASKS] shown in message, continue those tasks
- Complete tasks as you finish them
- Tasks auto-clear 2 seconds after all complete
- Only clear tasks when the plan itself has changed — e.g. the user explicitly abandons the current work, replaces it with a new plan, or the tasks are genuinely obsolete
- A new topic appearing in conversation does NOT mean existing tasks are stale — the user may return to them
- When starting a fundamentally different plan (not just a tangent), clear the old tasks first
- ONLY mark a task completed when FULLY accomplished — not if tests fail, implementation is partial, or errors remain
- When blocked, keep task in_progress and create a new task for the blocker
- Always provide both subject (imperative: "Run tests") and activeForm (continuous: "Running tests")
- Use addComment to leave context for future sessions (why something was done, what was tried)
- Use addBlockedBy/addBlocks to set dependency chains between tasks
- Use get action with index to view full task details including metadata, comments, and timestamps

MULTI-AGENT ORCHESTRATION:
When a request involves multiple steps, infer the task graph automatically:
- Independent steps → parallel tasks. Choose mode based on what's needed next:
  - Parallel foreground (subagent tasks:[...]) when results feed into a later step
  - Background (background:true) when user doesn't need to wait or wants to continue chatting
- Sequential steps ("then", "based on", "after", "using results") → use addBlockedBy
- Single foreground for one-off tasks where the result is needed immediately
- Set tasks to in_progress and assign owner when spawning their agent
- Example: "explore the codebase and review auth, then implement fixes"
  → Task 1: Explore codebase (parallel foreground — results needed for task 3)
  → Task 2: Review auth (parallel foreground — results needed for task 3)
  → Task 3: Implement fixes (do directly using results from 1+2)
- Example: "research competitors while we work on the landing page"
  → Task 1: Research competitors (background — user wants to keep working)
  → Continue working on landing page in the main conversation
- Do NOT require the user to spell out task structure when it's logically clear

EXAMPLES:
- User: "Add dark mode, run tests when done" → Create tasks: 1) Add dark mode toggle component 2) Add dark mode state management 3) Update styles for theme switching 4) Run tests and fix failures
- User: "Research the API and review the schema, then build the endpoint" → 3 tasks, #3 blocked by #1 and #2, spawn 2 parallel agents
- User: "Rename getUserId to getUserIdentifier across the project" → Search first, then create per-file tasks if many occurrences found
- User: "What does git rebase do?" → Do NOT create tasks (informational, no action needed)
- User: "Fix the typo in README.md" → Do NOT create tasks (single trivial step)`,
		parameters: Type.Object({
			action: Type.String({
				description:
					"Action: clear (remove all), complete_all (mark all done), list (show current), add (new task), complete (mark one done), update (modify task), get (view full task details by index), claim (set owner with busy-check)",
			}),
			task: Type.Optional(
				Type.String({
					description: "Task subject/title (for add action)",
				})
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						subject: Type.String({ description: 'Task subject (imperative: "Run tests")' }),
						activeForm: Type.Optional(
							Type.String({ description: 'Present continuous form for spinner ("Running tests")' })
						),
					}),
					{ description: "Multiple tasks to add at once, each with subject and activeForm" }
				)
			),
			description: Type.Optional(
				Type.String({
					description: "Detailed task description (for add or update action)",
				})
			),
			activeForm: Type.Optional(
				Type.String({
					description:
						'Present continuous form shown in spinner when task is in_progress (e.g. "Running tests"). Falls back to subject if not set.',
				})
			),
			metadata: Type.Optional(
				Type.Object(
					{},
					{
						description:
							"Arbitrary key-value metadata to attach to a task (for add or update). Set a key to null to delete it.",
						additionalProperties: true,
					}
				)
			),
			status: Type.Optional(
				Type.String({
					description:
						"New status for update action: pending, in_progress, completed, or deleted (permanently removes the task)",
				})
			),
			index: Type.Optional(
				Type.Number({
					description: "Task number to complete/update/get (1-indexed)",
				})
			),
			indices: Type.Optional(
				Type.Array(Type.Number(), {
					description: "Multiple task numbers to complete at once (1-indexed)",
				})
			),
			owner: Type.Optional(
				Type.String({
					description: "Agent name to set as task owner (for claim/update action)",
				})
			),
			addBlocks: Type.Optional(
				Type.Array(Type.String(), {
					description: "Task IDs that this task blocks (for update action)",
				})
			),
			addBlockedBy: Type.Optional(
				Type.Array(Type.String(), {
					description: "Task IDs that block this task (for update action)",
				})
			),
			addComment: Type.Optional(
				Type.Object({
					author: Type.String({ description: "Comment author (e.g. 'agent', 'user', agent name)" }),
					content: Type.String({ description: "Comment text — context for future sessions" }),
				})
			),
		}),
		async execute(
			_toolCallId: string,
			params: {
				action: string;
				task?: string;
				tasks?: Array<{ subject: string; activeForm?: string }>;
				description?: string;
				activeForm?: string;
				metadata?: Record<string, unknown>;
				status?: string;
				owner?: string;
				index?: number;
				indices?: number[];
				addBlocks?: string[];
				addBlockedBy?: string[];
				addComment?: { author: string; content: string };
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext
		) {
			turnsSinceLastTaskTool = 0;
			switch (params.action) {
				case "clear": {
					const count = state.tasks.length;
					clearTasks();
					updateWidget(ctx);
					persistState();
					return { details: {}, content: [{ type: "text", text: `Cleared ${count} tasks.` }] };
				}
				case "add": {
					// Batch add multiple tasks
					if (params.tasks && params.tasks.length > 0) {
						const pendingTasks = state.tasks.filter((t) => t.status !== "completed");
						const wasEmpty = pendingTasks.length === 0;

						for (const t of params.tasks) {
							addTask(t.subject, { activeForm: t.activeForm });
						}

						// Auto-start first task if list was empty
						if (wasEmpty && state.tasks.length > 0) {
							const firstPending = state.tasks.find((t) => t.status === "pending");
							if (firstPending) updateTaskStatus(firstPending.id, "in_progress");
						}
						updateWidget(ctx);
						persistState();
						return {
							details: {},
							content: [{ type: "text", text: `Added ${params.tasks.length} tasks` }],
						};
					}
					// Single task add
					if (!params.task) {
						return { details: {}, content: [{ type: "text", text: "Missing task subject" }] };
					}
					const newTask = addTask(params.task, {
						description: params.description,
						activeForm: params.activeForm,
						metadata: params.metadata,
					});
					// Auto-start if first task
					if (state.tasks.length === 1) {
						updateTaskStatus(newTask.id, "in_progress");
					}
					updateWidget(ctx);
					persistState();
					return {
						details: {},
						content: [{ type: "text", text: `Added #${newTask.id}: ${params.task}` }],
					};
				}
				case "update": {
					if (params.indices) {
						return {
							details: {},
							content: [
								{
									type: "text",
									text: "The update action operates on a single task. Use 'index' (singular), not 'indices'. To update multiple tasks, call update once per task.",
								},
							],
						};
					}
					if (params.index === undefined) {
						return {
							details: {},
							content: [
								{
									type: "text",
									text: "Missing required 'index' parameter for update action.",
								},
							],
						};
					}
					const updateIdx = params.index - 1;
					if (updateIdx < 0 || updateIdx >= state.tasks.length) {
						const reason =
							state.tasks.length === 0
								? "No tasks exist (list may have been auto-cleared). Re-add tasks if needed."
								: `Task index ${params.index} out of range (${state.tasks.length} tasks exist).`;
						return { details: {}, content: [{ type: "text", text: reason }] };
					}
					const taskToUpdate = state.tasks[updateIdx];

					// Handle deleted status — permanently removes the task
					if (params.status === "deleted") {
						const subject = taskToUpdate.subject;
						deleteTask(taskToUpdate.id);
						updateWidget(ctx);
						persistState();
						return {
							details: {},
							content: [{ type: "text", text: `Deleted #${taskToUpdate.id}: ${subject}` }],
						};
					}

					const changes: string[] = [];

					if (params.status !== undefined) {
						const validStatuses = ["pending", "in_progress", "completed"];
						if (validStatuses.includes(params.status)) {
							updateTaskStatus(taskToUpdate.id, params.status as TaskStatus);
							changes.push(`status → ${params.status}`);
						}
					}
					if (params.description !== undefined) {
						taskToUpdate.description = params.description;
						changes.push("description");
					}
					if (params.activeForm !== undefined) {
						taskToUpdate.activeForm = params.activeForm;
						changes.push("activeForm");
					}
					if (params.owner !== undefined) {
						taskToUpdate.owner = params.owner;
						changes.push(`owner → ${params.owner}`);
					}
					if (params.metadata !== undefined) {
						const merged = { ...taskToUpdate.metadata };
						for (const [k, v] of Object.entries(params.metadata)) {
							if (v === null) delete merged[k];
							else merged[k] = v;
						}
						taskToUpdate.metadata = Object.keys(merged).length > 0 ? merged : undefined;
						changes.push("metadata");
					}
					if (params.addBlocks || params.addBlockedBy) {
						updateTaskDeps(taskToUpdate.id, params.addBlocks, params.addBlockedBy);
						changes.push("dependencies");
					}
					if (params.addComment) {
						addComment(taskToUpdate.id, params.addComment.author, params.addComment.content);
						changes.push("comment");
					}

					persistTask(taskToUpdate);
					updateWidget(ctx);
					persistState();

					// Only warn if task has an explicit owner whose agent isn't running.
					// No owner = main agent is working on it — no warning needed.
					let agentWarning = "";
					if (taskToUpdate.status === "in_progress" && taskToUpdate.owner) {
						const runningNames = new Set<string>();
						for (const subagent of foregroundSubagents) {
							if (subagent.status === "running") runningNames.add(subagent.agent);
						}
						for (const subagent of backgroundSubagents) {
							if (subagent.status === "running") runningNames.add(subagent.agent);
						}
						if (!runningNames.has(taskToUpdate.owner)) {
							agentWarning = `\n⚠️ Task is in_progress with owner "${taskToUpdate.owner}" but that agent is not running.`;
						}
					}

					return {
						details: {},
						content: [
							{
								type: "text",
								text: `Updated #${taskToUpdate.id}: ${changes.join(", ")}${agentWarning}`,
							},
						],
					};
				}
				case "complete": {
					// Support completing multiple tasks at once
					if (params.indices && params.indices.length > 0) {
						const completed: string[] = [];
						const skipped: string[] = [];
						const invalidIndices: number[] = [];
						const uniqueIndices = [...new Set(params.indices)];

						for (const i of uniqueIndices) {
							const idx = i - 1;
							if (idx < 0 || idx >= state.tasks.length) {
								invalidIndices.push(i);
								continue;
							}

							const task = state.tasks[idx];
							if (task.status === "completed") {
								skipped.push(`#${task.id} already completed`);
								continue;
							}

							if (!updateTaskStatus(task.id, "completed")) {
								const unmet = getUnmetDependencyIds(task);
								skipped.push(
									unmet.length > 0
										? `#${task.id} blocked by ${unmet.join(", ")}`
										: `#${task.id} could not be completed`
								);
								continue;
							}

							completed.push(`#${task.id} ${task.subject}`);
						}

						autoStartNextPendingTask();
						updateWidget(ctx);
						persistState();

						if (state.tasks.every((t) => t.status === "completed")) {
							setTimeout(() => {
								clearTasks();
								updateWidget(ctx);
								persistState();
							}, 2000);
						}

						if (completed.length === 0) {
							const reasons: string[] = [];
							if (invalidIndices.length > 0) {
								reasons.push(
									`Invalid indices: ${invalidIndices.join(", ")} (valid range 1-${state.tasks.length})`
								);
							}
							if (skipped.length > 0) reasons.push(`Skipped: ${skipped.join("; ")}`);
							return {
								details: {},
								content: [{ type: "text", text: `No tasks completed. ${reasons.join(". ")}` }],
							};
						}

						const details: string[] = [
							`Completed ${completed.length} task(s): ${completed.join(", ")}`,
						];
						if (invalidIndices.length > 0) {
							details.push(
								`Invalid indices ignored: ${invalidIndices.join(", ")} (valid range 1-${state.tasks.length})`
							);
						}
						if (skipped.length > 0) details.push(`Skipped: ${skipped.join("; ")}`);

						return {
							details: {},
							content: [{ type: "text", text: details.join("\n") }],
						};
					}

					// Single task completion
					if (params.index === undefined) {
						return {
							details: {},
							content: [
								{
									type: "text",
									text: "Missing required 'index' parameter for complete action (or use 'indices' for batch completion).",
								},
							],
						};
					}
					const idx = params.index - 1;
					if (idx < 0 || idx >= state.tasks.length) {
						const reason =
							state.tasks.length === 0
								? "No tasks exist (list may have been auto-cleared). Re-add tasks if needed."
								: `Task index ${params.index} out of range (${state.tasks.length} tasks exist).`;
						return { details: {}, content: [{ type: "text", text: reason }] };
					}
					const taskToComplete = state.tasks[idx];
					if (taskToComplete.status === "completed") {
						return {
							details: {},
							content: [{ type: "text", text: `Task #${taskToComplete.id} is already completed.` }],
						};
					}
					// Add completion comment if provided
					if (params.addComment) {
						addComment(taskToComplete.id, params.addComment.author, params.addComment.content);
					}
					if (!updateTaskStatus(taskToComplete.id, "completed")) {
						const unmet = getUnmetDependencyIds(taskToComplete);
						const reason =
							unmet.length > 0
								? `Cannot complete #${taskToComplete.id}: blocked by tasks ${unmet.join(", ")}`
								: `Cannot complete #${taskToComplete.id}: update rejected`;
						return { details: {}, content: [{ type: "text", text: reason }] };
					}

					autoStartNextPendingTask();
					updateWidget(ctx);
					persistState();
					// Auto-clear if all done
					if (state.tasks.every((t) => t.status === "completed")) {
						setTimeout(() => {
							clearTasks();
							updateWidget(ctx);
							persistState();
						}, 2000);
					}
					return {
						details: {},
						content: [
							{ type: "text", text: `Completed: #${taskToComplete.id} ${taskToComplete.subject}` },
						],
					};
				}
				case "complete_all": {
					for (const task of state.tasks) {
						task.status = "completed";
						task.completedAt = Date.now();
						persistTask(task);
					}
					state.activeTaskId = null;
					updateWidget(ctx);
					persistState();
					setTimeout(() => {
						clearTasks();
						updateWidget(ctx);
						persistState();
					}, 1000);
					return {
						details: {},
						content: [
							{
								type: "text",
								text: `Marked ${state.tasks.length} tasks complete. Will auto-clear.`,
							},
						],
					};
				}
				case "list": {
					if (state.tasks.length === 0) {
						return { details: {}, content: [{ type: "text", text: "No tasks." }] };
					}
					const list = state.tasks
						.map((t, idx) => {
							const blocked =
								t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(",")}]` : "";
							const comments = t.comments.length > 0 ? ` (${t.comments.length} comments)` : "";
							return `${idx + 1}. [${t.status}] ${t.subject} (id:${t.id})${blocked}${comments}`;
						})
						.join("\n");
					return { details: {}, content: [{ type: "text", text: list }] };
				}
				case "get": {
					if (params.index === undefined) {
						return {
							details: {},
							content: [
								{
									type: "text",
									text: "Missing required 'index' parameter for get action.",
								},
							],
						};
					}
					const getIdx = params.index - 1;
					if (getIdx < 0 || getIdx >= state.tasks.length) {
						const reason =
							state.tasks.length === 0
								? "No tasks exist (list may have been auto-cleared)."
								: `Task index ${params.index} out of range (${state.tasks.length} tasks exist).`;
						return { details: {}, content: [{ type: "text", text: reason }] };
					}
					const t = state.tasks[getIdx];
					const lines = [`# Task #${t.id}: ${t.subject}`, `Status: ${t.status}`];
					if (t.activeForm) lines.push(`Active form: ${t.activeForm}`);
					if (t.description) lines.push(`Description: ${t.description}`);
					if (t.owner) lines.push(`Owner: ${t.owner}`);
					if (t.blocks.length > 0) lines.push(`Blocks: ${t.blocks.join(", ")}`);
					if (t.blockedBy.length > 0) lines.push(`Blocked by: ${t.blockedBy.join(", ")}`);
					if (t.metadata && Object.keys(t.metadata).length > 0) {
						lines.push(`Metadata: ${JSON.stringify(t.metadata)}`);
					}
					lines.push(`Created: ${new Date(t.createdAt).toISOString()}`);
					if (t.completedAt) lines.push(`Completed: ${new Date(t.completedAt).toISOString()}`);
					if (t.comments.length > 0) {
						lines.push(`\nComments (${t.comments.length}):`);
						for (const c of t.comments) {
							lines.push(`  [${new Date(c.timestamp).toISOString()}] ${c.author}: ${c.content}`);
						}
					}
					return { details: {}, content: [{ type: "text", text: lines.join("\n") }] };
				}
				case "claim": {
					if (!params.owner) {
						return {
							details: {},
							content: [{ type: "text", text: "Missing owner for claim action" }],
						};
					}
					if (params.index === undefined) {
						return {
							details: {},
							content: [
								{
									type: "text",
									text: "Missing required 'index' parameter for claim action.",
								},
							],
						};
					}
					const claimIdx = params.index - 1;
					if (claimIdx < 0 || claimIdx >= state.tasks.length) {
						const reason =
							state.tasks.length === 0
								? "No tasks exist (list may have been auto-cleared)."
								: `Task index ${params.index} out of range (${state.tasks.length} tasks exist).`;
						return { details: {}, content: [{ type: "text", text: reason }] };
					}
					const taskToClaim = state.tasks[claimIdx];

					// Can't claim completed/deleted tasks
					if (taskToClaim.status === "completed" || taskToClaim.status === "deleted") {
						return {
							details: {},
							content: [
								{
									type: "text",
									text: `Cannot claim #${taskToClaim.id}: already ${taskToClaim.status}`,
								},
							],
						};
					}

					// Already claimed by someone else
					if (taskToClaim.owner && taskToClaim.owner !== params.owner) {
						return {
							details: {},
							content: [
								{
									type: "text",
									text: `Cannot claim #${taskToClaim.id}: already owned by ${taskToClaim.owner}`,
								},
							],
						};
					}

					// Busy-check: agent can't claim if they already own an in_progress task
					const busyTask = state.tasks.find(
						(t) => t.owner === params.owner && t.status === "in_progress" && t.id !== taskToClaim.id
					);
					if (busyTask) {
						return {
							details: {},
							content: [
								{
									type: "text",
									text: `Cannot claim #${taskToClaim.id}: ${params.owner} is busy with #${busyTask.id} (${busyTask.subject})`,
								},
							],
						};
					}

					// Check blockedBy deps
					const unmetDeps = taskToClaim.blockedBy.filter((depId) => {
						const dep = state.tasks.find((t) => t.id === depId);
						return dep && dep.status !== "completed";
					});
					if (unmetDeps.length > 0) {
						return {
							details: {},
							content: [
								{
									type: "text",
									text: `Cannot claim #${taskToClaim.id}: blocked by tasks ${unmetDeps.join(", ")}`,
								},
							],
						};
					}

					// Claim successful — set owner and move to in_progress
					taskToClaim.owner = params.owner;
					updateTaskStatus(taskToClaim.id, "in_progress");
					persistTask(taskToClaim);
					updateWidget(ctx);
					persistState();
					return {
						details: {},
						content: [
							{
								type: "text",
								text: `Claimed #${taskToClaim.id}: ${taskToClaim.subject} (owner: ${params.owner})`,
							},
						],
					};
				}
				default:
					return {
						details: {},
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
					};
			}
		},
	});

	// Auto-extract tasks from assistant messages
	pi.on("turn_end", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;

		turnsSinceLastTaskTool++;
		const text = getTextContent(event.message);

		// Check for completed tasks
		if (state.tasks.length > 0) {
			const completedIds = findCompletedTasks(text, state.tasks);
			const successfullyCompletedIds: string[] = [];
			for (const id of completedIds) {
				if (updateTaskStatus(id, "completed")) {
					successfullyCompletedIds.push(id);
				}
			}

			// Auto-advance only when active task actually completed.
			if (state.activeTaskId && successfullyCompletedIds.includes(state.activeTaskId)) {
				autoStartNextPendingTask();
				if (!state.tasks.some((t) => t.status === "in_progress")) {
					state.activeTaskId = null;
				}
			}

			// Auto-clear: if all tasks completed, clear the list after a brief delay
			const allCompleted =
				state.tasks.length > 0 && state.tasks.every((t) => t.status === "completed");
			if (allCompleted) {
				// Clear after showing completion briefly
				setTimeout(() => {
					if (state.tasks.every((t) => t.status === "completed")) {
						state.tasks = [];
						state.activeTaskId = null;
						updateWidget(ctx);
						persistState();
					}
				}, 2000); // 2 second delay to show completion
			}
		}

		// Auto-clear stale tasks when conversation drifts to a new topic:
		// if the LLM hasn't touched manage_tasks in STALE_TURN_THRESHOLD turns,
		// no subagents are running, AND tasks are old enough to be considered
		// abandoned. Cancel/abort is handled by the agent_end handler above.
		if (state.tasks.length > 0 && turnsSinceLastTaskTool >= STALE_TURN_THRESHOLD) {
			const hasRunningAgents =
				foregroundSubagents.some((subagent) => subagent.status === "running") ||
				backgroundSubagents.some((subagent) => subagent.status === "running");

			if (!hasRunningAgents) {
				const hasActiveTasks = state.tasks.some(
					(t) => t.status === "pending" || t.status === "in_progress"
				);
				// Don't clear tasks created less than 5 minutes ago — they may just
				// be waiting on long-running operations (subagents, builds, etc.)
				const MINIMUM_AGE_MS = 5 * 60 * 1000;
				const newestTaskAge = Date.now() - Math.max(...state.tasks.map((t) => t.createdAt));
				const tasksAreOldEnough = newestTaskAge >= MINIMUM_AGE_MS;

				if (hasActiveTasks && tasksAreOldEnough) {
					clearTasks();
					if (!isSubagent) {
						ctx.ui.notify("Auto-cleared stale task list (conversation moved on)", "info");
					}
				}
			}
		}

		updateWidget(ctx);
		persistState();
	});

	// Inject task context before agent starts
	pi.on("before_agent_start", async () => {
		if (state.tasks.length === 0) return;

		const pending = state.tasks.filter((t) => t.status !== "completed" && t.status !== "deleted");
		if (pending.length === 0) return;

		const taskList = pending
			.map((t, idx) => {
				const status = t.status === "in_progress" ? " [IN PROGRESS]" : "";
				const blocked = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(", ")}]` : "";
				const desc = t.description ? `\n   ${t.description}` : "";
				const lastComment =
					t.comments.length > 0 ? `\n   ${getIcon("comment")} ${t.comments.at(-1)?.content}` : "";
				return `${idx + 1}. ${t.subject} (id:${t.id})${status}${blocked}${desc}${lastComment}`;
			})
			.join("\n");

		const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
		const focusText = activeTask ? `\nCurrent focus: ${activeTask.subject}` : "";

		return {
			message: {
				customType: "tasks-context",
				content: `[ACTIVE TASKS]
${taskList}
${focusText}

Complete a task the moment its work succeeds — call manage_tasks complete BEFORE responding to anything else. Never answer a new question while finished tasks remain in_progress.
Before calling manage_tasks complete/update, call manage_tasks list first so indices are current.`,
				display: false,
			},
		};
	});

	// Clear stale tasks when agent is interrupted mid-execution.
	// If any task is still in_progress at agent_end, the agent was cancelled —
	// in normal flow, tasks are either all completed (auto-clear handles it)
	// or all pending (agent asked a question). Orphaned in_progress = clear.
	pi.on("agent_end", async (_event, ctx) => {
		if (!shouldClearOnAgentEnd(state.tasks)) return;

		clearTasks();
		updateWidget(ctx);
		persistState();
	});

	let lastBgCount = 0;
	let lastBgTaskCount = 0;

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		foregroundSubagents = [];
		backgroundSubagents = [];
		backgroundTasks = [];
		activeTeams = [];
		teamDashboardActive = false;
		lastBgCount = 0;
		lastBgTaskCount = 0;

		// Restore meta state (visibility, nextId) from session entries
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "tasks-state"
			)
			.pop() as
			| { data?: Omit<Partial<TasksState>, "tasks"> & { tasks?: Record<string, unknown>[] } }
			| undefined;

		if (stateEntry?.data) {
			state.visible = stateEntry.data.visible ?? true;
			state.nextId = stateEntry.data.nextId ?? 1;
			state.activeTaskId = stateEntry.data.activeTaskId ?? null;
		}

		// Load tasks: prefer file store (shared mode), fall back to session entries
		if (store.isShared) {
			loadFromStore();

			// Start watching for cross-session changes
			store.watch(() => {
				loadFromStore();
				updateWidget(ctx);
			});
		} else if (stateEntry?.data?.tasks) {
			// Session-only mode: restore from entries, migrating old schema
			state.tasks = stateEntry.data.tasks.map((t) => ({
				id: (t.id as string) ?? String(state.nextId++),
				subject: (t.subject as string) ?? (t.title as string) ?? "Untitled",
				description: t.description as string | undefined,
				activeForm: t.activeForm as string | undefined,
				status: (t.status as TaskStatus) ?? "pending",
				blocks: (t.blocks as string[]) ?? [],
				blockedBy: (t.blockedBy as string[]) ?? (t.dependencies as string[]) ?? [],
				comments: (t.comments as TaskComment[]) ?? [],
				owner: t.owner as string | undefined,
				metadata: t.metadata as Record<string, unknown> | undefined,
				createdAt: (t.createdAt as number) ?? Date.now(),
				completedAt: t.completedAt as number | undefined,
			}));
			// Recalculate nextId
			const maxId = state.tasks.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0);
			state.nextId = Math.max(state.nextId, maxId + 1);
		}

		// Clear orphaned tasks on startup: at session_start no agents are running,
		// so any in_progress tasks are leftovers from a dead session.
		// Also clear if all tasks are already completed — the 2s auto-clear timer
		// from a previous turn may have been killed by an extension reload.
		if (state.tasks.length > 0) {
			const orphaned = state.tasks.filter((t) => t.status === "in_progress");
			const allCompleted = state.tasks.every((t) => t.status === "completed");
			if (orphaned.length > 0 || allCompleted) {
				clearTasks();
			}
		}

		// Clean up team directories older than 7 days
		cleanupStaleTeams(teamName);

		if (!isSubagent) {
			interopEventsCleanup?.();
			const unsubSubagents = onInteropEvent(
				pi.events,
				INTEROP_EVENT_NAMES.subagentsSnapshot,
				(payload) => {
					backgroundSubagents = payload.background;
					foregroundSubagents = payload.foreground;
					updateWidget(ctx);
					updateAgentBar(ctx);
				}
			);
			const unsubBackgroundTasks = onInteropEvent(
				pi.events,
				INTEROP_EVENT_NAMES.backgroundTasksSnapshot,
				(payload) => {
					backgroundTasks = payload.tasks;
					updateWidget(ctx);
					updateAgentBar(ctx);
				}
			);
			const unsubTeams = onInteropEvent(pi.events, INTEROP_EVENT_NAMES.teamsSnapshot, (payload) => {
				activeTeams = payload.teams;
				updateWidget(ctx);
				updateAgentBar(ctx);
			});
			const unsubDashboardState = onInteropEvent(
				pi.events,
				INTEROP_EVENT_NAMES.teamDashboardState,
				(payload) => {
					teamDashboardActive = payload.active;
					updateWidget(ctx);
				}
			);
			interopEventsCleanup = () => {
				unsubSubagents();
				unsubBackgroundTasks();
				unsubTeams();
				unsubDashboardState();
			};

			legacyInteropBridgeCleanup?.();
			legacyInteropBridgeCleanup = startLegacyInteropBridge(pi.events);
			requestInteropState(pi.events, "tasks");

			if (tasksAnimationInterval) clearInterval(tasksAnimationInterval);
			tasksAnimationInterval = setInterval(() => {
				const fgRunning = foregroundSubagents.filter(
					(subagent) => subagent.status === "running"
				).length;
				const bgRunning = backgroundSubagents.filter(
					(subagent) => subagent.status === "running"
				).length;
				const bgTaskRunning = backgroundTasks.filter((task) => task.status === "running").length;
				const hasActiveTask = state.tasks.some((task) => task.status === "in_progress");
				const hasWorkingTeammates = activeTeams.some((team) =>
					team.teammates.some((teammate) => teammate.status === "working")
				);
				const hasRunning =
					fgRunning > 0 ||
					bgRunning > 0 ||
					bgTaskRunning > 0 ||
					hasActiveTask ||
					hasWorkingTeammates;

				if (hasRunning || bgRunning !== lastBgCount || bgTaskRunning !== lastBgTaskCount) {
					spinnerFrame++;
					lastBgCount = bgRunning;
					lastBgTaskCount = bgTaskRunning;
					updateWidget(ctx);
					updateAgentBar(ctx);
				}
			}, 200);

			subagentEventsCleanup?.();
			const onSubagentStart = (raw: unknown) => {
				const data = raw as Record<string, unknown>;
				const agentId = String(data.agent_id ?? "");
				const agentType = String(data.agent_type ?? "");
				const task = String(data.task ?? "");
				if (agentId && task) {
					agentIdentities.set(agentId, classifyAgent(task, agentType));
					refineAgentIdentityAsync(
						agentId,
						task,
						() => ctx.modelRegistry.getApiKeyForProvider("anthropic"),
						agentIdentities
					);
				}
				updateAgentBar(ctx);
			};

			const onSubagentToolCall = (raw: unknown) => {
				const data = raw as Record<string, unknown>;
				const agentId = String(data.agent_id ?? "");
				const toolName = String(data.tool_name ?? "");
				const toolInput = (data.tool_input ?? {}) as Record<string, unknown>;
				if (agentId) {
					agentActivity.set(agentId, {
						toolName,
						summary: summarizeToolCall(toolName, toolInput),
						timestamp: Date.now(),
					});
				}
			};

			const onSubagentToolResult = (raw: unknown) => {
				const data = raw as Record<string, unknown>;
				const agentId = String(data.agent_id ?? "");
				if (agentId) {
					agentActivity.set(agentId, {
						toolName: "",
						summary: "Thinking...",
						timestamp: Date.now(),
					});
				}
			};

			const onSubagentStop = (raw: unknown) => {
				const data = raw as Record<string, unknown>;
				const agentId = String(data.agent_id ?? "");
				if (agentId) {
					agentActivity.delete(agentId);
					agentIdentities.delete(agentId);
				}
				updateAgentBar(ctx);
			};

			const unsub1 = pi.events.on("subagent_start", onSubagentStart);
			const unsub2 = pi.events.on("subagent_tool_call", onSubagentToolCall);
			const unsub3 = pi.events.on("subagent_tool_result", onSubagentToolResult);
			const unsub4 = pi.events.on("subagent_stop", onSubagentStop);
			subagentEventsCleanup = () => {
				unsub1();
				unsub2();
				unsub3();
				unsub4();
			};
		}

		updateWidget(ctx);
		updateAgentBar(ctx);
	});

	// Cleanup on session end
	pi.on("session_shutdown", async () => {
		if (tasksAnimationInterval) {
			clearInterval(tasksAnimationInterval);
			tasksAnimationInterval = undefined;
		}
		interopEventsCleanup?.();
		interopEventsCleanup = undefined;
		subagentEventsCleanup?.();
		subagentEventsCleanup = undefined;
		legacyInteropBridgeCleanup?.();
		legacyInteropBridgeCleanup = undefined;
		store.close();
		persistState();
	});
}
