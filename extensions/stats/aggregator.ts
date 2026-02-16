/**
 * Stats Aggregation
 *
 * Filters and aggregates SessionStats records by time range.
 * Calculates totals, averages, model breakdowns, tool rankings, and streaks.
 */

import type { SessionStats, ToolCounts } from "./stats-log.js";

// ── Time Range Types ─────────────────────────────────────────────────────────

/** Named time range presets. */
export type TimeRangePreset = "today" | "week" | "month" | "all";

/** Resolved time range as start/end Date pair. */
export interface TimeRange {
	readonly start: Date;
	readonly end: Date;
}

// ── Aggregated Output ────────────────────────────────────────────────────────

/** Per-model breakdown in aggregated stats. */
export interface ModelBreakdown {
	readonly model: string;
	readonly sessions: number;
	readonly totalCost: number;
	readonly totalInput: number;
	readonly totalOutput: number;
}

/** Aggregated stats across multiple sessions. */
export interface AggregatedStats {
	/** Number of sessions in the range */
	readonly sessionCount: number;
	/** Total input tokens */
	readonly totalInput: number;
	/** Total output tokens */
	readonly totalOutput: number;
	/** Total cache read tokens */
	readonly totalCacheRead: number;
	/** Total cache write tokens */
	readonly totalCacheWrite: number;
	/** Total cost in USD */
	readonly totalCost: number;
	/** Total messages across sessions */
	readonly totalMessages: number;
	/** Total duration in milliseconds */
	readonly totalDurationMs: number;
	/** Average cost per session */
	readonly avgCostPerSession: number;
	/** Average messages per session */
	readonly avgMessagesPerSession: number;
	/** Merged tool counts, sorted by frequency */
	readonly toolCounts: ToolCounts;
	/** Per-model breakdown, sorted by session count desc */
	readonly modelBreakdown: readonly ModelBreakdown[];
	/** Consecutive days with at least one session (current streak) */
	readonly currentStreak: number;
	/** Longest streak ever */
	readonly longestStreak: number;
	/** Date range label for display */
	readonly rangeLabel: string;
}

// ── Time Range Resolution ────────────────────────────────────────────────────

/**
 * Resolves a named preset to a concrete start/end Date pair.
 * "today" = midnight to now. "week" = 7 days ago. "month" = 30 days ago.
 *
 * @param preset - Named time range
 * @returns Resolved time range
 */
export function resolvePreset(preset: TimeRangePreset): TimeRange {
	const now = new Date();
	const end = now;

	switch (preset) {
		case "today": {
			const start = new Date(now);
			start.setHours(0, 0, 0, 0);
			return { start, end };
		}
		case "week": {
			const start = new Date(now);
			start.setDate(start.getDate() - 7);
			start.setHours(0, 0, 0, 0);
			return { start, end };
		}
		case "month": {
			const start = new Date(now);
			start.setDate(start.getDate() - 30);
			start.setHours(0, 0, 0, 0);
			return { start, end };
		}
		case "all":
			return { start: new Date(0), end };
	}
}

/**
 * Parses a custom date range from "YYYY-MM-DD to YYYY-MM-DD" format.
 *
 * @param startStr - Start date string (YYYY-MM-DD)
 * @param endStr - End date string (YYYY-MM-DD)
 * @returns Resolved time range, or null if dates are invalid
 */
export function parseCustomRange(startStr: string, endStr: string): TimeRange | null {
	const start = new Date(startStr);
	const end = new Date(endStr);

	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
		return null;
	}

	// End date is inclusive — set to end of day
	end.setHours(23, 59, 59, 999);
	return { start, end };
}

// ── Filtering ────────────────────────────────────────────────────────────────

/**
 * Filters sessions by time range and optional model filter.
 *
 * @param sessions - All session stats
 * @param range - Time range to filter by
 * @param modelFilter - Optional model ID to filter by (case-insensitive substring match)
 * @returns Filtered sessions
 */
export function filterSessions(
	sessions: readonly SessionStats[],
	range: TimeRange,
	modelFilter?: string
): SessionStats[] {
	return sessions.filter((s) => {
		const sessionDate = new Date(s.startTime);
		if (sessionDate < range.start || sessionDate > range.end) return false;
		if (modelFilter && !s.model.toLowerCase().includes(modelFilter.toLowerCase())) return false;
		return true;
	});
}

// ── Streak Calculation ───────────────────────────────────────────────────────

/**
 * Calculates usage streaks from all sessions (not just filtered range).
 * A streak is consecutive calendar days with at least one session.
 *
 * @param sessions - All sessions (unfiltered, for global streak)
 * @returns Current and longest streaks
 */
