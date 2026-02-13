/**
 * Rewind Extension
 *
 * Tracks file modifications per conversation turn and creates git snapshots
 * at turn boundaries. Provides `/rewind` to roll back file changes to any
 * previous turn's state.
 *
 * Architecture:
 * - FileTracker: intercepts tool_result for edit/write → accumulates file paths per turn
 * - SnapshotManager: creates/restores git refs at refs/tallow/rewind/<session-id>/turn-<N>
 * - Session entries: persists snapshot metadata via pi.appendEntry("rewind-snapshot", ...)
 *
 * Requires git in the working directory. Silently disables when not in a git repo.
 */

import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SnapshotManager } from "./snapshots.js";
import type { RewindSnapshotEntry } from "./tracker.js";
import { FileTracker } from "./tracker.js";
import { showTurnSelector } from "./ui.js";

/** Custom entry type for persisted snapshot data. */
const SNAPSHOT_ENTRY_TYPE = "rewind-snapshot";

/**
 * Registers the rewind extension: file tracking, git snapshots, and /rewind command.
 *
 * @param pi - Extension API for registering event handlers and commands
 */
export default function rewind(pi: ExtensionAPI): void {
	const tracker = new FileTracker();
	let snapshots: SnapshotManager | null = null;
	let enabled = false;
	let ctx: ExtensionContext | null = null;

	// ── Session lifecycle ────────────────────────────────────────

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		const sessionId = context.sessionManager.getSessionId();
		const mgr = new SnapshotManager(context.cwd, sessionId);

		if (!mgr.isGitRepo()) {
			enabled = false;
			snapshots = null;
			return;
		}

		enabled = true;
		snapshots = mgr;
		tracker.reset();

		// Restore tracker state from persisted session entries
		const entries = context.sessionManager.getEntries();
		const snapshotEntries = entries
			.filter(
				(e): e is CustomEntry<RewindSnapshotEntry> =>
					e.type === "custom" && (e as CustomEntry).customType === SNAPSHOT_ENTRY_TYPE
			)
			.map((e) => e.data)
			.filter((d): d is RewindSnapshotEntry => d != null);

		if (snapshotEntries.length > 0) {
			tracker.restoreFromEntries(snapshotEntries);
		}
	});

	pi.on("session_shutdown", async () => {
		// Refs persist in git — no cleanup on shutdown.
		// Users who want cleanup can run: git for-each-ref refs/tallow/ --format="%(refname)" | xargs -n1 git update-ref -d
		enabled = false;
		snapshots = null;
		ctx = null;
	});

	// ── File tracking ────────────────────────────────────────────

	pi.on("tool_result", async (event) => {
		if (!enabled) return;

		tracker.onToolResult({
			toolName: event.toolName,
			input: event.input,
			isError: event.isError,
		});
	});

	// ── Snapshot creation at turn boundaries ─────────────────────

	pi.on("turn_end", async (event) => {
		if (!enabled || !snapshots) return;

		const turnIndex = event.turnIndex;
		const files = tracker.advanceTurn(turnIndex);

		// Create snapshot regardless of tracked files — bash commands may
		// have modified files that we didn't track via edit/write tools.
		const ref = snapshots.createSnapshot(turnIndex);
		if (!ref) return;

		// Persist snapshot metadata in the session
		const entry: RewindSnapshotEntry = {
			turnIndex,
			ref,
			files,
			timestamp: Date.now(),
		};

		pi.appendEntry(SNAPSHOT_ENTRY_TYPE, entry);
	});

	// ── Context injection ────────────────────────────────────────

	pi.on("before_agent_start", async () => {
		if (!enabled || !snapshots) return;

		const snapshotList = snapshots.listSnapshots();
		if (snapshotList.length === 0) return;

		return {
			message: {
				customType: "rewind-context",
				content:
					"The user can run /rewind to undo all file changes back to a previous conversation turn. " +
					`There are ${snapshotList.length} snapshot(s) available.`,
				display: false,
			},
		};
	});

	// ── /rewind command ──────────────────────────────────────────

	pi.registerCommand("rewind", {
		description: "Undo file changes by rolling back to a previous conversation turn",
		handler: async (_args, cmdCtx) => {
			if (!enabled || !snapshots || !ctx) {
				cmdCtx.ui.notify("Rewind requires a git repository.", "error");
				return;
			}

			const snapshotList = snapshots.listSnapshots();
			if (snapshotList.length === 0) {
				cmdCtx.ui.notify("Nothing to rewind — no snapshots available.", "warning");
				return;
			}

			// Build turn data for the selector
			const turnData = snapshotList.map((snap) => {
				const entry = tracker.getAllTurns().find((t) => t.turnIndex === snap.turnIndex);
				return {
					turnIndex: snap.turnIndex,
					ref: snap.ref,
					files: entry?.files ?? [],
					timestamp: entry?.timestamp ?? 0,
				};
			});

			// Show turn selector UI
			const selected = await showTurnSelector(cmdCtx, turnData);
			if (!selected) return;

			// Confirmation
			const fileCount = selected.files.length;
			const confirmed = await cmdCtx.ui.confirm(
				"Rewind",
				`Roll back to turn ${selected.turnIndex}? ` +
					`${fileCount > 0 ? `${fileCount} tracked file(s) were modified in that turn. ` : ""}` +
					"This will restore the working tree to that point and delete files created after it."
			);

			if (!confirmed) {
				cmdCtx.ui.notify("Rewind cancelled.", "info");
				return;
			}

			// Execute rollback
			cmdCtx.ui.setWorkingMessage("Rewinding...");

			try {
				const result = snapshots.restoreSnapshot(selected.ref);

				cmdCtx.ui.setWorkingMessage();
				const parts: string[] = [];
				if (result.restored.length > 0) {
					parts.push(`${result.restored.length} file(s) restored`);
				}
				if (result.deleted.length > 0) {
					parts.push(`${result.deleted.length} file(s) removed`);
				}

				cmdCtx.ui.notify(
					`Rewound to turn ${selected.turnIndex}: ${parts.join(", ") || "no changes needed"}.`,
					"info"
				);
			} catch (err) {
				cmdCtx.ui.setWorkingMessage();
				const message = err instanceof Error ? err.message : String(err);
				cmdCtx.ui.notify(`Rewind failed: ${message}`, "error");
			}
		},
	});
}
