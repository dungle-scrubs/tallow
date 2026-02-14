/**
 * Teams Extension — Multi-agent coordination with shared state
 *
 * Spawns persistent teammate sessions (via SDK createAgentSession) that share
 * an in-memory task board and can message each other directly — no hub-and-spoke
 * bottleneck. Teammates auto-wake on incoming messages.
 *
 * Main-agent tools: team_create, team_add_tasks, team_spawn, team_send, team_status, team_shutdown, team_resume
 * Teammate tools (injected): team_tasks, team_message, team_inbox
 *
 * Pure logic (store, tasks, messages) lives in store.ts for testability.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@mariozechner/pi-ai";
import { getModels, getProviders, StringEnum } from "@mariozechner/pi-ai";
import type {
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionContext,
	ResourceLoader,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	createBashTool,
	createCodingTools,
	createEditTool,
	createExtensionRuntime,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { Key, Loader, Text, type TUI } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import {
	resolveDashboardCommand,
	TeamDashboardActivityStore,
	TeamDashboardEditor,
	type TeamDashboardFeedItem,
	type TeamDashboardSnapshot,
	type TeamDashboardTeam,
	type TeamDashboardTeammate,
} from "./dashboard.js";
import {
	addTaskToBoard,
	addTeamMessage,
	archiveTeam,
	createTeamStore,
	formatArchivedTeamStatus,
	formatTeamStatus,
	getArchivedTeams,
	getReadyTasks,
	getTeam,
	getTeammatesByStatus,
	getTeams,
	getUnread,
	isTaskReady,
	markRead,
	restoreArchivedTeam,
	type Team,
	type TeamTask,
} from "./store.js";

// Re-export store types and functions so existing imports still work
export {
	type ArchivedTeam,
	addTaskToBoard,
	addTeamMessage,
	archiveTeam,
	createTeamStore,
	formatArchivedTeamStatus,
	formatTeamStatus,
	getArchivedTeams,
	getReadyTasks,
	getTeam,
	getTeammatesByStatus,
	getTeams,
	getUnread,
	isTaskReady,
	markRead,
	restoreArchivedTeam,
	type Team,
	type TeamMessage,
	type TeamTask,
} from "./store.js";

// ════════════════════════════════════════════════════════════════
// Types (extension-layer, depends on AgentSession)
// ════════════════════════════════════════════════════════════════

export interface Teammate {
	name: string;
	role: string;
	model: string;
	session: AgentSession;
	status: "idle" | "working" | "shutdown" | "error";
	error?: string;
	lastActivity?: string;
	unsubscribe?: () => void;
}

// ════════════════════════════════════════════════════════════════
// Global team view (read by tasks extension for widget rendering)
// ════════════════════════════════════════════════════════════════

/** Serializable view of a team for cross-extension widget rendering. */
export interface TeamView {
	name: string;
	tasks: Array<{
		id: string;
		title: string;
		status: string;
		assignee: string | null;
		blockedBy: string[];
	}>;
	teammates: Array<{
		completedTaskCount: number;
		currentTask?: string;
		model: string;
		name: string;
		role: string;
		status: string;
	}>;
}

/**
 * Build a serializable snapshot of a team for widget rendering.
 * @param team - Runtime team with full Teammate objects
 * @returns Lightweight view safe for cross-extension consumption
 */
export function buildTeamView(team: Team<Teammate>): TeamView {
	return {
		name: team.name,
		tasks: team.tasks.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			assignee: t.assignee,
			blockedBy: t.blockedBy,
		})),
		teammates: Array.from(team.teammates.values()).map((m) => ({
			completedTaskCount: getTaskCountByAssigneeStatus(team, m.name, "completed"),
			currentTask: getCurrentTaskTitle(team, m.name) ?? undefined,
			model: m.model,
			name: m.name,
			role: m.role,
			status: m.status,
		})),
	};
}

/** Global map of active team views, read by tasks extension. */
const activeTeamViews = new Map<string, TeamView>();
/** Rolling activity store for dashboard card data. */
const dashboardActivity = new TeamDashboardActivityStore();
/** Rolling event feed displayed in the dashboard sidebar, keyed by team name. */
const dashboardFeedByTeam = new Map<string, TeamDashboardFeedItem[]>();
/** Maximum message events retained in the dashboard feed. */
const DASHBOARD_FEED_MAX_ITEMS = 32;
/** Maximum visible chars per feed event message summary. */
const DASHBOARD_FEED_SUMMARY_CHARS = 96;
/** Feed messages that are too noisy to render in the sidebar activity stream. */
const DASHBOARD_FEED_SUPPRESSED_PATTERNS = [/^Running tool:/i, /^Completed response\.?$/i] as const;
(globalThis as Record<string, unknown>).__piActiveTeams = activeTeamViews;
(globalThis as Record<string, unknown>).__piTeamDashboardActive = false;

/**
 * Refresh the global team view snapshot for a given team.
 * Called after any state mutation (task claimed/completed, teammate status change).
 * @param team - Runtime team to snapshot
 */
function refreshTeamView(team: Team<Teammate>): void {
	const hasActive =
		team.tasks.some((t) => t.status !== "completed" && t.status !== "failed") ||
		Array.from(team.teammates.values()).some((m) => m.status === "working");
	if (hasActive) {
		activeTeamViews.set(team.name, buildTeamView(team));
	} else {
		// All done — keep a final snapshot for a brief display, then remove
		activeTeamViews.set(team.name, buildTeamView(team));
	}
	notifyTeamViewChanged();
	notifyDashboardChanged();
}

/**
 * Remove a team from the global view (on shutdown).
 * Notifies the tasks extension to refresh widget and agent bar.
 * @param teamName - Team name to remove
 */
function removeTeamView(teamName: string): void {
	activeTeamViews.delete(teamName);
	dashboardActivity.clearTeam(teamName);
	clearDashboardFeedEvents(teamName);
	notifyTeamViewChanged();
	notifyDashboardChanged();
}

/**
 * Notify the tasks extension that team view state has changed.
 * Calls the global callback registered by the tasks extension (if any).
 */
function notifyTeamViewChanged(): void {
	const callback = (globalThis as Record<string, unknown>).__piOnTeamViewChange;
	if (typeof callback === "function") callback();
}

/**
 * Notify the team dashboard editor that render data changed.
 */
function notifyDashboardChanged(): void {
	const callback = (globalThis as Record<string, unknown>).__piOnTeamDashboardChange;
	if (typeof callback === "function") callback();
}

/**
 * Check whether a feed message is low-signal dashboard noise.
 * @param content - Candidate feed event text
 * @returns True when the event should be suppressed
 */
