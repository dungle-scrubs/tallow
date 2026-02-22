/**
 * Teams store — pure logic with no SDK or TUI dependencies.
 *
 * All functions here are deterministic (except timestamps) and can be
 * unit-tested without importing pi-ai, pi-coding-agent, or pi-tui.
 */

import { getIcon } from "../_icons/index.js";

// ════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════

export interface TeamTask {
	id: string;
	title: string;
	description: string;
	status: "pending" | "claimed" | "completed" | "failed";
	assignee: string | null;
	blockedBy: string[];
	result: string | null;
}

export interface TeamMessage {
	from: string;
	to: string; // teammate name or "all"
	content: string;
	timestamp: number;
	readBy: Set<string>;
}

/**
 * Minimal teammate record for the store layer.
 * The full Teammate (with AgentSession) is defined in index.ts.
 */
export interface TeammateRecord {
	name: string;
	role: string;
	model: string;
	status: "idle" | "working" | "shutdown" | "error";
	error?: string;
}

export interface Team<T extends TeammateRecord = TeammateRecord> {
	name: string;
	tasks: TeamTask[];
	teammates: Map<string, T>;
	messages: TeamMessage[];
	taskCounter: number;
}

/** Snapshot of a team at the time it was archived (no live sessions). */
export interface ArchivedTeam {
	name: string;
	tasks: TeamTask[];
	messages: TeamMessage[];
	taskCounter: number;
	archivedAt: number;
}

// ════════════════════════════════════════════════════════════════
// Store (plain Map — single-threaded, no races)
// ════════════════════════════════════════════════════════════════

const teams = new Map<string, Team>();
const archivedTeams = new Map<string, ArchivedTeam>();

/** Default per-team message retention cap (ring-buffer style). */
export const TEAM_MESSAGE_RETENTION_LIMIT_DEFAULT = 256;

/** Max allowed per-team message retention cap from env configuration. */
export const TEAM_MESSAGE_RETENTION_LIMIT_MAX = 5000;

/** Env var for overriding per-team message retention cap. */
export const TEAM_MESSAGE_RETENTION_LIMIT_ENV = "TALLOW_TEAMS_MESSAGE_RETENTION_LIMIT";

/** Env flag that disables retention and keeps full team message histories. */
export const TEAM_MESSAGE_KEEP_FULL_HISTORY_ENV = "TALLOW_TEAMS_KEEP_FULL_HISTORY";

type EnvLookup = Readonly<Record<string, string | undefined>>;

/** @returns The team, or undefined if not found */
export function getTeam(name: string): Team | undefined {
	return teams.get(name);
}

/** @returns The global teams map */
export function getTeams(): Map<string, Team> {
	return teams;
}

/** @returns The global archived teams map */
export function getArchivedTeams(): Map<string, ArchivedTeam> {
	return archivedTeams;
}

/**
 * Create a new team with an empty task board.
 * @param name - Unique team name
 * @returns The created team
 */
export function createTeamStore(name: string): Team {
	const team: Team = {
		name,
		tasks: [],
		teammates: new Map(),
		messages: [],
		taskCounter: 0,
	};
	teams.set(name, team);
	return team;
}

/**
 * Archive a team — snapshot its tasks/messages, remove from active store.
 * Overwrites any previous archive with the same name.
 * @param name - Team name to archive
 * @returns The archived snapshot, or undefined if team not found
 */
export function archiveTeam(name: string): ArchivedTeam | undefined {
	const team = teams.get(name);
	if (!team) return undefined;

	const archived: ArchivedTeam = {
		name: team.name,
		tasks: [...team.tasks],
		messages: [...team.messages],
		taskCounter: team.taskCounter,
		archivedAt: Date.now(),
	};
	archivedTeams.set(name, archived);
	teams.delete(name);
	return archived;
}

/**
 * Restore an archived team into the active store.
 * Creates a fresh Team with the archived tasks/messages but no teammates.
 * @param name - Archived team name to restore
 * @returns The restored team, or undefined if no archive found
 */
export function restoreArchivedTeam(name: string): Team | undefined {
	const archived = archivedTeams.get(name);
	if (!archived) return undefined;

	const team: Team = {
		name: archived.name,
		tasks: [...archived.tasks],
		teammates: new Map(),
		messages: [...archived.messages],
		taskCounter: archived.taskCounter,
	};
	retainRecentTeamMessages(team, getTeamMessageRetentionLimit());
	teams.set(name, team);
	archivedTeams.delete(name);
	return team;
}

/**
 * Format an archived team's status as a readable text block.
 * @param archived - Archived team to format
 * @returns Formatted status string
 */
