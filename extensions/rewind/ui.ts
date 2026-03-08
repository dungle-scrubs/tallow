/**
 * Turn Selector UI
 *
 * Presents a windowed list of available snapshot turns for the user to pick
 * from. Uses `ctx.ui.custom()` with a windowed component so long lists
 * (35+ turns) remain navigable within the terminal viewport.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	createTurnSelector,
	formatTurnOption,
	type TurnSelectorResult,
} from "./turn-selector-component.js";

/** Data for a single selectable turn in the UI. */
export interface TurnOption {
	turnIndex: number;
	ref: string;
	files: string[];
	timestamp: number;
	/** True when the snapshot fell back to HEAD due to a createSnapshot failure. */
	headFallback?: boolean;
}

/**
 * Shows the windowed turn selector UI and returns the user's choice.
 *
 * Presents turns in reverse chronological order (most recent first)
 * so the most likely rollback target is at the top. Uses a windowed
 * custom component to avoid overflow when the list is longer than the
 * terminal viewport.
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
	const labels = sorted.map(formatTurnOption);

	const result = await ctx.ui.custom<TurnSelectorResult>((tui, theme, _kb, done) => {
		return createTurnSelector(sorted, labels, tui.terminal.rows, theme, done);
	});

	return result ?? undefined;
}

// Re-export for tests
export { formatRelativeTime, formatTurnOption } from "./turn-selector-component.js";
