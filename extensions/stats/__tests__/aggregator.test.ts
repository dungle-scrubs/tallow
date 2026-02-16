/**
 * Tests for stats aggregation: filtering, streaks, and aggregate calculations.
 */
import { describe, expect, it } from "bun:test";
import {
	aggregate,
	calculateStreaks,
	filterSessions,
	parseCustomRange,
	resolvePreset,
} from "../aggregator.js";
import type { SessionStats } from "../stats-log.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Creates a minimal valid SessionStats for testing. */
function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
	return {
		sessionId: "test-1",
		startTime: "2026-02-15T10:00:00Z",
		endTime: "2026-02-15T10:30:00Z",
		durationMs: 1_800_000,
		model: "claude-sonnet-4-5",
		cwd: "/tmp",
		totalInput: 1000,
		totalOutput: 500,
		totalCacheRead: 2000,
		totalCacheWrite: 300,
		totalCost: 0.05,
		toolCounts: { read: 3, bash: 2 },
		messageCount: 8,
		...overrides,
	};
}

// ── resolvePreset ────────────────────────────────────────────────────────────

describe("resolvePreset", () => {
	it("today starts at midnight", () => {
		const range = resolvePreset("today");
		expect(range.start.getHours()).toBe(0);
		expect(range.start.getMinutes()).toBe(0);
		expect(range.end.getTime()).toBeCloseTo(Date.now(), -3);
	});

	it("week goes back 7 days", () => {
		const range = resolvePreset("week");
		const diff = range.end.getTime() - range.start.getTime();
		// Should be between 7 and 8 days (start is midnight, end is now)
		expect(diff).toBeGreaterThan(6 * 86_400_000);
		expect(diff).toBeLessThan(8 * 86_400_000);
	});

	it("month goes back 30 days", () => {
		const range = resolvePreset("month");
		const diff = range.end.getTime() - range.start.getTime();
		expect(diff).toBeGreaterThan(29 * 86_400_000);
		expect(diff).toBeLessThan(31 * 86_400_000);
	});

	it("all starts at epoch", () => {
		const range = resolvePreset("all");
		expect(range.start.getTime()).toBe(0);
	});
});

// ── parseCustomRange ─────────────────────────────────────────────────────────

describe("parseCustomRange", () => {
	it("parses valid date range", () => {
		const range = parseCustomRange("2026-01-01", "2026-01-31");
		expect(range).not.toBeNull();
		expect(range!.start.getFullYear()).toBe(2026);
		expect(range!.end.getHours()).toBe(23);
	});

	it("returns null for invalid dates", () => {
		expect(parseCustomRange("not-a-date", "2026-01-31")).toBeNull();
		expect(parseCustomRange("2026-01-01", "nope")).toBeNull();
	});

	it("end date is inclusive (end of day)", () => {
		const range = parseCustomRange("2026-02-01", "2026-02-01");
		expect(range).not.toBeNull();
		expect(range!.end.getHours()).toBe(23);
		expect(range!.end.getMinutes()).toBe(59);
	});
});

// ── filterSessions ───────────────────────────────────────────────────────────

describe("filterSessions", () => {
	const sessions = [
		makeStats({ sessionId: "dec", startTime: "2025-12-15T12:00:00Z" }),
		makeStats({ sessionId: "jan", startTime: "2026-01-15T12:00:00Z" }),
		makeStats({ sessionId: "feb", startTime: "2026-02-15T12:00:00Z" }),
	];

	it("filters by time range", () => {
		const range = parseCustomRange("2026-01-01", "2026-01-31")!;
		const result = filterSessions(sessions, range);
		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe("jan");
	});

	it("returns all for epoch-to-now range", () => {
		const range = resolvePreset("all");
		const result = filterSessions(sessions, range);
		expect(result).toHaveLength(3);
	});

	it("returns empty for range with no sessions", () => {
		const range = parseCustomRange("2024-01-01", "2024-12-31")!;
		const result = filterSessions(sessions, range);
		expect(result).toHaveLength(0);
	});

	it("filters by model (case-insensitive substring)", () => {
		const mixed = [
			makeStats({ sessionId: "s1", model: "claude-sonnet-4-5" }),
			makeStats({ sessionId: "s2", model: "claude-opus-4" }),
			makeStats({ sessionId: "s3", model: "gpt-4o" }),
		];
		const range = resolvePreset("all");

		expect(filterSessions(mixed, range, "opus")).toHaveLength(1);
		expect(filterSessions(mixed, range, "claude")).toHaveLength(2);
		expect(filterSessions(mixed, range, "GPT")).toHaveLength(1);
	});
});

// ── calculateStreaks ─────────────────────────────────────────────────────────

