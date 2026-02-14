/**
 * Auto-dispatch logic — assigns ready tasks to idle teammates
 * and wakes idle teammates on events.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	appendDashboardFeedEvent,
	getDashboardActivity,
	notifyDashboardChanged,
	refreshTeamView,
} from "../dashboard/state.js";
import { getRuntimeTeam } from "../state/team-view.js";
import type { Teammate } from "../state/types.js";
import { getReadyTasks, getTeammatesByStatus, type Team } from "../store.js";

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

	const dashboardActivity = getDashboardActivity();

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