export function calculateStreaks(sessions: readonly SessionStats[]): {
	current: number;
	longest: number;
} {
	if (sessions.length === 0) return { current: 0, longest: 0 };

	// Collect unique days (YYYY-MM-DD) with sessions
	const days = new Set<string>();
	for (const s of sessions) {
		const d = new Date(s.startTime);
		days.add(d.toISOString().slice(0, 10));
	}

	const sorted = [...days].sort();
	if (sorted.length === 0) return { current: 0, longest: 0 };

	// Calculate streaks
	let longest = 1;
	let currentRun = 1;

	for (let i = 1; i < sorted.length; i++) {
		const prev = new Date(sorted[i - 1]);
		const curr = new Date(sorted[i]);
		const diffMs = curr.getTime() - prev.getTime();
		const diffDays = diffMs / (1000 * 60 * 60 * 24);

		if (diffDays === 1) {
			currentRun++;
		} else {
			currentRun = 1;
		}
		longest = Math.max(longest, currentRun);
	}

	// Current streak: count backwards from today
	const today = new Date().toISOString().slice(0, 10);
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

	// Streak must include today or yesterday to be "current"
	if (!days.has(today) && !days.has(yesterday)) {
		return { current: 0, longest };
	}

	let currentStreak = 0;
	let checkDate = days.has(today) ? new Date(today) : new Date(yesterday);

	while (days.has(checkDate.toISOString().slice(0, 10))) {
		currentStreak++;
		checkDate = new Date(checkDate.getTime() - 86_400_000);
	}

	return { current: currentStreak, longest };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Merges tool counts from multiple sessions into a single sorted map.
 *
 * @param sessions - Sessions to merge tool counts from
 * @returns Combined tool counts, sorted by frequency descending
 */
function mergeToolCounts(sessions: readonly SessionStats[]): ToolCounts {
	const merged: Record<string, number> = {};

	for (const s of sessions) {
		for (const [tool, count] of Object.entries(s.toolCounts)) {
			merged[tool] = (merged[tool] ?? 0) + count;
		}
	}

	// Sort by count descending
	const sorted = Object.entries(merged).sort((a, b) => b[1] - a[1]);
	const result: ToolCounts = {};
	for (const [tool, count] of sorted) {
		result[tool] = count;
	}
	return result;
}

/**
 * Builds per-model breakdown from filtered sessions.
 *
 * @param sessions - Filtered sessions
 * @returns Model breakdown array sorted by session count desc
 */
function buildModelBreakdown(sessions: readonly SessionStats[]): ModelBreakdown[] {
	const byModel = new Map<
		string,
		{ sessions: number; cost: number; input: number; output: number }
	>();

	for (const s of sessions) {
		const existing = byModel.get(s.model) ?? { sessions: 0, cost: 0, input: 0, output: 0 };
		existing.sessions++;
		existing.cost += s.totalCost;
		existing.input += s.totalInput;
		existing.output += s.totalOutput;
		byModel.set(s.model, existing);
	}

	return [...byModel.entries()]
		.map(([model, data]) => ({
			model,
			sessions: data.sessions,
			totalCost: data.cost,
			totalInput: data.input,
			totalOutput: data.output,
		}))
		.sort((a, b) => b.sessions - a.sessions);
}

/**
 * Generates a human-readable label for a time range.
 *
 * @param range - Time range
 * @param preset - Optional preset name for nicer labels
 * @returns Display string like "Today", "Last 7 days", etc.
 */
function rangeLabel(range: TimeRange, preset?: TimeRangePreset): string {
	if (preset) {
		switch (preset) {
			case "today":
				return "Today";
			case "week":
				return "Last 7 days";
			case "month":
				return "Last 30 days";
			case "all":
				return "All time";
		}
	}
	const fmt = (d: Date) => d.toISOString().slice(0, 10);
	return `${fmt(range.start)} to ${fmt(range.end)}`;
}

/**
 * Aggregates filtered sessions into summary statistics.
 *
 * @param sessions - Filtered sessions for the target range
 * @param allSessions - All sessions (for streak calculation)
 * @param range - Time range used
 * @param preset - Optional preset name for the range label
 * @returns Aggregated statistics
 */
export function aggregate(
	sessions: readonly SessionStats[],
	allSessions: readonly SessionStats[],
	range: TimeRange,
	preset?: TimeRangePreset
): AggregatedStats {
	const count = sessions.length;
	const streaks = calculateStreaks(allSessions);

	if (count === 0) {
		return {
			sessionCount: 0,
			totalInput: 0,
			totalOutput: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			totalMessages: 0,
			totalDurationMs: 0,
			avgCostPerSession: 0,
			avgMessagesPerSession: 0,
			toolCounts: {},
			modelBreakdown: [],
			currentStreak: streaks.current,
			longestStreak: streaks.longest,
			rangeLabel: rangeLabel(range, preset),
		};
	}

	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let totalMessages = 0;
	let totalDurationMs = 0;

	for (const s of sessions) {
		totalInput += s.totalInput;
		totalOutput += s.totalOutput;
		totalCacheRead += s.totalCacheRead;
		totalCacheWrite += s.totalCacheWrite;
		totalCost += s.totalCost;
		totalMessages += s.messageCount;
		totalDurationMs += s.durationMs;
	}

	return {
		sessionCount: count,
		totalInput,
		totalOutput,
		totalCacheRead,
		totalCacheWrite,
		totalCost,
		totalMessages,
		totalDurationMs,
		avgCostPerSession: totalCost / count,
		avgMessagesPerSession: totalMessages / count,
		toolCounts: mergeToolCounts(sessions),
		modelBreakdown: buildModelBreakdown(sessions),
		currentStreak: streaks.current,
		longestStreak: streaks.longest,
		rangeLabel: rangeLabel(range, preset),
	};
}