export function formatArchivedTeamStatus(archived: ArchivedTeam): string {
	const completed = archived.tasks.filter((t) => t.status === "completed").length;
	const failed = archived.tasks.filter((t) => t.status === "failed").length;
	const pending = archived.tasks.filter((t) => t.status === "pending").length;
	const claimed = archived.tasks.filter((t) => t.status === "claimed").length;
	const ago = Math.round((Date.now() - archived.archivedAt) / 1000);
	const agoStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;

	const lines: string[] = [`**${archived.name}** (archived ${agoStr})`];
	lines.push(
		`  ${archived.tasks.length} tasks: ${completed} done, ${failed} failed, ${claimed} in-flight, ${pending} pending`
	);

	for (const t of archived.tasks) {
		const icon =
			t.status === "completed"
				? getIcon("success")
				: t.status === "failed"
					? getIcon("error")
					: t.status === "claimed"
						? getIcon("waiting")
						: getIcon("pending");
		const assignee = t.assignee ? ` → ${t.assignee}` : "";
		lines.push(`  ${icon} #${t.id} ${t.title} [${t.status}]${assignee}`);
		if (t.result) {
			const preview = t.result.length > 120 ? `${t.result.slice(0, 120)}...` : t.result;
			lines.push(`    └─ ${preview}`);
		}
	}

	return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════
// Task board
// ════════════════════════════════════════════════════════════════

/**
 * Add a task to the team's board.
 * @param team - Team to add to
 * @param title - Task title
 * @param description - Task description
 * @param blockedBy - IDs of tasks that must complete first
 * @returns The created task
 */
export function addTaskToBoard(
	team: Team,
	title: string,
	description: string,
	blockedBy: string[]
): TeamTask {
	const id = String(++team.taskCounter);
	const task: TeamTask = {
		id,
		title,
		description,
		status: "pending",
		assignee: null,
		blockedBy,
		result: null,
	};
	team.tasks.push(task);
	return task;
}

/**
 * Check if a task's blockers are all completed and the task is pending.
 * @param team - Team the task belongs to
 * @param task - Task to check
 * @returns true if the task can be claimed
 */
export function isTaskReady(team: Team, task: TeamTask): boolean {
	if (task.status !== "pending") return false;
	return task.blockedBy.every((id) => {
		const blocker = team.tasks.find((t) => t.id === id);
		// Treat missing blockers as satisfied — prevents permanent deadlock
		// from invalid/deleted blocker IDs
		return !blocker || blocker.status === "completed";
	});
}

/**
 * Get all tasks that are ready to be claimed (pending with all blockers completed).
 * @param team - Team to scan
 * @returns Array of ready tasks
 */
export function getReadyTasks(team: Team): TeamTask[] {
	return team.tasks.filter((t) => isTaskReady(team, t));
}

/**
 * Get all teammates with a given status.
 * @param team - Team to scan
 * @param status - Status to filter by
 * @returns Array of matching teammate records
 */
export function getTeammatesByStatus<T extends TeammateRecord>(
	team: Team<T>,
	status: T["status"]
): T[] {
	return Array.from(team.teammates.values()).filter((m) => m.status === status);
}

// ════════════════════════════════════════════════════════════════
// Messaging
// ════════════════════════════════════════════════════════════════

/**
 * Parse truthy env-flag values.
 * @param rawValue - Raw env value
 * @returns true when the value enables a feature
 */
function isTruthyEnvFlag(rawValue: string | undefined): boolean {
	if (!rawValue) return false;
	const normalized = rawValue.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Parse a bounded positive message-retention limit.
 * @param rawValue - Raw env value
 * @returns Parsed retention limit, or undefined when invalid
 */
function parseRetentionLimit(rawValue: string | undefined): number | undefined {
	if (!rawValue) return undefined;
	const parsed = Number.parseInt(rawValue, 10);
	if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return undefined;
	if (parsed < 0) return undefined;
	return Math.min(parsed, TEAM_MESSAGE_RETENTION_LIMIT_MAX);
}

/**
 * Check whether message-retention trimming should be disabled for debugging.
 * @param env - Environment lookup map
 * @returns true when full-history mode is enabled
 */
export function shouldKeepFullTeamMessageHistory(env: EnvLookup = process.env): boolean {
	return isTruthyEnvFlag(env[TEAM_MESSAGE_KEEP_FULL_HISTORY_ENV]);
}

/**
 * Resolve effective team-message retention limit.
 * @param env - Environment lookup map
 * @returns Maximum retained team messages (Infinity when full-history mode is enabled)
 */
export function getTeamMessageRetentionLimit(env: EnvLookup = process.env): number {
	if (shouldKeepFullTeamMessageHistory(env)) {
		return Number.POSITIVE_INFINITY;
	}
	const parsed = parseRetentionLimit(env[TEAM_MESSAGE_RETENTION_LIMIT_ENV]);
	return parsed ?? TEAM_MESSAGE_RETENTION_LIMIT_DEFAULT;
}

/**
 * Enforce ring-buffer retention on a team's message log.
 * @param team - Team whose messages are trimmed in-place
 * @param maxMessages - Maximum retained messages
 * @returns Number of evicted oldest messages
 */
export function retainRecentTeamMessages(team: Team, maxMessages: number): number {
	if (!Number.isFinite(maxMessages)) return 0;
	const safeLimit = Math.max(0, Math.floor(maxMessages));
	const overflow = team.messages.length - safeLimit;
	if (overflow <= 0) return 0;
	team.messages.splice(0, overflow);
	return overflow;
}

/**
 * Add a message to the team's message log.
 * Applies ring-buffer retention to prevent unbounded memory growth.
 *
 * Debug override: set TALLOW_TEAMS_KEEP_FULL_HISTORY=1 to skip trimming.
 * @param team - Team to add message to
 * @param from - Sender name
 * @param to - Recipient name or "all"
 * @param content - Message content
 * @returns The created message
 */
export function addTeamMessage(team: Team, from: string, to: string, content: string): TeamMessage {
	const msg: TeamMessage = { from, to, content, timestamp: Date.now(), readBy: new Set() };
	team.messages.push(msg);
	retainRecentTeamMessages(team, getTeamMessageRetentionLimit());
	return msg;
}

/**
 * Get unread messages for a specific recipient.
 * @param team - Team to search
 * @param recipient - Recipient name
 * @returns Array of unread messages
 */
export function getUnread(team: Team, recipient: string): TeamMessage[] {
	return team.messages.filter(
		(m) => (m.to === recipient || m.to === "all") && !m.readBy.has(recipient)
	);
}

/**
 * Mark all messages addressed to a recipient as read.
 * @param team - Team to update
 * @param recipient - Recipient name
 */
export function markRead(team: Team, recipient: string): void {
	for (const msg of team.messages) {
		if (msg.to === recipient || msg.to === "all") {
			msg.readBy.add(recipient);
		}
	}
}

// ════════════════════════════════════════════════════════════════
// Status formatting
// ════════════════════════════════════════════════════════════════

/**
 * Format a team's status as a readable text block.
 * Pure function — no TUI dependency.
 * @param team - Team to format
 * @returns Formatted status string
 */
export function formatTeamStatus(team: Team): string {
	const sections: string[] = [`# Team: ${team.name}`];

	// Tasks
	sections.push("\n## Tasks");
	if (team.tasks.length === 0) {
		sections.push("(none)");
	} else {
		for (const t of team.tasks) {
			const ready = isTaskReady(team, t);
			const icon =
				t.status === "completed"
					? getIcon("success")
					: t.status === "failed"
						? getIcon("error")
						: t.status === "claimed"
							? getIcon("waiting")
							: ready
								? getIcon("idle")
								: "◌";
			const assignee = t.assignee ? ` → ${t.assignee}` : "";
			const blocked =
				t.blockedBy.length > 0 && t.status === "pending"
					? ` [blocked by: ${t.blockedBy.join(", ")}]`
					: "";
			sections.push(`${icon} #${t.id} ${t.title} [${t.status}]${assignee}${blocked}`);
			if (t.result) {
				const preview = t.result.length > 200 ? `${t.result.slice(0, 200)}...` : t.result;
				sections.push(`  └─ ${preview}`);
			}
		}
	}

	// Teammates
	sections.push("\n## Teammates");
	if (team.teammates.size === 0) {
		sections.push("(none)");
	} else {
		for (const [, mate] of team.teammates) {
			const icon =
				mate.status === "idle"
					? "💤"
					: mate.status === "working"
						? getIcon("active")
						: mate.status === "error"
							? "❌"
							: "⏹️";
			sections.push(`${icon} ${mate.name} (${mate.model}) [${mate.status}] — ${mate.role}`);
			if (mate.error) sections.push(`  └─ Error: ${mate.error}`);
		}
	}

	// Recent messages
	const recent = team.messages.slice(-10);
	if (recent.length > 0) {
		sections.push("\n## Recent Messages");
		for (const m of recent) {
			const preview = m.content.length > 100 ? `${m.content.slice(0, 100)}...` : m.content;
			sections.push(`${m.from} → ${m.to}: ${preview}`);
		}
	}

	return sections.join("\n");
}
