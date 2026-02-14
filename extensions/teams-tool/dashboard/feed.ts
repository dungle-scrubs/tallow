/**
 * Pure feed/message transforms for dashboard display.
 * No side effects, no module-level state.
 */

/** Maximum message events retained in the dashboard feed. */
export const DASHBOARD_FEED_MAX_ITEMS = 32;

/** Maximum visible chars per feed event message summary. */
export const DASHBOARD_FEED_SUMMARY_CHARS = 96;

/** Feed messages that are too noisy to render in the sidebar activity stream. */
export const DASHBOARD_FEED_SUPPRESSED_PATTERNS = [
	/^Running tool:/i,
	/^Completed response\.?$/i,
] as const;

/**
 * Summarize a message into a single feed-friendly line.
 * @param content - Raw message content
 * @returns Trimmed one-line summary with markdown noise removed
 */
export function summarizeFeedMessage(content: string): string {
	const firstLine =
		content
			.replace(/\r/g, "")
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	const normalized = firstLine
		.replace(/^[-*]\s+/, "")
		.replace(/[`*_#>]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length === 0) return "(empty message)";
	if (normalized.length <= DASHBOARD_FEED_SUMMARY_CHARS) return normalized;
	return `${normalized.slice(0, DASHBOARD_FEED_SUMMARY_CHARS - 1)}…`;
}

/**
 * Check whether a feed message is low-signal dashboard noise.
 * @param content - Candidate feed event text
 * @returns True when the event should be suppressed
 */
export function shouldSuppressDashboardFeedEvent(content: string): boolean {
	const normalized = content.trim();
	if (normalized.length === 0) return true;
	return DASHBOARD_FEED_SUPPRESSED_PATTERNS.some((pattern) => pattern.test(normalized));
}
