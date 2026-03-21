/**
 * Tasks Extension for Pi
 *
 * Task management with cross-session persistence:
 * - Three states: pending (☐), in-progress (◉), completed (☑)
 * - Bidirectional dependency tracking (blocks/blockedBy)
 * - Comments for cross-session handoff context
 * - Shared task groups via ~/.tallow/task-groups/{group-name}/tasks/
 * - Multi-session coordination via fs.watch
 * - One file per task (avoids write conflicts)
 * - Status widget with dynamic sizing
 * - Ctrl+Shift+T to toggle visibility
 * - /tasks command to view/manage
 *
 * NOTE: This extension only runs in the main Pi process, not in subagent workers.
 *
 * This file is the composition root: it constructs shared infrastructure
 * (shared task-group name, file store) and delegates all registration to
 * {@link registerTasksExtension}.  Domain logic lives in sibling modules.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTasksExtension } from "./commands/register-tasks-extension.js";
import { TaskListStore } from "./state/index.js";

// ── Re-exports for backwards compatibility ───────────────────────────────────
// Tests and any future consumers import from this file.

export type { AgentIdentity } from "./agents/index.js";
export { classifyAgent } from "./agents/index.js";
export { _extractTasksFromText, escapeRegex, findCompletedTasks } from "./parsing/index.js";
export type { Task, TaskComment, TaskStatus, TasksState } from "./state/index.js";
export { buildSessionTaskGroupName, shouldClearOnAgentEnd } from "./state/index.js";

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Extension entry point — wires the store and delegates to the registration module.
 *
 * @param pi - Extension API provided by the framework
 */
export default function tasksExtension(pi: ExtensionAPI): void {
	const isSubagent = process.env.PI_IS_SUBAGENT === "1";
	const teamName = isSubagent ? (process.env.PI_TEAM_NAME ?? null) : null;
	const store = new TaskListStore(teamName);
	registerTasksExtension(pi, store, teamName);
}
