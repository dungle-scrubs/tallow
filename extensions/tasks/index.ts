/**
 * Tasks Extension for Pi
 *
 * Task management with cross-session persistence:
 * - Three states: pending (☐), in-progress (◉), completed (☑)
 * - Bidirectional dependency tracking (blocks/blockedBy)
 * - Comments for cross-session handoff context
 * - Team-based sharing via ~/.tallow/teams/{team-name}/tasks/
 * - Multi-session coordination via fs.watch
 * - One file per task (avoids write conflicts)
 * - Status widget with dynamic sizing
 * - Ctrl+Shift+T to toggle visibility
 * - /tasks command to view/manage
 *
 * NOTE: This extension only runs in the main Pi process, not in subagent workers.
 */

import { randomUUID } from "node:crypto";
import type { FSWatcher } from "node:fs";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon, getSpinner } from "../_icons/index.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Directory root for team-based shared task lists. */
const TEAMS_DIR = join(homedir(), ".tallow", "teams");

/** Max age for team directories before cleanup (7 days in ms). */
const TEAM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Minimum width for side-by-side layout (tasks left, subagents right)
const MIN_SIDE_BY_SIDE_WIDTH = 120;

// ── Task Types ───────────────────────────────────────────────────────────────

/** Lifecycle state of a task. */
type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/** A comment attached to a task for cross-session context. */
interface TaskComment {
	author: string;
	content: string;
	timestamp: number;
}

/**
 * A single task with subject, description, bidirectional deps, and comments.
 * @internal
 */
export interface Task {
	/** Sequential integer ID as string ("1", "2", ...). */
	id: string;
	/** Short summary (was "title" in old schema). */
	subject: string;
	/** Detailed description — survives context compaction. */
	description?: string;
	/** Present continuous form shown in spinner when in_progress (e.g. "Running tests"). */
	activeForm?: string;
	status: TaskStatus;
	/** Task IDs this task blocks (forward deps). */
	blocks: string[];
	/** Task IDs that block this task (reverse deps). */
	blockedBy: string[];
	/** Audit trail / handoff context — persists across sessions. */
	comments: TaskComment[];
	/** Agent that claimed this task (passive, no enforcement yet). */
	owner?: string;
	/** Arbitrary key-value metadata. Set a key to null to delete it. */
	metadata?: Record<string, unknown>;
	createdAt: number;
	completedAt?: number;
}

// ── View Types (read from globalThis) ────────────────────────────────────────

/** Shape of background task entries read from G.__piBackgroundTasks */
interface BgTaskView {
	id: string;
	command: string;
	status: string;
	startTime: number;
}

/** Shape of subagent entries read from globalThis.__piRunning/BackgroundSubagents */
interface SubagentView {
	id: string;
	agent: string;
	task: string;
	status?: string;
	startTime: number;
}

/** Shape of team views read from G.__piActiveTeams */
interface TeamWidgetView {
	name: string;
	tasks: Array<{
		id: string;
		title: string;
		status: string;
		assignee: string | null;
		blockedBy: string[];
	}>;
	teammates: Array<{
		name: string;
		role: string;
		model: string;
		status: string;
		currentTask?: string;
	}>;
}

// ── Agent Activity Tracking ───────────────────────────────────────────────────

/** Live activity status for a running subagent (updated via event bus). */
interface AgentActivity {
	toolName: string;
	summary: string;
	timestamp: number;
}

/**
 * Tracks the current activity of each running subagent by agent_id.
 * Populated from subagent_tool_call events, cleared on subagent_stop.
 */
const agentActivity = new Map<string, AgentActivity>();

/**
 * Generated agent identity: a display name and type label.
 * Populated on subagent_start with keyword heuristic, refined by Haiku.
 */
/** @internal */
export interface AgentIdentity {
	/** Display name shown in widget and used as task owner (e.g. "scout", "auditor"). */
	displayName: string;
	/** Activity type label (e.g. "Explore", "Review"). */
	typeLabel: string;
}

/** Cached agent identities keyed by subagent ID. */
const agentIdentities = new Map<string, AgentIdentity>();

/** Valid type labels for agent classification. */
const AGENT_TYPE_LABELS = [
	"Explore",
	"Implement",
	"Review",
	"Plan",
	"Test",
	"Fix",
	"Research",
	"Write",
	"Debug",
	"Refactor",
	"Deploy",
	"Monitor",
	"Design",
	"Analyze",
] as const;

/**
 * Classify an agent's task into a display name + type label using keyword heuristics.
 * @internal
 * @param task - The task description
 * @param agentName - The agent definition name (e.g. "worker")
 * @returns An AgentIdentity with displayName and typeLabel
 */
