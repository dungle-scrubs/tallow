import type { ContextUsage } from "@mariozechner/pi-coding-agent";

/**
 * Formats token counts with k/M suffixes for readability.
 *
 * @param count - Token count to format
 * @returns Formatted string (e.g., "1.2k", "5M")
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/**
 * Formats footer context usage without reusing stale pre-compaction token counts.
 *
 * `ctx.getContextUsage()` intentionally returns `tokens: null` after compaction
 * until a fresh assistant response arrives. The footer must preserve that
 * unknown state instead of showing a bogus percentage from stale usage data.
 *
 * @param usage - Current context usage snapshot, if available
 * @param fallbackContextWindow - Active model context window when usage is unavailable
 * @param autoCompactEnabled - Whether to append the auto-compaction indicator
 * @returns Display text plus raw percentage for severity coloring
 */
export function formatContextUsageDisplay(
	usage: ContextUsage | undefined,
	fallbackContextWindow: number,
	autoCompactEnabled: boolean
): { readonly percent: number | null; readonly text: string } {
	const autoIndicator = autoCompactEnabled ? " (auto)" : "";
	const contextWindow = usage?.contextWindow ?? fallbackContextWindow;
	const tokens = usage ? usage.tokens : 0;

	if (contextWindow <= 0) {
		return { percent: null, text: `?/?${autoIndicator}` };
	}

	const windowText = formatTokens(contextWindow);
	if (tokens === null) {
		return { percent: null, text: `?/${windowText}${autoIndicator}` };
	}

	const percent = (tokens / contextWindow) * 100;
	return { percent, text: `${percent.toFixed(1)}%/${windowText}${autoIndicator}` };
}
