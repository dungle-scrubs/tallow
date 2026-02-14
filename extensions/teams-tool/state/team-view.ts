/**
 * Team view builders and pure helpers for teammate state queries.
 * No side effects — all functions are referentially transparent.
 */

import { getModels, getProviders } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { getTeam, type Team, type TeamTask } from "../store.js";
import type { Teammate, TeamView } from "./types.js";

/**
 * Build a serializable snapshot of a team for widget rendering.
 * @param team - Runtime team with full Teammate objects
 * @returns Lightweight view safe for cross-extension consumption
 */
export function buildTeamView(team: Team<Teammate>): TeamView {
	return {
		name: team.name,
		tasks: team.tasks.map((t) => ({
			assignee: t.assignee,
			blockedBy: t.blockedBy,
			id: t.id,
			status: t.status,
			title: t.title,
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

/**
 * Count tasks assigned to one teammate in a target lifecycle status.
 * @param team - Team containing task board
 * @param teammateName - Teammate name
 * @param status - Task status to count
 * @returns Number of matching tasks
 */
export function getTaskCountByAssigneeStatus(
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
export function getCurrentTaskTitle(team: Team<Teammate>, teammateName: string): string | null {
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
export function getUnreadInboxCount(team: Team<Teammate>, teammateName: string): number {
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
export function getRecentMessageLinks(team: Team<Teammate>): string[] {
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

/** Type-safe accessor: at runtime, teammates always have a session. */
export function getRuntimeTeam(name: string): Team<Teammate> | undefined {
	return getTeam(name) as Team<Teammate> | undefined;
}

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