export function classifyAgent(task: string, agentName: string): AgentIdentity {
	const combined = `${agentName} ${task}`.toLowerCase();
	const patterns: [RegExp, string, string][] = [
		[/\b(review|critique|feedback|inspect|evaluate)\b/, "reviewer", "Review"],
		[/\b(audit|check|security)\b/, "auditor", "Review"],
		[/\b(explore|discover|scout|survey)\b/, "scout", "Explore"],
		[/\b(research|investigate|find|search)\b/, "researcher", "Explore"],
		[/\b(plan|spec|architect|propose|outline|strategy)\b/, "planner", "Plan"],
		[/\b(design|mockup|wireframe|layout)\b/, "designer", "Design"],
		[/\b(test|verify|validate|assert|qa)\b/, "tester", "Test"],
		[/\b(fix|bug|debug|resolve|patch|hotfix)\b/, "fixer", "Fix"],
		[/\b(refactor|restructure|reorganize|simplify)\b/, "refactorer", "Refactor"],
		[/\b(deploy|release|publish|ship)\b/, "deployer", "Deploy"],
		[/\b(monitor|watch|observe|alert)\b/, "monitor", "Monitor"],
		[/\b(analyze|compare|measure|profile|benchmark)\b/, "analyst", "Analyze"],
		[/\b(write|create|build|implement|add|make|develop|code)\b/, "builder", "Implement"],
	];

	for (const [pattern, name, label] of patterns) {
		if (pattern.test(combined)) return { displayName: name, typeLabel: label };
	}
	return { displayName: agentName, typeLabel: "General" };
}

/**
 * Refine an agent identity asynchronously via a lightweight Haiku call.
 * Generates both a short display name and type label in one request.
 * Falls back silently on any failure — the heuristic identity remains.
 * @param subagentId - Subagent ID to update in the cache
 * @param task - Task description to classify
 * @param getApiKey - Function to retrieve the Anthropic API key
 */
async function refineAgentIdentityAsync(
	subagentId: string,
	task: string,
	getApiKey: () => Promise<string | undefined>
): Promise<void> {
	try {
		const apiKey = await getApiKey();
		if (!apiKey) return;

		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "claude-haiku-3-5-20241022",
				max_tokens: 20,
				messages: [
					{
						role: "user",
						content:
							"Given this agent task, respond with EXACTLY two words separated by a space:\n" +
							"1. A short lowercase agent name (like: scout, auditor, builder, tester, planner, researcher, fixer, designer)\n" +
							`2. A type label from: ${AGENT_TYPE_LABELS.join(", ")}\n\n` +
							`Task: "${task.slice(0, 300)}"\n\nExample response: researcher Explore`,
					},
				],
			}),
		});
		if (!response.ok) return;

		const data = (await response.json()) as { content?: Array<{ text?: string }> };
		const text = data.content?.[0]?.text?.trim() ?? "";
		const parts = text.split(/\s+/);
		if (parts.length >= 2) {
			const name = parts[0].toLowerCase().replace(/[^a-z-]/g, "");
			const label = parts[1];
			if (
				name.length > 0 &&
				AGENT_TYPE_LABELS.includes(label as (typeof AGENT_TYPE_LABELS)[number])
			) {
				agentIdentities.set(subagentId, { displayName: name, typeLabel: label });
			}
		}
	} catch {
		// Silently fall back to heuristic
	}
}

/** Agent color palette for teammate display (CC-style). */
const AGENT_COLORS: readonly string[] = [
	"green",
	"cyan",
	"magenta",
	"yellow",
	"blue",
	"red",
] as const;

/**
 * Assigns a deterministic color to an agent name via hash.
 * @param name - Agent name to hash
 * @returns ANSI color name
 */
function agentColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = Math.trunc(hash * 31 + name.charCodeAt(i));
	}
	return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

/**
 * Builds a human-readable summary from a tool call.
 * @param toolName - Name of the tool being called
 * @param toolInput - Tool input parameters
 * @returns Short activity description
 */
function summarizeToolCall(toolName: string, toolInput: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const cmd = String(toolInput.command ?? "");
			const firstLine = cmd.split("\n")[0];
			return firstLine.length > 40 ? `${firstLine.slice(0, 37)}...` : firstLine;
		}
		case "read":
			return `Reading ${String(toolInput.path ?? "")}`;
		case "edit":
			return `Editing ${String(toolInput.path ?? "")}`;
		case "write":
			return `Writing ${String(toolInput.path ?? "")}`;
		case "grep":
			return `Searching: ${String(toolInput.pattern ?? "")}`;
		case "find":
			return `Finding: ${String(toolInput.pattern ?? "")}`;
		case "ls":
			return `Listing ${String(toolInput.path ?? ".")}`;
		default:
			return toolName;
	}
}

// ── Widget State ─────────────────────────────────────────────────────────────

/** Complete tasks widget state including visibility and active task tracking. */
interface TasksState {
	tasks: Task[];
	visible: boolean;
	activeTaskId: string | null;
	/** Next sequential ID counter. */
	nextId: number;
}

// ── TaskListStore ────────────────────────────────────────────────────────────

/**
 * Persistent, file-backed task store for cross-session sharing.
 *
 * Each team gets a directory at ~/.tallow/teams/{team-name}/tasks/ containing
 * one JSON file per task. fs.watch on the directory detects changes from
 * other sessions sharing the same team.
 *
 * Without a team name, this store is inactive and the extension falls back
 * to session-entry persistence.
 */
class TaskListStore {
	private readonly dirPath: string | null;
	private watcher: FSWatcher | null = null;
	private onChange: (() => void) | null = null;
	/** Debounce timer to coalesce rapid file change events. */
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	/** Set of filenames we just wrote — ignore their fs.watch events. */
	private readonly recentWrites = new Set<string>();