function shouldSuppressDashboardFeedEvent(content: string): boolean {
	const normalized = content.trim();
	if (normalized.length === 0) return true;
	return DASHBOARD_FEED_SUPPRESSED_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Append an event line to a team's dashboard feed.
 * @param teamName - Team that owns the feed stream
 * @param from - Event actor label
 * @param to - Event target label
 * @param content - Event text payload
 * @returns void
 */
function appendDashboardFeedEvent(
	teamName: string,
	from: string,
	to: string,
	content: string
): void {
	if (shouldSuppressDashboardFeedEvent(content)) return;
	const event: TeamDashboardFeedItem = {
		content: summarizeFeedMessage(content),
		from,
		timestamp: Date.now(),
		to,
	};
	const current = dashboardFeedByTeam.get(teamName) ?? [];
	const next = [...current, event];
	if (next.length > DASHBOARD_FEED_MAX_ITEMS) {
		next.splice(0, next.length - DASHBOARD_FEED_MAX_ITEMS);
	}
	dashboardFeedByTeam.set(teamName, next);
	notifyDashboardChanged();
}

/**
 * Read the current dashboard feed event stream for a team.
 * @param teamName - Team that owns the feed stream
 * @returns Feed events in chronological order
 */
function getDashboardFeedEvents(teamName: string): TeamDashboardFeedItem[] {
	const feed = dashboardFeedByTeam.get(teamName) ?? [];
	return [...feed];
}

/**
 * Remove all dashboard feed events for a team.
 * @param teamName - Team that owns the feed stream
 * @returns void
 */
function clearDashboardFeedEvents(teamName: string): void {
	dashboardFeedByTeam.delete(teamName);
}

// ════════════════════════════════════════════════════════════════
// Model resolution
// ════════════════════════════════════════════════════════════════

/**
 * Resolve a model name to a Model object by searching all providers.
 * @param modelName - Model ID (e.g. "claude-sonnet-4-5")
 * @returns The Model, or undefined if not found
 */
export function findModel(modelName: string) {
	for (const provider of getProviders()) {
		const models = getModels(provider);
		const match = models.find((m) => m.id === modelName);
		if (match) return match;
	}
	return undefined;
}

// ════════════════════════════════════════════════════════════════
// Runtime team accessor (store returns TeammateRecord, runtime uses Teammate)
// ════════════════════════════════════════════════════════════════

/** Type-safe accessor: at runtime, teammates always have a session. */
function getRuntimeTeam(name: string): Team<Teammate> | undefined {
	return getTeam(name) as Team<Teammate> | undefined;
}

/**
 * Count tasks assigned to one teammate in a target lifecycle status.
 * @param team - Team containing task board
 * @param teammateName - Teammate name
 * @param status - Task status to count
 * @returns Number of matching tasks
 */
function getTaskCountByAssigneeStatus(
	team: Team<Teammate>,
	teammateName: string,
	status: TeamTask["status"]
): number {
	return team.tasks.filter((task) => task.assignee === teammateName && task.status === status)
		.length;
}

/**
 * Read the currently claimed task title for a teammate.
 * @param team - Team containing task board
 * @param teammateName - Teammate name
 * @returns Current claimed task title, or null
 */
function getCurrentTaskTitle(team: Team<Teammate>, teammateName: string): string | null {
	return (
		team.tasks.find((task) => task.assignee === teammateName && task.status === "claimed")?.title ??
		null
	);
}

/**
 * Count unread inbox messages for a teammate.
 * @param team - Team containing message log
 * @param teammateName - Teammate name
 * @returns Number of unread messages addressed to teammate or broadcast
 */
function getUnreadInboxCount(team: Team<Teammate>, teammateName: string): number {
	return team.messages.filter(
		(message) =>
			(message.to === teammateName || message.to === "all") && !message.readBy.has(teammateName)
	).length;
}

/**
 * Build recent direct/broadcast chat links for left-sidebar visualization.
 * @param team - Team containing message log
 * @returns Up to three most recent distinct message links
 */
function getRecentMessageLinks(team: Team<Teammate>): string[] {
	const links = team.messages
		.slice()
		.reverse()
		.map((message) => {
			const target = message.to === "all" ? "all" : `@${message.to}`;
			return `${message.from}→${target}`;
		});
	const unique: string[] = [];
	for (const link of links) {
		if (unique.includes(link)) continue;
		unique.push(link);
		if (unique.length >= 3) break;
	}
	return unique;
}

/**
 * Summarize a message into a single feed-friendly line.
 * @param content - Raw message content
 * @returns Trimmed one-line summary with markdown noise removed
 */
function summarizeFeedMessage(content: string): string {
	const firstLine =
		content
			.replace(/\r/g, "")
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	const normalized = firstLine
		.replace(/^[-*]\s+/, "")
		.replace(/[`*_#>]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length === 0) return "(empty message)";
	if (normalized.length <= DASHBOARD_FEED_SUMMARY_CHARS) return normalized;
	return `${normalized.slice(0, DASHBOARD_FEED_SUMMARY_CHARS - 1)}…`;
}

/**
 * Build a compact message feed for sidebar rendering.
 * @param team - Team containing message log
 * @returns Recent feed entries in chronological order
 */
function getRecentFeed(team: Team<Teammate>): TeamDashboardFeedItem[] {
	const feedEvents = getDashboardFeedEvents(team.name);
	if (feedEvents.length > 0) return feedEvents;
	return team.messages.slice(-DASHBOARD_FEED_MAX_ITEMS).map((message) => ({
		content: summarizeFeedMessage(message.content),
		from: message.from,
		timestamp: message.timestamp,
		to: message.to,
	}));
}

/**
 * Build the dashboard snapshot from live teams + cached activity buffers.
 * @returns Render-ready dashboard snapshot
 */
function buildDashboardSnapshot(): TeamDashboardSnapshot {
	const teams = Array.from(getTeams().values())
		.map((rawTeam) => rawTeam as Team<Teammate>)
		.map(
			(team): TeamDashboardTeam => ({
				feed: getRecentFeed(team),
				isComplete:
					team.tasks.length > 0 && team.tasks.every((task) => task.status === "completed"),
				name: team.name,
				recentMessageLinks: getRecentMessageLinks(team),
				teammates: Array.from(team.teammates.values())
					.map((mate): TeamDashboardTeammate => {
						const activity = dashboardActivity.get(team.name, mate.name);
						return {
							completedTaskCount: getTaskCountByAssigneeStatus(team, mate.name, "completed"),
							currentTask: getCurrentTaskTitle(team, mate.name),
							lastTool: activity.lastTool,
							liveInputTokens: activity.liveInputTokens,
							liveOutputTokens: activity.liveOutputTokens,
							model: mate.model,
							name: mate.name,
							output: activity.output,
							role: mate.role,
							status: mate.status,
							totalInputTokens: activity.totalInputTokens,
							totalOutputTokens: activity.totalOutputTokens,
							unreadInboxCount: getUnreadInboxCount(team, mate.name),
							updatedAt: activity.updatedAt,
						};
					})
					.sort((a, b) => a.name.localeCompare(b.name)),
			})
		)
		.sort((a, b) => a.name.localeCompare(b.name));
	return { teams };
}

/**
 * Extract assistant text content from a session event, if present.
 * @param event - Agent session lifecycle event
 * @returns Assistant text payload, or empty string
 */
function getAssistantTextFromEvent(event: AgentSessionEvent): string {
	if (event.type !== "message_end" || event.message.role !== "assistant") return "";
	const textParts: string[] = [];
	for (const part of event.message.content) {
		if (part.type === "text") textParts.push(part.text);
	}
	return textParts.join("\n").trim();
}

/**
 * Extract assistant token usage from a streaming or completed message event.
 * @param event - Agent session lifecycle event
 * @returns Input/output token counts, or undefined when unavailable
 */
function getAssistantUsageFromEvent(
	event: AgentSessionEvent
): { input: number; output: number } | undefined {
	if (
		(event.type !== "message_update" && event.type !== "message_end") ||
		event.message.role !== "assistant"
	) {
		return undefined;
	}
	const usage = event.message.usage as Usage | undefined;
	if (!usage) return undefined;
	return {
		input: Math.max(0, Math.floor(usage.input ?? 0)),
		output: Math.max(0, Math.floor(usage.output ?? 0)),
	};
}

/**
 * Attach dashboard activity tracking to a teammate session.
 * @param teamName - Team name for activity keying
 * @param teammateName - Teammate name for activity keying
 * @param session - Teammate session
 */
function bindDashboardSessionTracking(
	teamName: string,
	teammateName: string,
	session: AgentSession
): () => void {
	return session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			dashboardActivity.setLastTool(teamName, teammateName, event.toolName);
			notifyDashboardChanged();
			return;
		}
		if (event.type === "tool_execution_end") {
			dashboardActivity.touch(teamName, teammateName);
			notifyDashboardChanged();
			return;
		}

		const usage = getAssistantUsageFromEvent(event);
		if (event.type === "message_update" && usage) {
			dashboardActivity.setLiveUsage(teamName, teammateName, usage.input, usage.output);
			notifyDashboardChanged();
			return;
		}

		if (event.type === "message_end") {
			if (usage) {
				dashboardActivity.commitUsage(teamName, teammateName, usage.input, usage.output);
			} else {
				dashboardActivity.clearLiveUsage(teamName, teammateName);
			}
			const text = getAssistantTextFromEvent(event);
			if (text.length > 0) {
				dashboardActivity.appendOutput(teamName, teammateName, `${text}\n`);
				appendDashboardFeedEvent(teamName, teammateName, "all", text);
			}
			notifyDashboardChanged();
		}
	});
}

// ════════════════════════════════════════════════════════════════
// Tool factory for standard tools from name strings
// ════════════════════════════════════════════════════════════════

// biome-ignore lint/suspicious/noExplicitAny: tool factories have different return types
const TOOL_FACTORIES: Record<string, (cwd: string) => any> = {
	read: createReadTool,
	bash: createBashTool,
	edit: createEditTool,
	write: createWriteTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
};

/**
 * Create standard tool instances from a list of tool name strings.
 * @param cwd - Working directory
 * @param toolNames - Tool names (read, bash, edit, write, grep, find, ls)
 * @returns Array of tool instances
 */
export function resolveStandardTools(cwd: string, toolNames?: string[]) {
	if (!toolNames || toolNames.length === 0) return createCodingTools(cwd);
	return toolNames.filter((n) => TOOL_FACTORIES[n]).map((n) => TOOL_FACTORIES[n](cwd));
}

// ════════════════════════════════════════════════════════════════
// Teammate tools (injected into each teammate session via customTools)
// ════════════════════════════════════════════════════════════════

/**
 * Create the team coordination tools for a specific teammate.
 * These close over the shared Team object.
 * @param team - The team this teammate belongs to
 * @param myName - This teammate's name
 * @returns Array of ToolDefinition objects
 */
export function createTeammateTools(
	team: Team<Teammate>,
	myName: string,
	piEvents?: ExtensionAPI["events"]
): ToolDefinition[] {
	const tasksTool: ToolDefinition = {
		name: "team_tasks",
		label: "Team Tasks",
		description: [
			"Manage the shared task board.",
			"Actions: list (show all), claim (assign to yourself), complete (mark done), fail (mark failed).",
			"taskId required for claim/complete/fail. result text for complete/fail.",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(["list", "claim", "complete", "fail"] as const, { description: "Action" }),
			taskId: Type.Optional(Type.String({ description: "Task ID (for claim/complete/fail)" })),
			result: Type.Optional(
				Type.String({ description: "Result or error text (for complete/fail)" })
			),
		}),
		// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition params inferred from TypeBox schema
		execute: async (_toolCallId: string, params: any) => {
			if (params.action === "list") {
				if (team.tasks.length === 0) {
					return {
						content: [{ type: "text" as const, text: "(no tasks on the board)" }],
						details: {},
					};
				}
				const lines = team.tasks.map((t) => {
					const ready = isTaskReady(team, t);
					const blocked =
						t.blockedBy.length > 0 && t.status === "pending"
							? ` [blocked by: ${t.blockedBy.join(", ")}]`
							: "";
					const assignee = t.assignee ? ` → ${t.assignee}` : "";
					const readyTag = ready ? ` ${getIcon("success")}READY` : "";
					return `#${t.id} [${t.status}] ${t.title}${assignee}${blocked}${readyTag}\n  ${t.description || "(no description)"}`;
				});
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
			}

			if (!params.taskId) {
				return {
					content: [{ type: "text" as const, text: "taskId is required for this action" }],
					details: {},
					isError: true,
				};
			}

			const task = team.tasks.find((t) => t.id === params.taskId);
			if (!task) {
				return {
					content: [{ type: "text" as const, text: `Task #${params.taskId} not found` }],
					details: {},
					isError: true,
				};
			}

			if (params.action === "claim") {
				if (!isTaskReady(team, task)) {
					const blockerStatus = task.blockedBy
						.map((id) => {
							const b = team.tasks.find((t) => t.id === id);
							return `#${id}(${b?.status ?? "??"})`;
						})
						.join(", ");
					return {
						content: [
							{
								type: "text" as const,
								text: `Task #${task.id} not ready. Status: ${task.status}. Blockers: ${blockerStatus}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				task.status = "claimed";
				task.assignee = myName;
				refreshTeamView(team as Team<Teammate>);
				appendDashboardFeedEvent(team.name, myName, "all", `Claimed #${task.id}: ${task.title}`);
				return {
					content: [{ type: "text" as const, text: `Claimed #${task.id}: ${task.title}` }],
					details: {},
				};
			}

			if (params.action === "complete") {
				task.status = "completed";
				task.result = params.result || "(completed)";
				piEvents?.emit("task_completed", {
					team: team.name,
					task_id: task.id,
					task_title: task.title,
					assignee: task.assignee || myName,
					result: task.result,
				});

				// Auto-dispatch: completing a task may unblock others
				autoDispatch(team as Team<Teammate>, piEvents);
				appendDashboardFeedEvent(team.name, myName, "all", `Completed #${task.id}: ${task.title}`);

				return {
					content: [{ type: "text" as const, text: `Completed #${task.id}: ${task.title}` }],
					details: {},
				};
			}

			if (params.action === "fail") {
				task.status = "failed";
				task.result = params.result || "(failed)";
				refreshTeamView(team as Team<Teammate>);
				appendDashboardFeedEvent(team.name, myName, "all", `Failed #${task.id}: ${task.title}`);
				return {
					content: [{ type: "text" as const, text: `Failed #${task.id}: ${task.title}` }],
					details: {},
				};
			}

			return {
				content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
				details: {},
				isError: true,
			};
		},
	};

	const messageTool: ToolDefinition = {
		name: "team_message",
		label: "Team Message",
		description:
			"Send a message to another teammate (or 'all' to broadcast). If recipient is idle, they wake up automatically.",
		parameters: Type.Object({
			to: Type.String({ description: "Recipient teammate name, or 'all'" }),
			content: Type.String({ description: "Message content" }),
		}),
		// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition params inferred from TypeBox schema
		execute: async (_toolCallId: string, params: any) => {
			addTeamMessage(team, myName, params.to, params.content);
			appendDashboardFeedEvent(team.name, myName, params.to, params.content);

			// Auto-wake idle recipients
			if (params.to === "all") {
				for (const [name, mate] of team.teammates) {
					if (name !== myName && mate.status === "idle") {
						wakeTeammate(mate, `Broadcast from ${myName}: ${params.content}`, team.name, piEvents);
					}
				}
			} else {
				const recipient = team.teammates.get(params.to);
				if (!recipient) {
					refreshTeamView(team as Team<Teammate>);
					return {
						content: [
							{
								type: "text" as const,
								text: `Teammate "${params.to}" not found. Message stored anyway.`,
							},
						],
						details: {},
					};
				}
				if (recipient.status === "idle") {
					wakeTeammate(recipient, `Message from ${myName}: ${params.content}`, team.name, piEvents);
				}
			}

			refreshTeamView(team as Team<Teammate>);
			return {
				content: [{ type: "text" as const, text: `Message sent to ${params.to}` }],
				details: {},
			};
		},
	};

	const inboxTool: ToolDefinition = {
		name: "team_inbox",
		label: "Team Inbox",
		description: "Check your inbox for unread messages from teammates or the orchestrator.",
		parameters: Type.Object({}),
		execute: async () => {
			const unread = getUnread(team, myName);
			markRead(team, myName);

			if (unread.length === 0) {
				return { content: [{ type: "text" as const, text: "No unread messages." }], details: {} };
			}

			const lines = unread.map((m) => `[${m.from}] ${m.content}`);
			return {
				content: [
					{ type: "text" as const, text: `${unread.length} message(s):\n${lines.join("\n")}` },
				],
				details: {},
			};
		},
	};

	return [tasksTool, messageTool, inboxTool];
}

// ════════════════════════════════════════════════════════════════
// Auto-dispatch: assign ready tasks to idle teammates
// ════════════════════════════════════════════════════════════════

/**
 * Check for ready (unblocked, unclaimed) tasks and idle teammates,
 * then auto-assign and wake them. Called when a task completes
 * (new tasks may unblock) or a teammate goes idle (capacity freed).
 * @param team - Team to dispatch within
 * @param piEvents - Event emitter for lifecycle events
 * @returns Number of tasks dispatched
 */
export function autoDispatch(team: Team<Teammate>, piEvents?: ExtensionAPI["events"]): number {
	const ready = getReadyTasks(team);
	const idle = getTeammatesByStatus(team, "idle");
	let dispatched = 0;

	for (const task of ready) {
		if (idle.length === 0) break;
		const mate = idle.shift();
		if (!mate) break;

		task.status = "claimed";
		task.assignee = mate.name;
		dispatched++;

		const prompt = [
			`Auto-assigned task #${task.id}: ${task.title}`,
			task.description ? `\nDescription: ${task.description}` : "",
			"\nClaim it with team_tasks, do the work, then complete it with a result.",
		].join("");

		wakeTeammate(mate, prompt, team.name, piEvents);
	}

	refreshTeamView(team);
	return dispatched;
}

// ════════════════════════════════════════════════════════════════
// Teammate session lifecycle
// ════════════════════════════════════════════════════════════════

/**
 * Wake an idle teammate by sending them a prompt. If already streaming,
 * queues as a follow-up.
 * @param mate - Teammate to wake
 * @param message - Prompt text
 * @param teamName - Team name for event emission
 * @param piEvents - Event emitter for lifecycle events
 */
export function wakeTeammate(
	mate: Teammate,
	message: string,
	teamName?: string,
	piEvents?: ExtensionAPI["events"]
): void {
	if (mate.status === "shutdown" || mate.status === "error") return;

	if (mate.session.isStreaming) {
		if (teamName) {
			dashboardActivity.touch(teamName, mate.name);
			appendDashboardFeedEvent(teamName, "system", mate.name, `Queued follow-up for @${mate.name}`);
		}
		notifyDashboardChanged();
		mate.session.followUp(message).catch(() => {});
		return;
	}

	mate.status = "working";
	if (teamName) {
		dashboardActivity.touch(teamName, mate.name);
		appendDashboardFeedEvent(teamName, mate.name, "all", "Started work.");
	}
	const runtimeTeam = getRuntimeTeam(teamName || "");
	if (runtimeTeam) refreshTeamView(runtimeTeam);

	mate.session
		.prompt(message)
		.then(() => {
			if (mate.status === "working") {
				mate.status = "idle";
				if (teamName) {
					dashboardActivity.touch(teamName, mate.name);
					appendDashboardFeedEvent(teamName, mate.name, "all", "Went idle.");
				}
				notifyDashboardChanged();
				piEvents?.emit("teammate_idle", {
					team: teamName || "",
					teammate: mate.name,
					role: mate.role,
				});

				// Auto-dispatch: teammate just went idle, check for ready tasks
				const team = getRuntimeTeam(teamName || "");
				if (team) {
					refreshTeamView(team);
					autoDispatch(team, piEvents);
				}
			}
		})
		.catch((err) => {
			mate.status = "error";
			mate.error = String(err);
			if (teamName) {
				dashboardActivity.touch(teamName, mate.name);
				appendDashboardFeedEvent(teamName, mate.name, "all", `Errored: ${String(err)}`);
			}
			notifyDashboardChanged();
			const team = getRuntimeTeam(teamName || "");
			if (team) refreshTeamView(team);
		});
}

/**
 * Spawn a teammate as an in-process AgentSession with shared team tools.
 * @param cwd - Working directory
 * @param team - Team to add the teammate to
 * @param name - Teammate name
 * @param role - Role description (becomes system prompt context)
 * @param modelName - Model to use
 * @param toolNames - Standard tool names (defaults to all coding tools)
 * @returns The created Teammate
 * @throws If model not found or session creation fails
 */
export async function spawnTeammateSession(
	cwd: string,
	team: Team<Teammate>,
	name: string,
	role: string,
	modelName: string,
	toolNames?: string[],
	piEvents?: ExtensionAPI["events"]
): Promise<Teammate> {
	const model = findModel(modelName);
	if (!model)
		throw new Error(`Model not found: ${modelName}. Tried providers: ${getProviders().join(", ")}`);

	const authStorage = new AuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);

	const otherNames = Array.from(team.teammates.keys()).filter((n) => n !== name);
	const systemPrompt = [
		`You are "${name}", a teammate in team "${team.name}".`,
		`Your role: ${role}`,
		"",
		"You have team coordination tools in addition to your standard tools:",
		"- team_tasks: List, claim, and complete tasks on the shared board",
		"- team_message: Send messages to other teammates (they auto-wake if idle)",
		"- team_inbox: Check for unread messages from teammates",
		"",
		otherNames.length > 0
			? `Other teammates: ${otherNames.join(", ")}`
			: "You are the first teammate.",
		"",
		"Work autonomously:",
		"1. Check team_tasks to see the board",
		"2. Claim a ready task",
		"3. Do the work using your standard tools",
		"4. Complete the task with a result summary",
		"5. Check inbox or claim the next ready task",
		"",
		"Communicate with teammates via team_message when you need their input.",
	].join("\n");

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const teammateCustomTools = createTeammateTools(team, name, piEvents);

	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(os.tmpdir(), `pi-team-${team.name}-${name}`),
		model,
		thinkingLevel: "off",
		authStorage,
		modelRegistry,
		resourceLoader,
		tools: resolveStandardTools(cwd, toolNames),
		customTools: teammateCustomTools,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 2 },
		}),
	});

	const mate: Teammate = { name, role, model: modelName, session, status: "idle" };
	mate.unsubscribe = bindDashboardSessionTracking(team.name, name, session);
	dashboardActivity.touch(team.name, name);
	team.teammates.set(name, mate);
	notifyDashboardChanged();
	return mate;
}

