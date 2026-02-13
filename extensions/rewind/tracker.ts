/**
 * File Modification Tracker
 *
 * Tracks which files are modified per conversation turn by intercepting
 * tool_result events for edit and write tools. Bash commands are tracked
 * indirectly via git diff at turn boundaries in the snapshot manager.
 */

/** Recorded modification for a single file in a turn. */
export interface FileModification {
	path: string;
	toolName: string;
}

/** Summary of files modified in a completed turn. */
export interface TurnRecord {
	turnIndex: number;
	files: string[];
	timestamp: number;
}

/** Minimal tool_result event shape needed by the tracker. */
export interface ToolResultInput {
	toolName: string;
	input: Record<string, unknown>;
	isError: boolean;
}

/** Persisted snapshot entry stored via pi.appendEntry(). */
export interface RewindSnapshotEntry {
	turnIndex: number;
	ref: string;
	files: string[];
	timestamp: number;
}

/** Tools that produce file modifications we can track by path. */
const WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * Accumulates file modifications per conversation turn.
 *
 * Only tracks edit/write tools where the input.path field gives the modified
 * file path. Bash tool modifications are captured via git diff at turn
 * boundaries (handled by SnapshotManager).
 */
export class FileTracker {
	/** Files modified in the current (not yet advanced) turn. */
	private currentTurnFiles = new Set<string>();

	/** Completed turns with their file lists. */
	private turns = new Map<number, TurnRecord>();

	/**
	 * Records a file modification from a tool_result event.
	 *
	 * @param event - Minimal tool result data (toolName, input, isError)
	 */
	onToolResult(event: ToolResultInput): void {
		if (event.isError) return;
		if (!WRITE_TOOLS.has(event.toolName)) return;

		const filePath = event.input.path;
		if (typeof filePath !== "string" || filePath.length === 0) return;

		this.currentTurnFiles.add(filePath);
	}

	/**
	 * Advances to the next turn, storing the current turn's files.
	 *
	 * @param turnIndex - The turn index being completed
	 * @returns The files modified in the completed turn
	 */
	advanceTurn(turnIndex: number): string[] {
		const files = [...this.currentTurnFiles];
		if (files.length > 0) {
			this.turns.set(turnIndex, {
				turnIndex,
				files,
				timestamp: Date.now(),
			});
		}
		this.currentTurnFiles = new Set();
		return files;
	}

	/**
	 * Returns files modified in the current (incomplete) turn.
	 *
	 * @returns Array of file paths
	 */
	getFilesForCurrentTurn(): string[] {
		return [...this.currentTurnFiles];
	}

	/**
	 * Returns files modified in a specific completed turn.
	 *
	 * @param turnIndex - Turn to query
	 * @returns Array of file paths, empty if turn not found
	 */
	getFilesForTurn(turnIndex: number): string[] {
		return this.turns.get(turnIndex)?.files ?? [];
	}

	/**
	 * Returns all completed turn records, ordered by turn index.
	 *
	 * @returns Array of TurnRecord objects
	 */
	getAllTurns(): TurnRecord[] {
		return [...this.turns.values()].sort((a, b) => a.turnIndex - b.turnIndex);
	}

	/**
	 * Returns whether there are any tracked modifications in the current turn.
	 *
	 * @returns True if files were modified in the current turn
	 */
	hasCurrentTurnChanges(): boolean {
		return this.currentTurnFiles.size > 0;
	}

	/**
	 * Restores tracker state from persisted snapshot entries.
	 * Called on session_start to rebuild from appendEntry data.
	 *
	 * @param entries - Previously persisted RewindSnapshotEntry objects
	 */
	restoreFromEntries(entries: RewindSnapshotEntry[]): void {
		for (const entry of entries) {
			this.turns.set(entry.turnIndex, {
				turnIndex: entry.turnIndex,
				files: entry.files,
				timestamp: entry.timestamp,
			});
		}
	}

	/**
	 * Resets all tracker state. Used for testing or session cleanup.
	 */
	reset(): void {
		this.currentTurnFiles = new Set();
		this.turns = new Map();
	}
}