	/**
	 * @param teamName - Team name for shared task directory, or null for session-only mode
	 */
	constructor(teamName: string | null) {
		if (teamName) {
			const safeName = teamName.replace(/[^a-zA-Z0-9._-]/g, "_");
			this.dirPath = join(TEAMS_DIR, safeName, "tasks");
			mkdirSync(this.dirPath, { recursive: true });
		} else {
			this.dirPath = null;
		}
	}

	/** @returns Whether this store is in shared (file-backed) mode. */
	get isShared(): boolean {
		return this.dirPath !== null;
	}

	/** @returns The resolved directory path, or null in session-only mode. */
	get path(): string | null {
		return this.dirPath;
	}

	/**
	 * Load all tasks from the shared directory.
	 * @returns Array of tasks sorted by ID, or null if not in shared mode.
	 */
	loadAll(): Task[] | null {
		if (!this.dirPath) return null;
		if (!existsSync(this.dirPath)) return [];

		const tasks: Task[] = [];
		try {
			const files = readdirSync(this.dirPath).filter((f) => f.endsWith(".json"));
			for (const file of files) {
				try {
					const raw = readFileSync(join(this.dirPath, file), "utf-8");
					const parsed = JSON.parse(raw) as Record<string, unknown>;
					// Migrate old schema: title → subject, dependencies → blockedBy
					if (parsed.title && !parsed.subject) {
						parsed.subject = parsed.title;
						parsed.title = undefined;
					}
					if (parsed.dependencies && !parsed.blockedBy) {
						parsed.blockedBy = parsed.dependencies;
						parsed.dependencies = undefined;
					}
					const task = parsed as unknown as Task;
					task.blocks = task.blocks ?? [];
					task.blockedBy = task.blockedBy ?? [];
					task.comments = task.comments ?? [];
					tasks.push(task);
				} catch {
					// Skip corrupt files
				}
			}
		} catch {
			return [];
		}

		return tasks.sort((a, b) => Number(a.id) - Number(b.id));
	}

	/**
	 * Acquire a directory-based lock for the task store. Returns a release function.
	 * Uses mkdirSync which is atomic on POSIX — fails if dir exists.
	 * Spins with exponential backoff up to ~1s, then proceeds unlocked.
	 * @returns Release function to call when done
	 */
	lock(): () => void {
		if (!this.dirPath) return () => {};
		const lockDir = join(this.dirPath, ".lock");
		let acquired = false;
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				mkdirSync(lockDir);
				acquired = true;
				break;
			} catch {
				// Lock held — spin with exponential backoff
				const waitMs = Math.min(10 * 2 ** attempt, 200);
				const start = Date.now();
				while (Date.now() - start < waitMs) {
					// busy-wait (synchronous lock needed for synchronous callers)
				}
			}
		}
		if (!acquired) {
			// Stale lock? Check age — force remove if older than 5s
			try {
				const stat = statSync(lockDir);
				const ageMs = Date.now() - stat.mtimeMs;
				if (ageMs > 5_000) {
					rmdirSync(lockDir);
					mkdirSync(lockDir);
					acquired = true;
				}
			} catch {
				// Proceed unlocked — best effort
			}
		}
		return () => {
			try {
				rmdirSync(lockDir);
			} catch {
				// Already released
			}
		};
	}

	/**
	 * Save a single task to its own file, atomically (write tmp + rename).
	 * @param task - Task to persist
	 */
	saveTask(task: Task): void {
		if (!this.dirPath) return;

		const filename = `${task.id}.json`;
		const filePath = join(this.dirPath, filename);
		const tmpPath = join(this.dirPath, `.${filename}.${randomUUID().slice(0, 8)}.tmp`);
		const unlock = this.lock();

		try {
			this.recentWrites.add(filename);
			writeFileSync(tmpPath, JSON.stringify(task, null, 2), "utf-8");
			renameSync(tmpPath, filePath);
			setTimeout(() => this.recentWrites.delete(filename), 200);
		} catch {
			this.recentWrites.delete(filename);
			try {
				writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
			} catch {
				// Silent — state still in session entries
			}
		} finally {
			unlock();
		}
	}

	/**
	 * Delete a task file.
	 * @param taskId - ID of the task to remove
	 */
	deleteTask(taskId: string): void {
		if (!this.dirPath) return;
		const filename = `${taskId}.json`;
		const filePath = join(this.dirPath, filename);
		const unlock = this.lock();
		try {
			this.recentWrites.add(filename);
			if (existsSync(filePath)) unlinkSync(filePath);
			setTimeout(() => this.recentWrites.delete(filename), 200);
		} catch {
			this.recentWrites.delete(filename);
		} finally {
			unlock();
		}
	}

	/**
	 * Delete all task files in the directory.
	 */
	deleteAll(): void {
		if (!this.dirPath) return;
		try {
			const files = readdirSync(this.dirPath).filter((f) => f.endsWith(".json"));
			for (const file of files) {
				this.recentWrites.add(file);
				try {
					unlinkSync(join(this.dirPath, file));
				} catch {
					// skip
				}
				setTimeout(() => this.recentWrites.delete(file), 200);
			}
		} catch {
			// skip
		}
	}

	/**
	 * Start watching the task directory for external changes.
	 * @param callback - Invoked when another session modifies a task file
	 */
	watch(callback: () => void): void {
		if (!this.dirPath) return;

		this.onChange = callback;

		try {
			this.watcher = watch(this.dirPath, (_, changedFile) => {
				if (!changedFile?.endsWith(".json")) return;
				if (this.recentWrites.has(changedFile)) return;

				// Debounce: coalesce rapid events
				if (this.debounceTimer) clearTimeout(this.debounceTimer);
				this.debounceTimer = setTimeout(() => {
					this.debounceTimer = null;
					this.onChange?.();
				}, 150);
			});
		} catch {
			// fs.watch can fail on some filesystems — degrade gracefully
		}
	}

	/** Stop watching and clean up resources. */
	close(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		this.onChange = null;
	}
}

