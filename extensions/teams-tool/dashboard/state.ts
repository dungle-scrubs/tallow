/**
 * Dashboard state management — module-level singletons for team view snapshots,
 * activity tracking, and feed event streams.
 */

import type { Usage } from "@mariozechner/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { emitInteropEvent, INTEROP_EVENT_NAMES } from "../../_shared/interop-events.js";
import {
	TeamDashboardActivityStore,
	type TeamDashboardFeedItem,
	type TeamDashboardSnapshot,
	type TeamDashboardTeam,
	type TeamDashboardTeammate,
} from "../dashboard.js";
import {
	buildTeamView,
	getCurrentTaskTitle,
	getRecentMessageLinks,
	getTaskCountByAssigneeStatus,
	getUnreadInboxCount,
} from "../state/team-view.js";
import type { Teammate, TeamView } from "../state/types.js";
import { getTeams, type Team } from "../store.js";
import {
	DASHBOARD_FEED_MAX_ITEMS,
	shouldSuppressDashboardFeedEvent,
	summarizeFeedMessage,
} from "./feed.js";

// ════════════════════════════════════════════════════════════════
// Module-level state
// ════════════════════════════════════════════════════════════════

/** Global map of active team views. */
const activeTeamViews = new Map<string, TeamView>();

/** Rolling activity store for dashboard card data. */
const dashboardActivity = new TeamDashboardActivityStore();

/** Rolling event feed displayed in the dashboard sidebar, keyed by team name. */
const dashboardFeedByTeam = new Map<string, TeamDashboardFeedItem[]>();

/** Shared interop event bus reference for module-level publishers. */
let interopEvents: ExtensionAPI["events"] | undefined;

/** Dashboard render callback owned by the active TeamDashboardEditor instance. */
let dashboardRenderCallback: (() => void) | undefined;

/** Cross-extension flag for whether Team Dashboard mode is active. */
let dashboardActiveState = false;

// ════════════════════════════════════════════════════════════════
// Interop and render callback accessors
// ════════════════════════════════════════════════════════════════

/**
 * Set the interop event bus reference.
 * @param events - Extension event emitter
 */
export function setInteropEvents(events: ExtensionAPI["events"] | undefined): void {
	interopEvents = events;
}

/**
 * Set the dashboard render callback.
 * @param cb - Render callback or undefined to clear
 */
export function setDashboardRenderCallback(cb: (() => void) | undefined): void {
	dashboardRenderCallback = cb;
}

/**
 * Get the current dashboard active state flag.
 * @returns Current dashboard active state
 */
export function getDashboardActiveState(): boolean {
	return dashboardActiveState;
}

/**
 * Update the dashboard active state flag.
 * @param active - New active state
 */
export function setDashboardActiveState(active: boolean): void {
	dashboardActiveState = active;
}

/**
 * Get the dashboard activity store singleton.
 * @returns Activity store instance
 */
export function getDashboardActivity(): TeamDashboardActivityStore {
	return dashboardActivity;
}

// ════════════════════════════════════════════════════════════════
// Publishing
// ════════════════════════════════════════════════════════════════

/**
 * Publish latest team snapshots for typed cross-extension consumers.
 * @returns void
 */
export function publishTeamSnapshots(): void {
	if (!interopEvents) return;
	emitInteropEvent(interopEvents, INTEROP_EVENT_NAMES.teamsSnapshot, {
		teams: [...activeTeamViews.values()],
	});
}

/**
 * Publish current dashboard visibility state for cross-extension consumers.
 * @returns void
 */
export function publishDashboardState(): void {
	if (!interopEvents) return;
	emitInteropEvent(interopEvents, INTEROP_EVENT_NAMES.teamDashboardState, {
		active: dashboardActiveState,
	});
}

// ════════════════════════════════════════════════════════════════
// Notifications
// ════════════════════════════════════════════════════════════════

/**
 * Notify cross-extension consumers that team snapshots changed.
 */
export function notifyTeamViewChanged(): void {
	publishTeamSnapshots();
}

/**
 * Notify the team dashboard editor that render data changed.
 */
export function notifyDashboardChanged(): void {
	dashboardRenderCallback?.();
}

// ════════════════════════════════════════════════════════════════
// Team view management
// ════════════════════════════════════════════════════════════════

/**
 * Refresh the global team view snapshot for a given team.
 * Called after any state mutation (task claimed/completed, teammate status change).
 * @param team - Runtime team to snapshot
 */
export function refreshTeamView(team: Team<Teammate>): void {
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
 * Notifies consumers to refresh widget and agent bar.
 * @param teamName - Team name to remove
 */
export function removeTeamView(teamName: string): void {
	activeTeamViews.delete(teamName);
	dashboardActivity.clearTeam(teamName);
	clearDashboardFeedEvents(teamName);
	notifyTeamViewChanged();
	notifyDashboardChanged();
}

// ════════════════════════════════════════════════════════════════
// Feed events
// ════════════════════════════════════════════════════════════════

/**
 * Append an event line to a team's dashboard feed.
 * @param teamName - Team that owns the feed stream
 * @param from - Event actor label
 * @param to - Event target label
 * @param content - Event text payload
 * @returns void
 */
export function appendDashboardFeedEvent(
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
export function getDashboardFeedEvents(teamName: string): TeamDashboardFeedItem[] {
	const feed = dashboardFeedByTeam.get(teamName) ?? [];
	return [...feed];
}

/**
 * Remove all dashboard feed events for a team.
 * @param teamName - Team that owns the feed stream
 * @returns void
 */
export function clearDashboardFeedEvents(teamName: string): void {
	dashboardFeedByTeam.delete(teamName);
}

// ════════════════════════════════════════════════════════════════
// Dashboard snapshot
// ════════════════════════════════════════════════════════════════

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
export function buildDashboardSnapshot(): TeamDashboardSnapshot {
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

// ════════════════════════════════════════════════════════════════
// Session event tracking
// ════════════════════════════════════════════════════════════════

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
 * @returns Unsubscribe function
 */
export function bindDashboardSessionTracking(
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
