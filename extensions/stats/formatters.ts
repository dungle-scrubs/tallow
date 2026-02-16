/**
 * Stats Display Formatters
 *
 * Renders aggregated stats as styled ASCII output for the terminal.
 * Produces lines for the custom message renderer.
 */

import type { AggregatedStats, ModelBreakdown } from "./aggregator.js";
import type { SessionStats } from "./stats-log.js";

// ── ANSI codes ───────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[38;2;139;213;202m";
const GREEN = "\x1b[38;2;166;209;137m";
const YELLOW = "\x1b[38;2;229;200;144m";
const PURPLE = "\x1b[38;2;198;160;246m";
const PINK = "\x1b[38;2;244;184;228m";

// ── Number formatting ────────────────────────────────────────────────────────

/**
 * Formats token counts with k/M suffixes.
 *
 * @param count - Token count
 * @returns Formatted string (e.g., "1.2k", "5M")
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/**
 * Formats a cost value with $ prefix.
 *
 * @param cost - Cost in USD
 * @returns Formatted string (e.g., "$1.234", "$0.05")
 */
function formatCost(cost: number): string {
	if (cost === 0) return "$0.00";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

/**
 * Formats milliseconds into a human-readable duration.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "2h 15m", "45m", "3m 20s")
 */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		const remainMinutes = minutes % 60;
		return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
	}
	if (minutes > 0) {
		const remainSeconds = seconds % 60;
		return remainSeconds > 0 ? `${minutes}m ${remainSeconds}s` : `${minutes}m`;
	}
	return `${seconds}s`;
}

// ── Bar chart ────────────────────────────────────────────────────────────────

/** Maximum width for bar chart bars. */
const MAX_BAR_WIDTH = 20;

/**
 * Renders a horizontal bar for a tool usage chart.
 * Bar width is proportional to the max count.
 *
 * @param name - Tool name
 * @param count - Invocation count
 * @param maxCount - Maximum count (for proportional scaling)
 * @param nameWidth - Column width for the tool name
 * @returns Formatted bar line
 */
function renderBar(name: string, count: number, maxCount: number, nameWidth: number): string {
	const barLen = maxCount > 0 ? Math.max(1, Math.round((count / maxCount) * MAX_BAR_WIDTH)) : 0;
	const bar = "█".repeat(barLen);
	const paddedName = name.padEnd(nameWidth);
	return `  ${DIM}${paddedName}${RESET} ${GREEN}${bar}${RESET} ${DIM}${count}${RESET}`;
}

// ── Current Session Formatter ────────────────────────────────────────────────

/**
 * Formats a single session's stats (used for "current session" view).
 *
 * @param stats - Single session stats
 * @returns Array of rendered lines
 */
export function formatCurrentSession(stats: SessionStats): string[] {
	const lines: string[] = [];

	lines.push("");
	lines.push(`  ${BOLD}Session Stats${RESET}`);
	lines.push("");

	// Token overview
	lines.push(`  ${CYAN}↑${RESET} Input     ${formatTokens(stats.totalInput)}`);
	lines.push(`  ${GREEN}↓${RESET} Output    ${formatTokens(stats.totalOutput)}`);
	if (stats.totalCacheRead > 0) {
		lines.push(`  ${YELLOW}R${RESET} Cache ↓   ${formatTokens(stats.totalCacheRead)}`);
	}
	if (stats.totalCacheWrite > 0) {
		lines.push(`  ${PURPLE}W${RESET} Cache ↑   ${formatTokens(stats.totalCacheWrite)}`);
	}
	lines.push("");
	lines.push(`  ${DIM}Cost${RESET}      ${formatCost(stats.totalCost)}`);
	lines.push(`  ${DIM}Duration${RESET}  ${formatDuration(stats.durationMs)}`);
	lines.push(`  ${DIM}Messages${RESET}  ${stats.messageCount}`);
	lines.push(`  ${DIM}Model${RESET}     ${stats.model}`);

	// Tool usage
	const tools = Object.entries(stats.toolCounts);
	if (tools.length > 0) {
		lines.push("");
		lines.push(`  ${BOLD}Tool Usage${RESET}`);
		const maxCount = Math.max(...tools.map(([, c]) => c));
		const maxNameLen = Math.max(...tools.map(([n]) => n.length));
		for (const [name, count] of tools) {
			lines.push(renderBar(name, count, maxCount, maxNameLen));
		}
	}

	lines.push("");
	return lines;
}

