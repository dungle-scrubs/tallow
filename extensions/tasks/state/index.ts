/**
 * Task domain types, state helpers, and persistent file-backed store.
 *
 * Contains the core data model ({@link Task}, {@link TaskStatus}), the
 * {@link TaskListStore} for cross-session file persistence with directory
 * locking and `fs.watch`, and pure predicates that operate on task arrays.
 */

import type { FSWatcher } from "node:fs";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	watch,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { atomicWriteFileSync } from "../../_shared/atomic-write.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Directory root for team-based shared task lists. */
export const TEAMS_DIR = join(homedir(), ".tallow", "teams");

/** Max age for team directories before cleanup (7 days in ms). */
export const TEAM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum width for side-by-side layout (tasks left, subagents right). */
export const MIN_SIDE_BY_SIDE_WIDTH = 120;

// ── Task Types ───────────────────────────────────────────────────────────────

/** Lifecycle state of a task. */
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/** A comment attached to a task for cross-session context. */
export interface TaskComment {
	author: string;
	content: string;
	timestamp: number;
}

/**
 * A single task with subject, description, bidirectional deps, and comments.
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

/** Complete tasks widget state including visibility and active task tracking. */
export interface TasksState {
	tasks: Task[];
	visible: boolean;
	activeTaskId: string | null;
	/** Next sequential ID counter. */
	nextId: number;
}

// ── Interop View Types (typed cross-extension contracts) ─────────────────────

export type {
	InteropBackgroundTaskView as BgTaskView,
	InteropSubagentView as SubagentView,
	InteropTeamView as TeamWidgetView,
} from "../../_shared/interop-events.js";

// ── Pure predicates ──────────────────────────────────────────────────────────

/**
 * Determine whether the task list should be cleared on agent_end.
 *
 * Returns `true` when any task is still `in_progress` — indicating the agent
 * was interrupted mid-work and the tasks are orphaned.
 *
 * @param tasks - Current task list
 * @returns `true` if the list should be cleared
 */
export function shouldClearOnAgentEnd(tasks: readonly Task[]): boolean {
	return tasks.some((t) => t.status === "in_progress");
}

/**
 * Generates the next sequential task ID from the state counter.
 *
 * Mutates `state.nextId` as a side-effect.
 *
 * @param state - Current tasks state (mutates nextId)
 * @returns Sequential ID string ("1", "2", ...)
 */
export function nextTaskId(state: TasksState): string {
	const id = String(state.nextId);
	state.nextId++;
	return id;
}

// ── Message helpers ──────────────────────────────────────────────────────────

/**
 * Type guard to check if a message is an assistant message.
 *
 * @param m - Message to check
 * @returns `true` if message has `role === "assistant"` with array content
 */
export function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

/**
 * Extracts all text content from an assistant message.
 *
 * @param message - Assistant message to extract from
 * @returns Concatenated text content
 */
export function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ── TaskListStore ────────────────────────────────────────────────────────────

/**
 * Persistent, file-backed task store for cross-session sharing.
 *
 * Each team gets a directory at `~/.tallow/teams/{team-name}/tasks/` containing
 * one JSON file per task.  `fs.watch` on the directory detects changes from
 * other sessions sharing the same team.
 *
 * Without a team name, this store is inactive and the extension falls back
 * to session-entry persistence.
 */
export class TaskListStore {
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
	 *
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
	 * Acquire a directory-based lock for the task store.
	 *
	 * Uses `mkdirSync` which is atomic on POSIX — fails if dir exists.
	 * Spins with exponential backoff up to ~1 s, then proceeds unlocked.
	 *
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
			// Stale lock? Check age — force remove if older than 5 s
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
	 *
	 * @param task - Task to persist
	 */
	saveTask(task: Task): void {
		if (!this.dirPath) return;

		const filename = `${task.id}.json`;
		const filePath = join(this.dirPath, filename);
		const unlock = this.lock();

		try {
			this.recentWrites.add(filename);
			atomicWriteFileSync(filePath, JSON.stringify(task, null, 2));
			setTimeout(() => this.recentWrites.delete(filename), 200);
		} catch {
			this.recentWrites.delete(filename);
			// Silent — state still in session entries
		} finally {
			unlock();
		}
	}

	/**
	 * Delete a task file.
	 *
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
	 *
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
 * Remove team directories older than {@link TEAM_MAX_AGE_MS}.
 *
 * Skips the current team (if any) to avoid deleting an active session.
 * Runs once per session start — errors are silently ignored.
 *
 * @param currentTeamName - The active team name to preserve, or null
 */
export function cleanupStaleTeams(currentTeamName: string | null): void {
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
