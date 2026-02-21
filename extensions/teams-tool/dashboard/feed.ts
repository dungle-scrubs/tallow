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
	/^Started work\.?$/i,
	/^Went idle\.?$/i,
	/^Queued follow-up for @[^\s]+\.?$/i,
] as const;

/**
 * Normalize a raw feed line for matching and display.
 * @param line - Raw input line
 * @returns One-line normalized line text
 */
function normalizeFeedLine(line: string): string {
	return line
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^[-*]\s+/, "")
		.replace(/^#{1,6}\s+/, "")
		.replace(/^>\s+/, "")
		.replace(/[`*_]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Strip noisy transport prefixes that do not add feed value.
 * @param line - Candidate line
 * @returns Line without envelope prefixes
 */
function stripFeedPrefix(line: string): string {
	return line
		.replace(/^Message from [^:]+:\s*/i, "")
		.replace(/^Broadcast from [^:]+:\s*/i, "")
		.trim();
}

/**
 * Extract normalized candidate lines from raw message content.
 * @param content - Raw message content
 * @returns Clean candidate lines in source order
 */
function extractFeedLines(content: string): string[] {
	return content
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => normalizeFeedLine(stripFeedPrefix(line)))
		.filter((line) => line.length > 0);
}

/**
 * Check whether a normalized line is low-signal dashboard noise.
 * @param line - Normalized feed line
 * @returns True when the line should be hidden
 */
function isSuppressedLine(line: string): boolean {
	return DASHBOARD_FEED_SUPPRESSED_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Summarize a message into a single feed-friendly line.
 * @param content - Raw message content
 * @returns Trimmed one-line summary with markdown and transport noise removed
 */
export function summarizeFeedMessage(content: string): string {
	const lines = extractFeedLines(content);
	if (lines.length === 0) return "(empty message)";

	const summary = lines.find((line) => !isSuppressedLine(line)) ?? lines[0] ?? "(empty message)";
	if (summary.length <= DASHBOARD_FEED_SUMMARY_CHARS) return summary;
	return `${summary.slice(0, DASHBOARD_FEED_SUMMARY_CHARS - 1)}…`;
}

/**
 * Check whether a feed message is low-signal dashboard noise.
 * @param content - Candidate feed event text
 * @returns True when the event should be suppressed
 */
export function shouldSuppressDashboardFeedEvent(content: string): boolean {
	const lines = extractFeedLines(content);
	if (lines.length === 0) return true;
	return lines.every((line) => isSuppressedLine(line));
}