describe("calculateStreaks", () => {
	it("returns zeros for empty sessions", () => {
		const result = calculateStreaks([]);
		expect(result.current).toBe(0);
		expect(result.longest).toBe(0);
	});

	it("counts single day as streak of 1", () => {
		const today = new Date().toISOString();
		const result = calculateStreaks([makeStats({ startTime: today })]);
		expect(result.current).toBe(1);
		expect(result.longest).toBe(1);
	});

	it("counts consecutive days", () => {
		const now = Date.now();
		const sessions = [
			makeStats({ startTime: new Date(now).toISOString() }),
			makeStats({ startTime: new Date(now - 86_400_000).toISOString() }),
			makeStats({ startTime: new Date(now - 2 * 86_400_000).toISOString() }),
		];
		const result = calculateStreaks(sessions);
		expect(result.current).toBe(3);
		expect(result.longest).toBe(3);
	});

	it("handles gap in streak", () => {
		const now = Date.now();
		const sessions = [
			makeStats({ startTime: new Date(now).toISOString() }),
			// gap: skip yesterday
			makeStats({ startTime: new Date(now - 3 * 86_400_000).toISOString() }),
			makeStats({ startTime: new Date(now - 4 * 86_400_000).toISOString() }),
		];
		const result = calculateStreaks(sessions);
		expect(result.current).toBe(1);
		expect(result.longest).toBe(2);
	});

	it("multiple sessions on same day count as one", () => {
		const today = new Date().toISOString().slice(0, 10);
		const sessions = [
			makeStats({ startTime: `${today}T09:00:00Z` }),
			makeStats({ startTime: `${today}T14:00:00Z` }),
			makeStats({ startTime: `${today}T20:00:00Z` }),
		];
		const result = calculateStreaks(sessions);
		expect(result.current).toBe(1);
		expect(result.longest).toBe(1);
	});

	it("current streak is 0 when last session was >1 day ago", () => {
		const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
		const result = calculateStreaks([makeStats({ startTime: old })]);
		expect(result.current).toBe(0);
		expect(result.longest).toBe(1);
	});

	it("yesterday counts as current streak", () => {
		const yesterday = new Date(Date.now() - 86_400_000).toISOString();
		const result = calculateStreaks([makeStats({ startTime: yesterday })]);
		expect(result.current).toBe(1);
	});
});

// ── aggregate ────────────────────────────────────────────────────────────────

describe("aggregate", () => {
	it("returns zeros for empty sessions", () => {
		const range = resolvePreset("all");
		const result = aggregate([], [], range, "all");
		expect(result.sessionCount).toBe(0);
		expect(result.totalCost).toBe(0);
		expect(result.rangeLabel).toBe("All time");
	});

	it("sums tokens and costs correctly", () => {
		const sessions = [
			makeStats({ totalInput: 100, totalOutput: 50, totalCost: 0.01 }),
			makeStats({ totalInput: 200, totalOutput: 75, totalCost: 0.02 }),
		];
		const range = resolvePreset("all");
		const result = aggregate(sessions, sessions, range);

		expect(result.totalInput).toBe(300);
		expect(result.totalOutput).toBe(125);
		expect(result.totalCost).toBeCloseTo(0.03);
		expect(result.sessionCount).toBe(2);
	});

	it("calculates averages", () => {
		const sessions = [
			makeStats({ totalCost: 0.10, messageCount: 10 }),
			makeStats({ totalCost: 0.20, messageCount: 20 }),
		];
		const range = resolvePreset("all");
		const result = aggregate(sessions, sessions, range);

		expect(result.avgCostPerSession).toBeCloseTo(0.15);
		expect(result.avgMessagesPerSession).toBe(15);
	});

	it("merges tool counts across sessions", () => {
		const sessions = [
			makeStats({ toolCounts: { read: 5, bash: 3 } }),
			makeStats({ toolCounts: { read: 2, write: 1 } }),
		];
		const range = resolvePreset("all");
		const result = aggregate(sessions, sessions, range);

		expect(result.toolCounts.read).toBe(7);
		expect(result.toolCounts.bash).toBe(3);
		expect(result.toolCounts.write).toBe(1);
	});

	it("builds model breakdown sorted by session count", () => {
		const sessions = [
			makeStats({ model: "sonnet" }),
			makeStats({ model: "sonnet" }),
			makeStats({ model: "opus" }),
		];
		const range = resolvePreset("all");
		const result = aggregate(sessions, sessions, range);

		expect(result.modelBreakdown).toHaveLength(2);
		expect(result.modelBreakdown[0].model).toBe("sonnet");
		expect(result.modelBreakdown[0].sessions).toBe(2);
		expect(result.modelBreakdown[1].model).toBe("opus");
	});

	it("uses preset label for named ranges", () => {
		const range = resolvePreset("week");
		const result = aggregate([], [], range, "week");
		expect(result.rangeLabel).toBe("Last 7 days");
	});

	it("uses date label for custom ranges", () => {
		const range = parseCustomRange("2026-01-01", "2026-01-31")!;
		const result = aggregate([], [], range);
		expect(result.rangeLabel).toBe("2026-01-01 to 2026-01-31");
	});
});