/**
 * Remove team directories older than TEAM_MAX_AGE_MS.
 * Skips the current team (if any) to avoid deleting an active session.
 * Runs once per session start — errors are silently ignored.
 * @param currentTeamName - The active team name to preserve, or null
 */
function cleanupStaleTeams(currentTeamName: string | null): void {
	try {
		if (!existsSync(TEAMS_DIR)) return;
		const now = Date.now();
		const currentSafeName = currentTeamName?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? null;

		for (const entry of readdirSync(TEAMS_DIR, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name === currentSafeName) continue;

			const teamPath = join(TEAMS_DIR, entry.name);
			try {
				// Check tasks/ subdir mtime — that's where writes happen
				const tasksPath = join(teamPath, "tasks");
				const target = existsSync(tasksPath) ? tasksPath : teamPath;
				const { mtimeMs } = statSync(target);
				if (now - mtimeMs > TEAM_MAX_AGE_MS) {
					rmSync(teamPath, { recursive: true, force: true });
				}
			} catch {
				// Skip individual failures (permissions, race conditions)
			}
		}
	} catch {
		// TEAMS_DIR doesn't exist or isn't readable — nothing to clean
	}
}

/**
 * Type guard to check if a message is an assistant message.
 * @param m - Message to check
 * @returns True if message is from assistant
 */
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

/**
 * Extracts all text content from an assistant message.
 * @param message - Assistant message to extract from
 * @returns Concatenated text content
 */
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Generates the next sequential task ID from the state counter.
 * @param state - Current tasks state (mutates nextId)
 * @returns Sequential ID string ("1", "2", ...)
 */
function nextTaskId(state: TasksState): string {
	const id = String(state.nextId);
	state.nextId++;
	return id;
}

// Extract tasks from text (numbered lists, checkboxes, etc.)
/**
 * Extract task titles from markdown-style task list text.
 * @internal
 * @param text - Text containing task list items
 * @returns Array of task title strings
 */
export function _extractTasksFromText(text: string): string[] {
	const tasks: string[] = [];

	// Match numbered lists: "1. task", "1) task"
	const numberedRegex = /^\s*(\d+)[.)]\s+(.+)$/gm;
	for (const match of text.matchAll(numberedRegex)) {
		const task = match[2].trim();
		if (task && !task.startsWith("[") && task.length > 3) {
			tasks.push(task);
		}
	}

	// Match checkbox lists: "- [ ] task", "- [x] task", "* [ ] task"
	const checkboxRegex = /^\s*[-*]\s*\[[ x]\]\s+(.+)$/gim;
	for (const match of text.matchAll(checkboxRegex)) {
		const task = match[1].trim();
		if (task && task.length > 3) {
			tasks.push(task);
		}
	}

	// Match "Task:" or "TODO:" headers followed by items
	const taskHeaderRegex = /(?:Tasks?|TODO|To-?do|Steps?):\s*\n((?:\s*[-*\d.]+.+\n?)+)/gi;
	for (const match of text.matchAll(taskHeaderRegex)) {
		const block = match[1];
		const items = block.split("\n").filter((line) => line.trim());
		for (const item of items) {
			const cleaned = item.replace(/^\s*[-*\d.)]+\s*/, "").trim();
			if (cleaned && cleaned.length > 3) {
				tasks.push(cleaned);
			}
		}
	}

	return [...new Set(tasks)]; // Dedupe
}

/**
 * Finds tasks marked as completed in the given text.
 * @internal
 * @param text - Text to search for completion markers
 * @param tasks - Tasks to check for completion
 * @returns Array of completed task IDs
 */
export function findCompletedTasks(text: string, tasks: Task[]): string[] {
	const completed: string[] = [];

	for (const task of tasks) {
		const subjectPrefix = escapeRegex(task.subject.substring(0, 50));
		// Keep matching conservative to avoid accidental completions from generic prose.
		const patterns = [
			new RegExp(`\\[(?:DONE|COMPLETE):?\\s*#?${task.id}\\]`, "i"),
			new RegExp(`completed:\\s*#?${task.id}(?:\\b|\\s|$)`, "i"),
			new RegExp(`\\[(?:DONE|COMPLETE)\\]\\s*(?:completed:\\s*)?${subjectPrefix}`, "i"),
			new RegExp(`completed:\\s*${subjectPrefix}`, "i"),
		];

		for (const pattern of patterns) {
			if (pattern.test(text)) {
				completed.push(task.id);
				break;
			}
		}
	}

	return completed;
}

/**
 * Escapes special regex characters in a string.
 * @internal
 * @param str - String to escape
 * @returns Escaped string safe for use in regex
 */
export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Registers task management tools, commands, and widget.
 * @param pi - Extension API for registering tools, commands, and event handlers
 */
