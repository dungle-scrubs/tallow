/**
 * Teams store — pure logic with no SDK or TUI dependencies.
 *
 * All functions here are deterministic (except timestamps) and can be
 * unit-tested without importing pi-ai, pi-coding-agent, or pi-tui.
 */

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

// ════════════════════════════════════════════════════════════════
// Store (plain Map — single-threaded, no races)
// ════════════════════════════════════════════════════════════════

const teams = new Map<string, Team>();

/** @returns The team, or undefined if not found */
export function getTeam(name: string): Team | undefined {
	return teams.get(name);
}

/** @returns The global teams map */
export function getTeams(): Map<string, Team> {
	return teams;
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
		return blocker?.status === "completed";
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
 * Add a message to the team's message log.
 * @param team - Team to add message to
 * @param from - Sender name
 * @param to - Recipient name or "all"
 * @param content - Message content
 * @returns The created message
 */
export function addTeamMessage(team: Team, from: string, to: string, content: string): TeamMessage {
	const msg: TeamMessage = { from, to, content, timestamp: Date.now(), readBy: new Set() };
	team.messages.push(msg);
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
					? "✓"
					: t.status === "failed"
						? "✗"
						: t.status === "claimed"
							? "⏳"
							: ready
								? "○"
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
						? "⚡"
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