/**
 * Extract the last assistant text from a session's messages.
 * @param session - Agent session
 * @returns Last assistant text, or "(no output)"
 */
export function getLastOutput(session: AgentSession): string {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "(no output)";
}

// ════════════════════════════════════════════════════════════════
// Extension entry point
// ════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();
	let dashboardCancelInFlight = false;
	let dashboardEnabled = false;
	let dashboardRender: (() => void) | undefined;
	let dashboardTicker: ReturnType<typeof setInterval> | undefined;
	let dashboardTui: TUI | undefined;

	/**
	 * Enter alternate-screen viewport for dashboard mode.
	 * @param tui - Active TUI instance
	 * @returns void
	 */
	function enterDashboardViewport(tui: TUI): void {
		dashboardTui = tui;
		const terminal = dashboardTui.terminal as {
			enterAlternateScreen?: () => void;
			write: (data: string) => void;
		};
		if (typeof terminal.enterAlternateScreen === "function") {
			terminal.enterAlternateScreen();
		} else {
			terminal.write("\x1b[?1049h");
		}
		// Enable xterm mouse tracking + SGR extended mouse coordinates.
		terminal.write("\x1b[?1000h\x1b[?1006h");
		dashboardTui.requestRender(true);
	}

	/**
	 * Leave alternate-screen viewport and restore normal editor rendering.
	 * @returns void
	 */
	function leaveDashboardViewport(): void {
		if (!dashboardTui) return;
		const terminal = dashboardTui.terminal as {
			leaveAlternateScreen?: () => void;
			write: (data: string) => void;
		};
		// Disable mouse tracking before restoring normal viewport.
		terminal.write("\x1b[?1000l\x1b[?1006l");
		if (typeof terminal.leaveAlternateScreen === "function") {
			terminal.leaveAlternateScreen();
		} else {
			terminal.write("\x1b[?1049l");
		}
		dashboardTui.requestRender(true);
		dashboardTui = undefined;
	}

	/**
	 * Publish dashboard-active state for cross-extension UI coordination.
	 * @param enabled - Whether dashboard workspace is currently active
	 * @returns void
	 */
	function setDashboardFlag(enabled: boolean): void {
		(globalThis as Record<string, unknown>).__piTeamDashboardActive = enabled;
		const callback = (globalThis as Record<string, unknown>).__piOnTeamViewChange;
		if (typeof callback === "function") callback();
	}

	/**
	 * Start periodic dashboard refresh ticks for animated glyphs and live telemetry.
	 * @returns void
	 */
	function startDashboardTicker(): void {
		if (dashboardTicker) return;
		dashboardTicker = setInterval(() => {
			if (!dashboardEnabled) return;
			notifyDashboardChanged();
		}, 250);
	}

	/**
	 * Stop periodic dashboard refresh ticks.
	 * @returns void
	 */
	function stopDashboardTicker(): void {
		if (!dashboardTicker) return;
		clearInterval(dashboardTicker);
		dashboardTicker = undefined;
	}

	/**
	 * Abort all teammates that are currently streaming work.
	 * @returns Number of teammates that received an abort request
	 */
	async function abortRunningTeammates(): Promise<number> {
		const running: Array<{ teammate: Teammate; team: Team<Teammate> }> = [];
		for (const [, team] of getTeams() as Map<string, Team<Teammate>>) {
			for (const [, teammate] of team.teammates) {
				if (teammate.status !== "working" && !teammate.session.isStreaming) continue;
				running.push({ teammate, team });
			}
		}
		if (running.length === 0) return 0;

		await Promise.all(
			running.map(async ({ teammate }) => {
				try {
					await teammate.session.abort();
				} catch {
					// Best-effort abort.
				}
			})
		);

		const touchedTeams = new Set<Team<Teammate>>();
		for (const { teammate, team } of running) {
			if (teammate.status === "working") teammate.status = "idle";
			dashboardActivity.touch(team.name, teammate.name);
			appendDashboardFeedEvent(team.name, "orchestrator", teammate.name, "Cancelled run.");
			touchedTeams.add(team);
		}
		for (const team of touchedTeams) refreshTeamView(team);
		notifyDashboardChanged();
		return running.length;
	}

	/**
	 * Handle Esc inside dashboard: cancel active work first, then close dashboard.
	 * @param ctx - Extension context
	 * @returns void
	 */
	function handleDashboardEscape(ctx: ExtensionContext): void {
		if (dashboardCancelInFlight) return;
		void (async () => {
			dashboardCancelInFlight = true;
			try {
				const cancelled = await abortRunningTeammates();
				if (cancelled > 0) {
					ctx.ui.notify(
						`Cancelled ${cancelled} running teammate${cancelled === 1 ? "" : "s"}. Press Esc again to close dashboard.`,
						"warning"
					);
					return;
				}
				if (!dashboardEnabled) return;
				disableDashboard(ctx, false);
				ctx.ui.notify("Team dashboard disabled.", "info");
			} finally {
				dashboardCancelInFlight = false;
			}
		})();
	}

	/**
	 * Enable dashboard mode by swapping in the dashboard editor component.
	 * @param ctx - Extension context
	 * @returns void
	 */
	function enableDashboard(ctx: ExtensionContext): void {
		dashboardEnabled = true;
		setDashboardFlag(true);
		startDashboardTicker();
		ctx.ui.setWorkingMessage(Loader.HIDE);
		ctx.ui.setStatus("team-dashboard", "Team dashboard active");
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			enterDashboardViewport(tui);
			const editor = new TeamDashboardEditor(tui, theme, keybindings, {
				getSnapshot: buildDashboardSnapshot,
				onEscape: () => {
					if (!dashboardEnabled) return;
					handleDashboardEscape(ctx);
				},
				onExit: () => {
					if (!dashboardEnabled) return;
					disableDashboard(ctx, false);
					ctx.ui.notify("Team dashboard disabled.", "info");
				},
			});
			dashboardRender = () => editor.refresh();
			(globalThis as Record<string, unknown>).__piOnTeamDashboardChange = () => {
				dashboardRender?.();
			};
			return editor;
		});
		notifyDashboardChanged();
	}

	/**
	 * Disable dashboard mode and restore the default editor component.
	 * @param ctx - Extension context
	 * @param notify - Whether to notify the user about the state transition
	 * @returns void
	 */
	function disableDashboard(ctx: ExtensionContext, notify = true): void {
		dashboardCancelInFlight = false;
		dashboardEnabled = false;
		stopDashboardTicker();
		dashboardRender = undefined;
		(globalThis as Record<string, unknown>).__piOnTeamDashboardChange = undefined;
		setDashboardFlag(false);
		leaveDashboardViewport();
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setWorkingMessage();
		ctx.ui.setStatus("team-dashboard", undefined);
		if (notify) ctx.ui.notify("Team dashboard disabled.", "info");
	}

	/**
	 * Transition dashboard mode to the requested enabled state.
	 * @param ctx - Extension context
	 * @param enabled - Requested dashboard enabled state
	 * @param notify - Whether to notify the user
	 * @returns void
	 */
	function setDashboardEnabledState(ctx: ExtensionContext, enabled: boolean, notify = true): void {
		if (!ctx.hasUI) return;
		if (enabled) {
			if (!dashboardEnabled) enableDashboard(ctx);
			if (notify) ctx.ui.notify("Team dashboard enabled.", "info");
			return;
		}
		if (dashboardEnabled) disableDashboard(ctx, notify);
	}

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		if (ctx.hasUI) {
			(globalThis as Record<string, unknown>).__piOnTeamDashboardChange = () => {
				dashboardRender?.();
			};
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!dashboardEnabled || !ctx.hasUI) return;
		ctx.ui.setWorkingMessage(Loader.HIDE);
	});

	// Archive all teams on session shutdown (preserves tasks for future recovery)
	pi.on("session_shutdown", async () => {
		for (const [name, team] of getTeams() as Map<string, Team<Teammate>>) {
			for (const [, mate] of team.teammates) {
				try {
					if (mate.session.isStreaming) await mate.session.abort();
					mate.unsubscribe?.();
					mate.session.dispose();
				} catch (err) {
					console.error(`Failed to clean up teammate ${mate.name}: ${err}`);
				}
				mate.status = "shutdown";
			}
			removeTeamView(name);
			archiveTeam(name);
		}
		dashboardCancelInFlight = false;
		dashboardEnabled = false;
		stopDashboardTicker();
		dashboardRender = undefined;
		(globalThis as Record<string, unknown>).__piOnTeamDashboardChange = undefined;
		setDashboardFlag(false);
		leaveDashboardViewport();
	});

	// Clean up finished teams on agent turn end.
	// Teams with active background work survive across turns — they keep
	// running while the user reads the response or types a new message.
	// Only teams where all teammates have finished are archived.
	// Full cleanup (including active teams) happens on session_shutdown.
	pi.on("agent_end", async () => {
		for (const [name, team] of getTeams() as Map<string, Team<Teammate>>) {
			const hasActiveWork = [...team.teammates.values()].some((m) => m.status === "working");
			if (hasActiveWork) continue;

			// All teammates finished — clean up and archive
			for (const [, mate] of team.teammates) {
				if (mate.status === "idle") {
					try {
						mate.unsubscribe?.();
						mate.session.dispose();
					} catch {
						// Best-effort cleanup
					}
					mate.status = "shutdown";
				}
			}
			removeTeamView(name);
			archiveTeam(name);
		}
	});

	pi.registerCommand("team-dashboard", {
		description: "Toggle the Team Dashboard workspace (/team-dashboard [on|off|status])",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const resolution = resolveDashboardCommand(dashboardEnabled, args);
			if (resolution.isError) {
				ctx.ui.notify(resolution.message, "error");
				return;
			}
			if (resolution.action !== "status") {
				setDashboardEnabledState(ctx, resolution.nextEnabled, false);
			}
			ctx.ui.notify(resolution.message, "info");
		},
	});

	pi.registerShortcut(Key.ctrl("x"), {
		description: "Toggle Team Dashboard workspace",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			setDashboardEnabledState(ctx, !dashboardEnabled);
		},
	});

	// ─── team_create ────────────────────────────────────────────

	pi.registerTool({
		name: "team_create",
		label: "Team Create",
		description: "Create a new agent team with a shared task board and inter-agent messaging.",
		parameters: Type.Object({
			name: Type.String({ description: "Team name (unique)" }),
		}),
		async execute(_toolCallId, params) {
			if (getTeams().has(params.name)) {
				return {
					content: [{ type: "text", text: `Team "${params.name}" already exists.` }],
					details: {},
					isError: true,
				};
			}
			createTeamStore(params.name);
			appendDashboardFeedEvent(params.name, "orchestrator", "all", `Team "${params.name}" created`);
			notifyDashboardChanged();
			return {
				content: [
					{
						type: "text",
						text: `Team "${params.name}" created. Add tasks with team_add_tasks, then spawn teammates with team_spawn.`,
					},
				],
				details: {},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_create ")) + theme.fg("accent", args.name || "..."),
				0,
				0
			);
		},
		renderResult(result, _opts, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const isErr = text.includes("already exists");
			return new Text(theme.fg(isErr ? "error" : "success", text), 0, 0);
		},
	});

	// ─── team_add_tasks ─────────────────────────────────────────

	pi.registerTool({
		name: "team_add_tasks",
		label: "Team Add Tasks",
		description:
			"Add tasks to a team's shared board. Tasks can depend on other tasks (blockedBy). Blocked tasks become ready when all blockers complete.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
			tasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "Task title" }),
					description: Type.Optional(Type.String({ description: "Detailed description" })),
					blockedBy: Type.Optional(
						Type.Array(Type.String(), { description: "Task IDs that must complete first" })
					),
				})
			),
		}),
		async execute(_toolCallId, params) {
			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}

			const added: TeamTask[] = [];
			for (const t of params.tasks) {
				added.push(addTaskToBoard(team, t.title, t.description || "", t.blockedBy || []));
			}

			const lines = added.map(
				(t) =>
					`#${t.id}: ${t.title}${t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : ""}`
			);
			refreshTeamView(team);
			appendDashboardFeedEvent(
				team.name,
				"orchestrator",
				"all",
				`Added ${added.length} task${added.length === 1 ? "" : "s"}`
			);
			return {
				content: [{ type: "text", text: `Added ${added.length} task(s):\n${lines.join("\n")}` }],
				details: {},
			};
		},
		renderCall(args, theme) {
			const count = args.tasks?.length || 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("team_add_tasks ")) +
					theme.fg("accent", args.team || "...") +
					theme.fg("dim", ` (${count} task${count !== 1 ? "s" : ""})`),
				0,
				0
			);
		},
	});

	// ─── team_spawn ─────────────────────────────────────────────

	pi.registerTool({
		name: "team_spawn",
		label: "Team Spawn",
		description: [
			"Spawn a teammate with their own agent session, shared task board access, and inter-agent messaging.",
			"They get standard coding tools plus team coordination tools.",
			"After spawning, use team_send to give them initial instructions.",
		].join(" "),
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
			name: Type.String({ description: "Teammate name (unique within team)" }),
			role: Type.String({ description: "Role/description (guides their behavior)" }),
			model: Type.Optional(Type.String({ description: 'Model ID (default: "claude-sonnet-4-5")' })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Standard tool names: read, bash, edit, write, grep, find, ls. Default: all coding tools.",
				})
			),
		}),
		async execute(_toolCallId, params) {
			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}
			if (team.teammates.has(params.name)) {
				return {
					content: [
						{
							type: "text",
							text: `Teammate "${params.name}" already exists in team "${params.team}".`,
						},
					],
					details: {},
					isError: true,
				};
			}

			try {
				const mate = await spawnTeammateSession(
					cwd,
					team,
					params.name,
					params.role,
					params.model || "claude-sonnet-4-5",
					params.tools,
					pi.events
				);
				refreshTeamView(team);
				appendDashboardFeedEvent(
					team.name,
					"orchestrator",
					"all",
					`Spawned @${params.name} (${mate.model})`
				);
				return {
					content: [
						{
							type: "text",
							text: `Spawned "${params.name}" (${mate.model}). Status: idle. Use team_send to give instructions.`,
						},
					],
					details: {},
				};
				// biome-ignore lint/suspicious/noExplicitAny: catch clause
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to spawn "${params.name}": ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_spawn ")) +
					theme.fg("accent", args.name || "...") +
					theme.fg("dim", ` → ${args.team || "..."}`) +
					(args.model ? theme.fg("muted", ` (${args.model})`) : ""),
				0,
				0
			);
		},
	});

	// ─── team_send ──────────────────────────────────────────────

	pi.registerTool({
		name: "team_send",
		label: "Team Send",
		description: [
			"Send a message to a teammate. If idle, wakes them up.",
			"Set wait=true to block until the teammate finishes processing.",
			"Without wait, returns immediately (teammate works in background).",
		].join(" "),
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
			to: Type.String({ description: "Teammate name" }),
			message: Type.String({ description: "Message / instruction" }),
			wait: Type.Optional(
				Type.Boolean({ description: "Block until teammate finishes responding (default: false)" })
			),
		}),
		async execute(_toolCallId, params, signal) {
			// Fast-path: already aborted before we start
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "team_send was cancelled before execution." }],
					details: {},
					isError: true,
				};
			}

			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}

			const mate = team.teammates.get(params.to);
			if (!mate) {
				return {
					content: [
						{ type: "text", text: `Teammate "${params.to}" not found in team "${params.team}".` },
					],
					details: {},
					isError: true,
				};
			}

			if (mate.status === "shutdown" || mate.status === "error") {
				return {
					content: [
						{
							type: "text",
							text: `Teammate "${params.to}" is ${mate.status}${mate.error ? `: ${mate.error}` : ""}.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			addTeamMessage(team, "orchestrator", params.to, params.message);
			appendDashboardFeedEvent(team.name, "orchestrator", params.to, params.message);

			const prompt = `Message from orchestrator: ${params.message}`;

			if (params.wait) {
				// Propagate abort signal to teammate
				const abortHandler = () => {
					mate.session.abort().catch(() => {});
				};
				signal?.addEventListener("abort", abortHandler, { once: true });

				try {
					// Build an abort promise that rejects when the signal fires.
					// This lets Promise.race unblock immediately on cancellation,
					// even if mate.session.prompt() swallows the abort internally.
					const abortPromise = new Promise<never>((_, reject) => {
						if (signal?.aborted) {
							reject(new DOMException("team_send aborted", "AbortError"));
							return;
						}
						signal?.addEventListener(
							"abort",
							() => reject(new DOMException("team_send aborted", "AbortError")),
							{ once: true }
						);
					});

					if (mate.session.isStreaming) {
						// Already working — queue as followUp, then wait for idle
						dashboardActivity.touch(team.name, mate.name);
						notifyDashboardChanged();
						await mate.session.followUp(prompt);
						await Promise.race([mate.session.agent.waitForIdle(), abortPromise]);
					} else {
						mate.status = "working";
						dashboardActivity.touch(team.name, mate.name);
						refreshTeamView(team);
						await Promise.race([mate.session.prompt(prompt), abortPromise]);
					}
					mate.status = "idle";
					dashboardActivity.touch(team.name, mate.name);
					refreshTeamView(team);

					const output = getLastOutput(mate.session);
					return {
						content: [{ type: "text", text: `@${params.to} responded:\n\n${output}` }],
						details: {},
					};
					// biome-ignore lint/suspicious/noExplicitAny: catch clause
				} catch (err: any) {
					if (signal?.aborted) {
						// Abort path: return error result so the orchestrator's agent
						// loop can proceed to its normal abort/end flow. Don't mark
						// the teammate as error — agent_end cleanup will handle it.
						return {
							content: [{ type: "text", text: `team_send to "${params.to}" was cancelled.` }],
							details: {},
							isError: true,
						};
					}
					mate.status = "error";
					mate.error = String(err);
					dashboardActivity.touch(team.name, mate.name);
					refreshTeamView(team);
					return {
						content: [{ type: "text", text: `Teammate "${params.to}" errored: ${err.message}` }],
						details: {},
						isError: true,
					};
				} finally {
					signal?.removeEventListener("abort", abortHandler);
				}
			}

			// Fire-and-forget
			wakeTeammate(mate, prompt, team.name, pi.events);
			refreshTeamView(team);
			return {
				content: [{ type: "text", text: `Message sent to ${params.to} (status: ${mate.status}).` }],
				details: {},
			};
		},
		renderCall(args, theme) {
			const preview =
				args.message?.length > 60 ? `${args.message.slice(0, 60)}...` : args.message || "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("team_send ")) +
					theme.fg("accent", `→ ${args.to || "..."}`) +
					(args.wait ? theme.fg("warning", " (wait)") : "") +
					"\n  " +
					theme.fg("dim", preview),
				0,
				0
			);
		},
	});

	// ─── team_status ────────────────────────────────────────────

	pi.registerTool({
		name: "team_status",
		label: "Team Status",
		description: "Get team overview: task board, teammate states, and recent messages.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
		}),
		async execute(_toolCallId, params) {
			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}

			return { content: [{ type: "text", text: formatTeamStatus(team) }], details: {} };
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_status ")) + theme.fg("accent", args.team || "..."),
				0,
				0
			);
		},
	});

	// ─── team_shutdown ──────────────────────────────────────────

	pi.registerTool({
		name: "team_shutdown",
		label: "Team Shutdown",
		description: "Shutdown a team. Aborts all running teammates and cleans up sessions.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
		}),
		async execute(_toolCallId, params) {
			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}

			let count = 0;
			for (const [, mate] of team.teammates) {
				try {
					if (mate.session.isStreaming) await mate.session.abort();
					mate.unsubscribe?.();
					mate.session.dispose();
					mate.status = "shutdown";
					count++;
				} catch (err) {
					console.error(`Failed to clean up teammate ${mate.name}: ${err}`);
					mate.status = "shutdown";
					count++;
				}
			}

			removeTeamView(params.team);
			archiveTeam(params.team);
			return {
				content: [
					{
						type: "text",
						text: `Team "${params.team}" shutdown. ${count} teammate${count !== 1 ? "s" : ""} terminated, task list archived. Use team_resume to restore.`,
					},
				],
				details: {},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_shutdown ")) + theme.fg("error", args.team || "..."),
				0,
				0
			);
		},
		renderResult(result, _opts, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg("warning", text), 0, 0);
		},
	});

	// ─── team_resume ────────────────────────────────────────────

	pi.registerTool({
		name: "team_resume",
		label: "Team Resume",
		description:
			"Restore an archived team and its task board. Lists archived teams when called without a name. " +
			"The restored team has no teammates — spawn new ones to continue work on remaining tasks.",
		parameters: Type.Object({
			team: Type.Optional(
				Type.String({
					description: "Archived team name to restore. Omit to list available archives.",
				})
			),
		}),
		async execute(_toolCallId, params) {
			// List mode — show all archived teams
			if (!params.team) {
				const archives = getArchivedTeams();
				if (archives.size === 0) {
					return {
						content: [{ type: "text", text: "No archived teams available." }],
						details: {} as Record<string, unknown>,
					};
				}
				const lines = ["# Archived Teams\n"];
				for (const [, arch] of archives) {
					lines.push(formatArchivedTeamStatus(arch));
					lines.push("");
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { count: archives.size } as Record<string, unknown>,
				};
			}

			// Restore mode
			if (getTeams().has(params.team)) {
				return {
					content: [
						{
							type: "text",
							text: `Team "${params.team}" is already active. Use team_status to inspect it.`,
						},
					],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			const restored = restoreArchivedTeam(params.team);
			if (!restored) {
				const available = Array.from(getArchivedTeams().keys());
				const hint =
					available.length > 0
						? ` Available: ${available.join(", ")}`
						: " No archived teams available.";
				return {
					content: [{ type: "text", text: `No archived team "${params.team}" found.${hint}` }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			const completed = restored.tasks.filter((t) => t.status === "completed").length;
			const remaining = restored.tasks.length - completed;
			const failed = restored.tasks.filter((t) => t.status === "failed").length;

			// Reset claimed tasks back to pending (their agents are gone)
			for (const task of restored.tasks) {
				if (task.status === "claimed") {
					task.status = "pending";
					task.assignee = null;
				}
			}

			notifyDashboardChanged();
			return {
				content: [
					{
						type: "text",
						text:
							`Team "${params.team}" restored. ${restored.tasks.length} tasks: ${completed} completed` +
							(failed > 0 ? `, ${failed} failed` : "") +
							`, ${remaining} remaining.\n` +
							"Spawn teammates with team_spawn to continue work.",
					},
				],
				details: { tasks: restored.tasks.length, completed, remaining, failed } as Record<
					string,
					unknown
				>,
			};
		},
		renderCall(args, theme) {
			const label = args.team || "(list)";
			return new Text(
				theme.fg("toolTitle", theme.bold("team_resume ")) + theme.fg("accent", label),
				0,
				0
			);
		},
		renderResult(result, _opts, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const isErr = "isError" in result && result.isError;
			return new Text(theme.fg(isErr ? "error" : "success", text), 0, 0);
		},
	});
}