export default function tasksExtension(pi: ExtensionAPI): void {
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

	/**
	 * Render task list lines (left column in side-by-side mode)
	 */
	function renderTaskLines(ctx: ExtensionContext, maxTitleLen: number): string[] {
		if (state.tasks.length === 0) return [];

		const lines: string[] = [];
		const completed = state.tasks.filter((t) => t.status === "completed").length;
		const maxVisible = Math.min(10, state.tasks.length);
		const visibleTasks = state.tasks.slice(0, maxVisible);

		lines.push(ctx.ui.theme.fg("accent", `Tasks (${completed}/${state.tasks.length})`));

		for (let i = 0; i < visibleTasks.length; i++) {
			const task = visibleTasks[i];
			const isLast = i === visibleTasks.length - 1 && state.tasks.length <= maxVisible;
			const treeChar = isLast ? "└─" : "├─";
			let icon: string;
			let textStyle: (s: string) => string;

			// Check if a running agent is actively working on this task.
			// No owner = main agent is working on it (always active while in_progress).
			// With owner = check if that subagent or team teammate is still running.
			const hasActiveAgent = task.owner
				? [...agentIdentities.values()].some((id) => id.displayName === task.owner) ||
					[...(G.__piRunningSubagents?.values() ?? [])].some(
						(s: unknown) => (s as SubagentView).agent === task.owner
					) ||
					[...(G.__piBackgroundSubagents?.values() ?? [])]
						.filter((s: unknown) => (s as SubagentView).status === "running")
						.some((s: unknown) => (s as SubagentView).agent === task.owner) ||
					[...(G.__piActiveTeams?.values() ?? [])]
						.flatMap((t: unknown) => (t as TeamWidgetView).teammates)
						.some((m) => m.name === task.owner && m.status === "working")
				: true;

			switch (task.status) {
				case "completed":
					icon = ctx.ui.theme.fg("success", getIcon("success"));
					textStyle = (s) => ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(s));
					break;
				case "in_progress":
					// Only animate spinner when a real agent is working; otherwise static indicator
					if (hasActiveAgent) {
						icon = ctx.ui.theme.fg("warning", SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]);
					} else {
						icon = ctx.ui.theme.fg("warning", getIcon("in_progress"));
					}
					textStyle = (s) => ctx.ui.theme.fg("accent", s);
					break;
				default:
					icon = getIcon("pending");
					textStyle = (s) => s;
			}

			const label =
				task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;

			// Owner attribution: show (@name) in agent's color
			const ownerSuffix = task.owner
				? ` \x1b[38;5;${colorToAnsi(agentColor(task.owner))}m(@${task.owner})\x1b[0m`
				: "";
			const ownerVisibleLen = task.owner ? 4 + task.owner.length : 0; // " (@name)"
			const titleBudget = Math.max(10, maxTitleLen - ownerVisibleLen);
			const title =
				label.length > titleBudget ? `${label.substring(0, titleBudget - 3)}...` : label;
			lines.push(`${ctx.ui.theme.fg("muted", treeChar)} ${icon} ${textStyle(title)}${ownerSuffix}`);

			// Blocked-by tree: show blocking agent names as sub-tree
			if (task.blockedBy.length > 0 && task.status !== "completed") {
				const contChar = isLast ? " " : "│";
				const blockerNames = task.blockedBy
					.map((depId) => {
						const dep = state.tasks.find((t) => t.id === depId);
						return dep?.owner ? `@${dep.owner}` : `#${depId}`;
					})
					.map((name) => {
						const raw = name.startsWith("@") ? name.slice(1) : "";
						return raw
							? `\x1b[38;5;${colorToAnsi(agentColor(raw))}m${name}\x1b[0m`
							: ctx.ui.theme.fg("muted", name);
					});
				lines.push(
					`${ctx.ui.theme.fg("muted", `${contChar}  └─`)} ${ctx.ui.theme.fg("muted", "blocked by")} ${blockerNames.join(ctx.ui.theme.fg("muted", ", "))}`
				);
			}
		}

		if (state.tasks.length > maxVisible) {
			lines.push(ctx.ui.theme.fg("muted", `└─ ... and ${state.tasks.length - maxVisible} more`));
		}

		return lines;
	}

	/**
	 * Render subagent lines (right column in side-by-side mode, or below tasks in stacked mode)
	 */
	function renderSubagentLines(
		ctx: ExtensionContext,
		spinner: string,
		fgRunning: Array<{ id: string; agent: string; task: string; startTime: number }>,
		bgRunning: Array<{ id: string; agent: string; task: string; startTime: number }>,
		maxTaskPreviewLen: number,
		_standalone: boolean
	): string[] {
		const allRunning = [...fgRunning, ...bgRunning];
		if (allRunning.length === 0) return [];

		const lines: string[] = [];
		const count = allRunning.length;
		lines.push(ctx.ui.theme.fg("accent", `${count} agent${count > 1 ? "s" : ""} launched`));

		for (let i = 0; i < allRunning.length; i++) {
			const sub = allRunning[i];
			const isLast = i === allRunning.length - 1;
			const treeChar = isLast ? "└─" : "├─";
			const contChar = isLast ? " " : "│";
			const color = agentColor(sub.agent);
			const ms = Date.now() - sub.startTime;
			const secs = Math.floor(ms / 1000);
			const duration = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;

			// Line 1: @display-name (TypeLabel) with colored indicator
			const identity = agentIdentities.get(sub.id);
			const displayName = identity?.displayName ?? sub.agent;
			const typeSuffix = identity?.typeLabel
				? ` ${ctx.ui.theme.fg("muted", `(${identity.typeLabel})`)}`
				: "";
			lines.push(
				`${ctx.ui.theme.fg("muted", treeChar)} \x1b[38;5;${colorToAnsi(color)}m${spinner}\x1b[0m \x1b[1;38;5;${colorToAnsi(color)}m@${displayName}\x1b[0m${typeSuffix} ${ctx.ui.theme.fg("muted", `· ${duration}`)}`
			);

			// Line 2: task description (collapse newlines to single line)
			const flatTask = sub.task.replace(/\n+/g, " ").replace(/\s{2,}/g, " ");
			const taskPreview =
				flatTask.length > maxTaskPreviewLen
					? `${flatTask.slice(0, maxTaskPreviewLen - 3)}...`
					: flatTask;
			lines.push(
				`${ctx.ui.theme.fg("muted", `${contChar}  `)} ${ctx.ui.theme.fg("dim", taskPreview)}`
			);

			// Line 3: live activity (if available)
			const activity = agentActivity.get(sub.id);
			if (activity) {
				const activityText =
					activity.summary.length > maxTaskPreviewLen
						? `${activity.summary.slice(0, maxTaskPreviewLen - 3)}...`
						: activity.summary;
				lines.push(
					`${ctx.ui.theme.fg("muted", `${contChar}  `)} ${ctx.ui.theme.fg("warning", activityText)}`
				);
			}
		}

		return lines;
	}

	/**
	 * Maps color names to ANSI 256-color codes.
	 * @param color - Color name string
	 * @returns ANSI 256-color code number
	 */
	function colorToAnsi(color: string): number {
		const map: Record<string, number> = {
			green: 78,
			cyan: 80,
			magenta: 170,
			yellow: 220,
			blue: 75,
			red: 203,
		};
		return map[color] ?? 78;
	}

	/**
	 * Render background bash task lines
	 */
	function renderBgBashLines(ctx: ExtensionContext, maxCmdLen: number): string[] {
		const bgTasksMap = G.__piBackgroundTasks;
		if (!bgTasksMap) return [];

		const running = ([...bgTasksMap.values()] as unknown as BgTaskView[]).filter(
			(t) => t.status === "running"
		);
		if (running.length === 0) return [];

		const lines: string[] = [];
		lines.push(ctx.ui.theme.fg("accent", `Background Tasks (${running.length})`));

		for (let i = 0; i < Math.min(running.length, 5); i++) {
			const task = running[i];
			const isLast = i === Math.min(running.length, 5) - 1 && running.length <= 5;
			const treeChar = isLast ? "└─" : "├─";
			const ms = Date.now() - task.startTime;
			const secs = Math.floor(ms / 1000);
			const duration = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
			// Collapse newlines and truncate to max length
			const flatCmd = task.command.replace(/\n/g, " ↵ ");
			const cmd = flatCmd.length > maxCmdLen ? `${flatCmd.slice(0, maxCmdLen - 3)}...` : flatCmd;
			lines.push(
				`${ctx.ui.theme.fg("muted", treeChar)} ${ctx.ui.theme.fg("accent", getIcon("in_progress"))} ${cmd} ${ctx.ui.theme.fg("muted", `(${duration})`)}`
			);
		}

		if (running.length > 5) {
			lines.push(ctx.ui.theme.fg("muted", `└─ ... and ${running.length - 5} more`));
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
					ctx.ui.theme.fg("success", `Team: ${team.name}`) +
						ctx.ui.theme.fg("success", ` ${getIcon("success")} ${total}/${total} complete`)
				);
			} else {
				lines.push(
					ctx.ui.theme.fg("accent", `Team: ${team.name}`) +
						ctx.ui.theme.fg("muted", ` (${completed}/${total} tasks)`)
				);
			}

			// Teammates with their current task
			for (let i = 0; i < team.teammates.length; i++) {
				const mate = team.teammates[i];
				const isLast = i === team.teammates.length - 1;
				const treeChar = isLast ? "└─" : "├─";
				const color = agentColor(mate.name);
				const colorCode = colorToAnsi(color);

				const statusIcon =
					mate.status === "working"
						? `\x1b[38;5;${colorCode}m${spinner}\x1b[0m`
						: mate.status === "idle"
							? ctx.ui.theme.fg("muted", getIcon("blocked"))
							: ctx.ui.theme.fg("muted", "⏹");

				const taskSuffix = mate.currentTask
					? ` ${ctx.ui.theme.fg("dim", "→")} ${ctx.ui.theme.fg("dim", mate.currentTask.length > maxLen ? `${mate.currentTask.slice(0, maxLen - 3)}...` : mate.currentTask)}`
					: mate.status === "idle"
						? ctx.ui.theme.fg("dim", " (idle)")
						: "";

				lines.push(
					`${ctx.ui.theme.fg("muted", treeChar)} ${statusIcon} \x1b[1;38;5;${colorCode}m@${mate.name}\x1b[0m${taskSuffix}`
				);
			}
		}

		return lines;
	}

	/**
	 * Pad a line to a specific visible width (accounting for ANSI codes)
	 */
	function padToWidth(line: string, targetWidth: number): string {
		const currentWidth = visibleWidth(line);
		if (currentWidth >= targetWidth) {
			return truncateToWidth(line, targetWidth, "");
		}
		return line + " ".repeat(targetWidth - currentWidth);
	}

	/**
	 * Merge two column arrays into side-by-side lines, with right column bottom-aligned.
	 * Both columns are truncated to their allotted widths to prevent overflow.
	 * @param leftLines - Lines for the left column
	 * @param rightLines - Lines for the right column
	 * @param leftWidth - Max visible width for left column
	 * @param separator - Separator string between columns
	 * @param totalWidth - Total terminal width (for right column truncation)
	 */
	function mergeSideBySide(
		leftLines: string[],
		rightLines: string[],
		leftWidth: number,
		separator: string,
		totalWidth: number
	): string[] {
		const separatorWidth = visibleWidth(separator);
		const rightWidth = totalWidth - leftWidth - separatorWidth;
		const maxRows = Math.max(leftLines.length, rightLines.length);
		const result: string[] = [];

		// Bottom-align: pad right column at the top
		const rightPadding = maxRows - rightLines.length;

		for (let i = 0; i < maxRows; i++) {
			const left = leftLines[i] ?? "";
			const rightIndex = i - rightPadding;
			const rawRight = rightIndex >= 0 ? (rightLines[rightIndex] ?? "") : "";
			// Truncate right column to prevent overflow
			const right =
				rightWidth > 0 && visibleWidth(rawRight) > rightWidth
					? truncateToWidth(rawRight, rightWidth, "")
					: rawRight;
			result.push(padToWidth(left, leftWidth) + separator + right);
		}

		return result;
	}

	/**
	 * Update the footer status bar with colored agent names.
	 * Shows: @main @alice @bob · shift+↑ to expand
	 * @param ctx - Extension context for UI access
	 */
	function updateAgentBar(ctx: ExtensionContext): void {
		if (isSubagent) return;

		const fgSubagentsMap = G.__piRunningSubagents;
		const bgSubagentsMap = G.__piBackgroundSubagents;
		const teamsMapBar = G.__piActiveTeams;

		const fgRunning: SubagentView[] = fgSubagentsMap
			? ([...fgSubagentsMap.values()] as unknown as SubagentView[])
			: [];
		const bgRunning = bgSubagentsMap
			? ([...bgSubagentsMap.values()] as unknown as SubagentView[]).filter(
					(s) => s.status === "running"
				)
			: [];
		const allAgents = [...fgRunning, ...bgRunning];

		// Collect team teammate names
		const teamMates: Array<{ name: string; status: string }> = [];
		if (teamsMapBar) {
			for (const tv of (teamsMapBar as Map<string, TeamWidgetView>).values()) {
				for (const m of tv.teammates) {
					if (m.status === "working" || m.status === "idle") {
						teamMates.push(m);
					}
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
		const coloredNames = [...agentNames]
			.map((name) => `\x1b[1;38;5;${colorToAnsi(agentColor(name))}m@${name}\x1b[0m`)
			.join(" ");

		ctx.ui.setStatus(
			"agents",
			`${coloredNames} · ${totalCount} teammate${totalCount > 1 ? "s" : ""}`
		);
	}

	function updateWidget(ctx: ExtensionContext): void {
		// Subagents have no UI — skip all widget rendering
		if (isSubagent) return;
		// Check for foreground (sync) and background subagents
		const fgSubagentsMap = G.__piRunningSubagents;
		const bgSubagentsMap = G.__piBackgroundSubagents;
		const bgTasksMap = G.__piBackgroundTasks;
		const teamsMap = G.__piActiveTeams;

		const fgRunning: SubagentView[] = fgSubagentsMap
			? ([...fgSubagentsMap.values()] as unknown as SubagentView[])
			: [];
		const bgRunning = bgSubagentsMap
			? ([...bgSubagentsMap.values()] as unknown as SubagentView[]).filter(
					(s) => s.status === "running"
				)
			: [];
		const bgTasks = bgTasksMap
			? ([...bgTasksMap.values()] as unknown as BgTaskView[]).filter((t) => t.status === "running")
			: [];
		const activeTeams: TeamWidgetView[] = teamsMap
			? ([...teamsMap.values()] as unknown as TeamWidgetView[])
			: [];

		const hasSubagents = fgRunning.length > 0 || bgRunning.length > 0;
		const hasBgTasks = bgTasks.length > 0;
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
		const bgTaskIds = bgTasks.map((t) => t.id).join(",");
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
						rightLines.push(...renderBgBashLines(ctx, maxCmdLen));
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
					lines.push(...renderBgBashLines(ctx, maxCmdLen));
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

	// ── Store instance (shared or null) ─────────────────────────────

	// Auto-generate a team name so subagents can coordinate via shared directory.
	// Subagents inherit PI_TEAM_NAME from the lead process automatically.
	const teamName =
		process.env.PI_TEAM_NAME ?? (isSubagent ? null : `team-${randomUUID().slice(0, 8)}`);
	if (teamName && !process.env.PI_TEAM_NAME) {
		// Set on process.env so child subagents inherit it automatically
		process.env.PI_TEAM_NAME = teamName;
	}
	const store = new TaskListStore(teamName);

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
	 * @param description - Optional detailed description
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

	// Note: /todos is provided by plan-mode extension, so we don't register it here
	// Use /tasks list instead

	// Register Ctrl+Shift+T shortcut for task list (Ctrl+T is built-in)
	if (!isSubagent)
		pi.registerShortcut(Key.ctrlShift("t"), {
			description: "Toggle task list visibility",
			handler: async (ctx) => toggleVisibility(ctx),
		});

	// Tool for agent to manage tasks programmatically
	pi.registerTool({
		name: "manage_tasks",
		label: "Manage Tasks",
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
						const fgMap = G.__piRunningSubagents;
						const bgMap = G.__piBackgroundSubagents;
						const runningNames = new Set<string>();
						if (fgMap)
							for (const s of fgMap.values())
								runningNames.add((s as unknown as SubagentView).agent);
						if (bgMap) {
							for (const s of bgMap.values()) {
								const sv = s as unknown as SubagentView;
								if (sv.status === "running") runningNames.add(sv.agent);
							}
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

		// Auto-clear stale tasks: if the LLM hasn't touched manage_tasks in
		// STALE_TURN_THRESHOLD turns, no subagents are running, AND tasks are
		// old enough to be considered abandoned. Prevents clearing tasks that
		// were just created but haven't been touched due to long tool calls.
		if (state.tasks.length > 0 && turnsSinceLastTaskTool >= STALE_TURN_THRESHOLD) {
			const fgMap = G.__piRunningSubagents;
			const bgMap = G.__piBackgroundSubagents;
			const hasRunningAgents =
				(fgMap ? fgMap.size > 0 : false) ||
				(bgMap
					? [...bgMap.values()].some(
							(s: unknown) => (s as { status?: string }).status === "running"
						)
					: false);

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

	// Typed global map references set by other extensions.
	// biome-ignore lint/suspicious/noExplicitAny: cross-extension globals have no shared type declarations
	const G = globalThis as any;
	if (!isSubagent && G.__piTasksInterval) {
		clearInterval(G.__piTasksInterval as ReturnType<typeof setInterval>);
	}
	let lastBgCount = 0;
	let lastBgTaskCount = 0;

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
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
		if (state.tasks.length > 0) {
			const orphaned = state.tasks.filter((t) => t.status === "in_progress");
			if (orphaned.length > 0) {
				clearTasks();
			}
		}

		// Clean up team directories older than 7 days
		cleanupStaleTeams(teamName);

		updateWidget(ctx);

		// Register callback for team view changes (called by teams-tool on state mutations/shutdown)
		if (!isSubagent) {
			(globalThis as Record<string, unknown>).__piOnTeamViewChange = () => {
				updateWidget(ctx);
				updateAgentBar(ctx);
			};
		}

		// Start interval to animate subagents and background tasks (main process only)
		if (!isSubagent) {
			if (G.__piTasksInterval) clearInterval(G.__piTasksInterval);
			G.__piTasksInterval = setInterval(() => {
				const fgSubagents = G.__piRunningSubagents;
				const bgSubagents = G.__piBackgroundSubagents;
				const bgTasks = G.__piBackgroundTasks;

				const fgRunning = fgSubagents ? fgSubagents.size : 0;
				const bgRunning = bgSubagents
					? ([...bgSubagents.values()] as unknown as SubagentView[]).filter(
							(s) => s.status === "running"
						).length
					: 0;
				const bgTaskRunning = bgTasks
					? ([...bgTasks.values()] as unknown as BgTaskView[]).filter((t) => t.status === "running")
							.length
					: 0;
				const hasActiveTask = state.tasks.some((t) => t.status === "in_progress");
				const hasWorkingTeammates = G.__piActiveTeams
					? [...(G.__piActiveTeams as Map<string, TeamWidgetView>).values()].some((t) =>
							t.teammates.some((m) => m.status === "working")
						)
					: false;

				const hasRunning =
					fgRunning > 0 ||
					bgRunning > 0 ||
					bgTaskRunning > 0 ||
					hasActiveTask ||
					hasWorkingTeammates;

				// Update on every tick when background items running (for animation), or when count changes
				if (hasRunning || bgRunning !== lastBgCount || bgTaskRunning !== lastBgTaskCount) {
					spinnerFrame++;
					lastBgCount = bgRunning;
					lastBgTaskCount = bgTaskRunning;
					updateWidget(ctx);
					updateAgentBar(ctx);
				}
			}, 200); // Faster interval for smoother animation
			// Clean up previous event listeners on reload
			if (G.__tasksEventCleanup) {
				(G.__tasksEventCleanup as () => void)();
			}

			// Named listeners for subagent events (removable on reload)
			const onSubagentStart = (raw: unknown) => {
				const data = raw as Record<string, unknown>;
				const agentId = String(data.agent_id ?? "");
				const agentType = String(data.agent_type ?? "");
				const task = String(data.task ?? "");
				if (agentId && task) {
					agentIdentities.set(agentId, classifyAgent(task, agentType));
					refineAgentIdentityAsync(agentId, task, () =>
						ctx.modelRegistry.getApiKeyForProvider("anthropic")
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

			G.__tasksEventCleanup = () => {
				unsub1();
				unsub2();
				unsub3();
				unsub4();
			};
		} // end !isSubagent interval guard
	});

	// Cleanup on session end
	pi.on("session_shutdown", async () => {
		store.close();
		persistState();
	});
}
