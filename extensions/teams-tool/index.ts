/**
 * Teams Extension — thin composition root.
 *
 * Runtime orchestration lives in {@link registerTeamsToolExtension}. This file
 * intentionally only wires the runtime and re-exports public domain APIs used
 * by tests and external consumers.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTeamsToolExtension } from "./tools/register-extension.js";

export { autoDispatch, wakeTeammate } from "./dispatch/auto-dispatch.js";
export { spawnTeammateSession } from "./sessions/spawn.js";
export {
	buildTeamView,
	findModel,
	getLastOutput,
	resolveStandardTools,
} from "./state/team-view.js";
// Domain exports
export type { Teammate, TeamView } from "./state/types.js";
// Store exports (backward compatibility)
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
export { createTeammateTools } from "./tools/teammate-tools.js";

/**
 * Register teams-tool runtime with the extension API.
 *
 * @param pi - Extension API instance
 * @returns void
 */
export default function teamsToolExtension(pi: ExtensionAPI): void {
	registerTeamsToolExtension(pi);
}
