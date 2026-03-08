/**
 * Windowed Turn Selector Component
 *
 * A custom UI component for selecting a turn to rewind to. Uses windowed
 * rendering so lists longer than the terminal viewport remain navigable.
 * Renders only the visible slice of items, with scroll indicators when the
 * list is clipped.
 */

import { DynamicBorder, type Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { TurnOption } from "./ui.js";

/** Chrome lines consumed by title, hint, borders, and padding. */
const CHROME_LINES = 6;

/**
 * Result type returned by the turn selector. `null` means cancelled.
 */
export type TurnSelectorResult = TurnOption | null;

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
export function formatTurnOption(turn: TurnOption): string {
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
export function formatRelativeTime(timestamp: number): string {
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
 * Creates a windowed turn selector for use with `ctx.ui.custom()`.
 *
 * The factory returns `{ render, handleInput, invalidate }` as required
 * by the custom UI contract. The selector:
 * - Shows only a window of items that fits within terminal height
 * - Scrolls the window to keep the selected item centered
 * - Wraps selection at boundaries (top ↔ bottom)
 * - Shows scroll indicators ("↑ N more" / "↓ N more") when clipped
 *
 * @param turns - Available turns to display (already sorted)
 * @param labels - Pre-formatted label for each turn (parallel array)
 * @param terminalRows - Terminal height in rows
 * @param theme - UI theme for colors
 * @param done - Callback to signal completion
 * @returns Custom component descriptor
 */
export function createTurnSelector(
	turns: TurnOption[],
	labels: string[],
	terminalRows: number,
	theme: Theme,
	done: (result: TurnSelectorResult) => void
): {
	render: (width: number) => string[];
	handleInput: (data: string) => void;
	invalidate: () => void;
} {
	let selectedIndex = 0;
	let cachedLines: string[] | undefined;
	let cachedWidth: number | undefined;

	const maxVisible = Math.max(3, terminalRows - CHROME_LINES);

	/**
	 * Calculates the visible window range centered on the selected index.
	 *
	 * @returns [startIndex, endIndex) tuple
	 */
	function windowRange(): [number, number] {
		if (turns.length <= maxVisible) {
			return [0, turns.length];
		}

		// Center selected item in the window
		let start = selectedIndex - Math.floor(maxVisible / 2);
		start = Math.max(0, Math.min(start, turns.length - maxVisible));
		return [start, start + maxVisible];
	}

	/**
	 * Renders the selector into an array of terminal lines.
	 *
	 * @param width - Available terminal width
	 * @returns Array of rendered lines
	 */
	function render(width: number): string[] {
		if (cachedLines && cachedWidth === width) return cachedLines;

		const lines: string[] = [];
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));

		// Top border
		lines.push(...border.render(width));

		// Title
		lines.push(theme.fg("accent", theme.bold(" Rewind to which turn?")));

		const [start, end] = windowRange();

		// Scroll-up indicator
		if (start > 0) {
			lines.push(theme.fg("dim", `   ↑ ${start} more`));
		}

		// Visible items
		for (let i = start; i < end; i++) {
			const isSelected = i === selectedIndex;
			const prefix = isSelected ? " ❯ " : "   ";
			const label = truncateToWidth(labels[i], width - 4, "");

			if (isSelected) {
				lines.push(theme.fg("accent", prefix + theme.bold(label)));
			} else {
				lines.push(theme.fg("text", prefix + label));
			}
		}

		// Scroll-down indicator
		const remaining = turns.length - end;
		if (remaining > 0) {
			lines.push(theme.fg("dim", `   ↓ ${remaining} more`));
		}

		// Position indicator (when scrollable)
		if (turns.length > maxVisible) {
			lines.push(theme.fg("dim", `   (${selectedIndex + 1}/${turns.length})`));
		}

		// Hint line
		lines.push(theme.fg("dim", " ↑↓ navigate • enter select • esc cancel"));

		// Bottom border
		lines.push(...border.render(width));

		cachedWidth = width;
		cachedLines = lines;
		return lines;
	}

	/**
	 * Handles keyboard input for navigation and selection.
	 *
	 * @param data - Raw terminal input data
	 */
	function handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			selectedIndex = selectedIndex === 0 ? turns.length - 1 : selectedIndex - 1;
			cachedLines = undefined;
		} else if (matchesKey(data, Key.down)) {
			selectedIndex = selectedIndex === turns.length - 1 ? 0 : selectedIndex + 1;
			cachedLines = undefined;
		} else if (matchesKey(data, Key.enter)) {
			done(turns[selectedIndex]);
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			done(null);
		}
	}

	/**
	 * Invalidates the render cache, forcing a full re-render on next call.
	 */
	function invalidate(): void {
		cachedLines = undefined;
		cachedWidth = undefined;
	}

	return { render, handleInput, invalidate };
}