// ── Aggregate Formatter ──────────────────────────────────────────────────────

/**
 * Formats aggregated stats across multiple sessions.
 *
 * @param agg - Aggregated statistics
 * @param showTools - Whether to show detailed tool breakdown
 * @returns Array of rendered lines
 */
export function formatAggregated(agg: AggregatedStats, showTools: boolean): string[] {
	const lines: string[] = [];

	lines.push("");
	lines.push(`  ${BOLD}Usage Stats${RESET} ${DIM}─ ${agg.rangeLabel}${RESET}`);
	lines.push("");

	if (agg.sessionCount === 0) {
		lines.push(`  ${DIM}No sessions found in this time range.${RESET}`);
		lines.push("");
		return lines;
	}

	// Summary row
	lines.push(
		`  ${CYAN}${agg.sessionCount}${RESET} sessions  ${DIM}│${RESET}  ${GREEN}${formatCost(agg.totalCost)}${RESET} total  ${DIM}│${RESET}  ${YELLOW}${formatDuration(agg.totalDurationMs)}${RESET}`
	);
	lines.push("");

	// Token breakdown
	lines.push(`  ${BOLD}Tokens${RESET}`);
	lines.push(`  ${CYAN}↑${RESET} Input     ${formatTokens(agg.totalInput)}`);
	lines.push(`  ${GREEN}↓${RESET} Output    ${formatTokens(agg.totalOutput)}`);
	if (agg.totalCacheRead > 0) {
		lines.push(`  ${YELLOW}R${RESET} Cache ↓   ${formatTokens(agg.totalCacheRead)}`);
	}
	if (agg.totalCacheWrite > 0) {
		lines.push(`  ${PURPLE}W${RESET} Cache ↑   ${formatTokens(agg.totalCacheWrite)}`);
	}

	// Averages
	lines.push("");
	lines.push(`  ${BOLD}Averages${RESET}`);
	lines.push(`  ${DIM}Cost/session${RESET}     ${formatCost(agg.avgCostPerSession)}`);
	lines.push(`  ${DIM}Messages/session${RESET} ${agg.avgMessagesPerSession.toFixed(1)}`);

	// Model breakdown
	if (agg.modelBreakdown.length > 0) {
		lines.push("");
		lines.push(`  ${BOLD}Models${RESET}`);
		for (const mb of agg.modelBreakdown) {
			lines.push(formatModelLine(mb));
		}
	}

	// Streaks
	if (agg.currentStreak > 0 || agg.longestStreak > 0) {
		lines.push("");
		lines.push(`  ${BOLD}Streaks${RESET}`);
		if (agg.currentStreak > 0) {
			const fire = agg.currentStreak >= 7 ? "🔥" : "📅";
			lines.push(
				`  ${fire} Current   ${agg.currentStreak} day${agg.currentStreak !== 1 ? "s" : ""}`
			);
		}
		if (agg.longestStreak > 0) {
			lines.push(`  🏆 Longest   ${agg.longestStreak} day${agg.longestStreak !== 1 ? "s" : ""}`);
		}
	}

	// Tool usage (optional)
	if (showTools) {
		const tools = Object.entries(agg.toolCounts);
		if (tools.length > 0) {
			lines.push("");
			lines.push(`  ${BOLD}Tool Usage${RESET}`);
			const maxCount = Math.max(...tools.map(([, c]) => c));
			const maxNameLen = Math.max(...tools.map(([n]) => n.length));
			for (const [name, count] of tools) {
				lines.push(renderBar(name, count, maxCount, maxNameLen));
			}
		}
	}

	lines.push("");
	return lines;
}

// ── JSON Formatter ───────────────────────────────────────────────────────────

/**
 * Formats stats as a pretty-printed JSON string for programmatic output.
 *
 * @param data - Stats data (single session or aggregated)
 * @returns JSON string
 */
export function formatJson(data: SessionStats | AggregatedStats): string {
	return JSON.stringify(data, null, 2);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats a single model breakdown line.
 *
 * @param mb - Model breakdown entry
 * @returns Formatted line with model name, session count, and cost
 */
function formatModelLine(mb: ModelBreakdown): string {
	const sessions = `${mb.sessions} session${mb.sessions !== 1 ? "s" : ""}`;
	return `  ${PINK}●${RESET} ${mb.model} ${DIM}(${sessions}, ${formatCost(mb.totalCost)})${RESET}`;
}
