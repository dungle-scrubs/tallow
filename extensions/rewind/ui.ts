/**
 * Turn Selector UI
 *
 * Presents a list of available snapshot turns for the user to pick from.
 * Uses ctx.ui.select() with formatted option strings showing turn number,
 * file count, and file names.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/** Data for a single selectable turn in the UI. */
export interface TurnOption {
	turnIndex: number;
	ref: string;
	files: string[];
	timestamp: number;
}

/** Maximum file names to show per turn in the selector. */
const MAX_FILES_SHOWN = 3;

/**
 * Formats a turn option into a display string for the selector.
 *
 * Format: "Turn N — M file(s): a.ts, b.ts, c.ts [+2 more]"
 *
 * @param turn - Turn data to format
 * @returns Formatted string for display
 */
function formatTurnOption(turn: TurnOption): string {
	const parts: string[] = [`Turn ${turn.turnIndex}`];

	if (turn.files.length > 0) {
		const shown = turn.files.slice(0, MAX_FILES_SHOWN);
		const remainder = turn.files.length - shown.length;
		let fileList = shown.join(", ");
		if (remainder > 0) {
			fileList += ` [+${remainder} more]`;
		}
		parts.push(`${turn.files.length} file(s): ${fileList}`);
	} else {
		parts.push("(git diff snapshot only)");
	}

	if (turn.timestamp > 0) {
		const relative = formatRelativeTime(turn.timestamp);
		parts.push(relative);
	}

	return parts.join(" — ");
}

/**
 * Formats a timestamp as a human-readable relative time string.
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Relative time string (e.g. "2m ago", "1h ago")
 */
function formatRelativeTime(timestamp: number): string {
	const delta = Date.now() - timestamp;
	const seconds = Math.floor(delta / 1000);

	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Shows the turn selector UI and returns the user's choice.
 *
 * Presents turns in reverse chronological order (most recent first)
 * so the most likely rollback target is at the top.
 *
 * @param ctx - Extension context with UI access
 * @param turns - Available turns to select from
 * @returns Selected turn data, or undefined if cancelled
 */
export async function showTurnSelector(
	ctx: ExtensionContext,
	turns: TurnOption[]
): Promise<TurnOption | undefined> {
	// Show most recent turns first
	const sorted = [...turns].sort((a, b) => b.turnIndex - a.turnIndex);
	const options = sorted.map(formatTurnOption);

	const choice = await ctx.ui.select("Rewind to which turn?", options);
	if (!choice) return undefined;

	// Find the selected turn by matching the formatted string
	const selectedIndex = options.indexOf(choice);
	if (selectedIndex === -1) return undefined;

	return sorted[selectedIndex];
}
