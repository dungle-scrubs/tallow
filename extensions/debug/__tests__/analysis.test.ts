import { describe, expect, it } from "bun:test";
import {
	calculateTurnMetrics,
	formatEntries,
	formatErrors,
	formatToolTimings,
	formatTurnMetrics,
	groupErrors,
	summarizeToolTimings,
} from "../analysis.js";
import type { LogEntry } from "../logger.js";

// ── Helpers ──────────────────────────────────────────────────

/**
 * Creates a tool result log entry with timing data.
 * @param name - Tool name
 * @param durationMs - Call duration in milliseconds
 * @param ok - Whether the call succeeded
 * @returns A LogEntry for a tool result
 */
function toolResult(
	name: string,
	durationMs: number,
	ok = true,
	extra: Record<string, unknown> = {}
): LogEntry {
	return {
		ts: new Date().toISOString(),
		cat: "tool",
		evt: "result",
		data: {
			name,
			durationMs,
			ok,
			toolCallId: `tc_${Math.random().toString(36).slice(2, 6)}`,
			...extra,
		},
	};
}

/**
 * Creates an error log entry.
 * @param message - Error message
 * @param evt - Event type (default: uncaught_exception)
 * @param stack - Optional stack trace
 * @returns A LogEntry for an error
 */
function errorEntry(message: string, evt = "uncaught_exception", stack?: string): LogEntry {
	return {
		ts: new Date().toISOString(),
		cat: "error",
		evt,
		data: { message, ...(stack ? { stack } : {}) },
	};
}

/**
 * Creates a turn start/end pair with a tool call in between.
 * @param turnIndex - Turn number
 * @param toolCount - Number of tool calls in the turn
 * @param durationMs - Duration between start and end timestamps
 * @returns Array of log entries (start, tool calls, end)
 */
function turnWithTools(turnIndex: number, toolCount: number, durationMs: number): LogEntry[] {
	const startTs = new Date("2026-01-01T00:00:00Z").getTime() + turnIndex * 10_000;
	const entries: LogEntry[] = [];

	entries.push({
		ts: new Date(startTs).toISOString(),
		cat: "turn",
		evt: "start",
		data: { turnIndex },
	});

	for (let i = 0; i < toolCount; i++) {
		entries.push({
			ts: new Date(startTs + i * 100).toISOString(),
			cat: "tool",
			evt: "call",
			data: { name: "bash", toolCallId: `tc_${turnIndex}_${i}` },
		});
	}

	entries.push({
		ts: new Date(startTs + durationMs).toISOString(),
		cat: "turn",
		evt: "end",
		data: { turnIndex, toolResultCount: toolCount },
	});

	return entries;
}

// ── summarizeToolTimings() ───────────────────────────────────

describe("summarizeToolTimings()", () => {
	it("returns empty array for no tool data", () => {
		expect(summarizeToolTimings([])).toEqual([]);
	});

	it("computes stats for a single tool", () => {
		const entries = [toolResult("bash", 100), toolResult("bash", 200), toolResult("bash", 300)];
		const stats = summarizeToolTimings(entries);

		expect(stats.length).toBe(1);
		expect(stats[0].name).toBe("bash");
		expect(stats[0].callCount).toBe(3);
		expect(stats[0].totalMs).toBe(600);
		expect(stats[0].avgMs).toBe(200);
		expect(stats[0].minMs).toBe(100);
		expect(stats[0].maxMs).toBe(300);
	});

	it("computes stats for multiple tools sorted by total time", () => {
		const entries = [
			toolResult("bash", 500),
			toolResult("read", 10),
			toolResult("bash", 500),
			toolResult("read", 20),
			toolResult("edit", 1000),
		];
		const stats = summarizeToolTimings(entries);

		expect(stats.length).toBe(3);
		// edit (1000) > bash (1000 total but same) > read (30)
		// bash total = 1000, edit total = 1000 — order between equal totals is stable
		expect(stats[0].totalMs).toBeGreaterThanOrEqual(stats[1].totalMs);
		expect(stats[1].totalMs).toBeGreaterThanOrEqual(stats[2].totalMs);
		expect(stats[2].name).toBe("read");
	});

	it("ignores entries without durationMs", () => {
		const entries: LogEntry[] = [
			{
				ts: new Date().toISOString(),
				cat: "tool",
				evt: "result",
				data: { name: "bash", ok: true },
			},
			toolResult("bash", 100),
		];
		const stats = summarizeToolTimings(entries);
		expect(stats[0].callCount).toBe(1);
	});

	it("ignores non-tool-result entries", () => {
		const entries: LogEntry[] = [
			{ ts: new Date().toISOString(), cat: "tool", evt: "call", data: { name: "bash" } },
			toolResult("bash", 50),
		];
		const stats = summarizeToolTimings(entries);
		expect(stats[0].callCount).toBe(1);
	});

	it("computes p50 and p95 percentiles", () => {
		// 20 entries: 1ms through 20ms
		const entries = Array.from({ length: 20 }, (_, i) => toolResult("bash", i + 1));
		const stats = summarizeToolTimings(entries);

		expect(stats[0].p50Ms).toBe(10);
		expect(stats[0].p95Ms).toBe(19);
	});
});

// ── formatToolTimings() ──────────────────────────────────────

describe("formatToolTimings()", () => {
	it("returns no-data message for empty stats", () => {
		expect(formatToolTimings([])).toBe("No tool timing data found.");
	});

	it("returns a markdown table", () => {
		const stats = summarizeToolTimings([toolResult("bash", 100)]);
		const output = formatToolTimings(stats);

		expect(output).toContain("| Tool |");
		expect(output).toContain("| bash |");
	});

	it("includes payload and summarized columns", () => {
		const stats = summarizeToolTimings([
			toolResult("bash", 100, true, { payloadBytes: 2_048, summarizedByRetention: true }),
		]);
		const output = formatToolTimings(stats);

		expect(output).toContain("Avg payload");
		expect(output).toContain("2.0KB");
		expect(output).toContain("| 1 |");
	});
});

// ── groupErrors() ────────────────────────────────────────────

describe("groupErrors()", () => {
	it("returns empty array for no errors", () => {
		expect(groupErrors([])).toEqual([]);
	});

	it("groups duplicate error messages", () => {
		const entries = [
			errorEntry("ENOENT: file not found"),
			errorEntry("ENOENT: file not found"),
			errorEntry("ENOENT: file not found"),
		];
		const groups = groupErrors(entries);

		expect(groups.length).toBe(1);
		expect(groups[0].count).toBe(3);
		expect(groups[0].message).toBe("ENOENT: file not found");
	});

	it("separates distinct error messages", () => {
		const entries = [errorEntry("error A"), errorEntry("error B"), errorEntry("error A")];
		const groups = groupErrors(entries);

		expect(groups.length).toBe(2);
		// Sorted by count descending
		expect(groups[0].message).toBe("error A");
		expect(groups[0].count).toBe(2);
		expect(groups[1].message).toBe("error B");
		expect(groups[1].count).toBe(1);
	});

	it("tracks time range", () => {
		const e1 = errorEntry("timeout");
		e1.ts = "2026-01-01T00:00:00Z";
		const e2 = errorEntry("timeout");
		e2.ts = "2026-01-01T12:00:00Z";

		const groups = groupErrors([e1, e2]);
		expect(groups[0].firstSeen).toBe("2026-01-01T00:00:00Z");
		expect(groups[0].lastSeen).toBe("2026-01-01T12:00:00Z");
	});

	it("collects distinct event types", () => {
		const entries = [
			errorEntry("fail", "uncaught_exception"),
			errorEntry("fail", "unhandled_rejection"),
		];
		const groups = groupErrors(entries);
		expect(groups[0].eventTypes).toEqual(["uncaught_exception", "unhandled_rejection"]);
	});

	it("truncates stack traces to 5 lines", () => {
		const longStack = Array.from({ length: 20 }, (_, i) => `  at line ${i}`).join("\n");
		const entries = [errorEntry("boom", "uncaught_exception", longStack)];
		const groups = groupErrors(entries);

		const stack = groups[0].stack ?? "";
		const stackLines = stack.split("\n");
		expect(stackLines.length).toBe(5);
	});

	it("ignores non-error entries", () => {
		const entries: LogEntry[] = [
			{ ts: new Date().toISOString(), cat: "tool", evt: "result", data: { ok: false } },
			errorEntry("real error"),
		];
		const groups = groupErrors(entries);
		expect(groups.length).toBe(1);
	});
});

// ── formatErrors() ───────────────────────────────────────────

describe("formatErrors()", () => {
	it("returns no-errors message for empty groups", () => {
		expect(formatErrors([])).toBe("No errors found in the log.");
	});

	it("formats grouped errors as markdown", () => {
		const groups = groupErrors([errorEntry("ENOENT"), errorEntry("ENOENT")]);
		const output = formatErrors(groups);

		expect(output).toContain("1 distinct error(s)");
		expect(output).toContain("ENOENT");
		expect(output).toContain("×2");
	});
});

// ── calculateTurnMetrics() ───────────────────────────────────

describe("calculateTurnMetrics()", () => {
	it("returns zeroes for no data", () => {
		const m = calculateTurnMetrics([]);
		expect(m.totalTurns).toBe(0);
		expect(m.totalToolCalls).toBe(0);
		expect(m.avgToolsPerTurn).toBe(0);
	});

	it("counts turns and tool calls", () => {
		// queryLog returns newest-first; calculateTurnMetrics reverses internally
		const entries = [...turnWithTools(0, 3, 2000), ...turnWithTools(1, 1, 500)].reverse();

		const m = calculateTurnMetrics(entries);
		expect(m.totalTurns).toBe(2);
		expect(m.totalToolCalls).toBe(4);
		expect(m.avgToolsPerTurn).toBe(2); // 4 / 2
	});

	it("detects empty turns", () => {
		const entries = turnWithTools(0, 0, 100).reverse();
		const m = calculateTurnMetrics(entries);
		expect(m.emptyTurns).toBe(1);
	});

	it("calculates average turn duration", () => {
		// Turn 0: 2000ms, Turn 1: 1000ms → avg 1500ms
		const entries = [...turnWithTools(0, 1, 2000), ...turnWithTools(1, 1, 1000)].reverse();

		const m = calculateTurnMetrics(entries);
		expect(m.avgTurnDurationMs).toBe(1500);
	});
});

// ── formatTurnMetrics() ──────────────────────────────────────

describe("formatTurnMetrics()", () => {
	it("returns no-data message for zero turns", () => {
		const m = calculateTurnMetrics([]);
		expect(formatTurnMetrics(m)).toBe("No turn data found.");
	});

	it("formats metrics as markdown", () => {
		const entries = turnWithTools(0, 3, 2000).reverse();
		const m = calculateTurnMetrics(entries);
		const output = formatTurnMetrics(m);

		expect(output).toContain("Total turns: 1");
		expect(output).toContain("Total tool calls: 3");
		expect(output).toContain("Avg tools/turn: 3");
	});
});

// ── formatEntries() ──────────────────────────────────────────

describe("formatEntries()", () => {
	it("returns no-entries message for empty array", () => {
		expect(formatEntries([])).toBe("No matching log entries found.");
	});

	it("formats entries with category/event and highlights", () => {
		const entries: LogEntry[] = [toolResult("bash", 150), errorEntry("connection refused")];
		const output = formatEntries(entries);

		expect(output).toContain("2 log entries");
		expect(output).toContain("**tool/result**");
		expect(output).toContain("**error/uncaught_exception**");
		expect(output).toContain("150ms");
		expect(output).toContain("connection refused");
	});

	it("shows ok/FAILED status for tool results", () => {
		const okEntry = toolResult("bash", 10, true);
		const failEntry = toolResult("bash", 10, false);
		const output = formatEntries([okEntry, failEntry]);

		expect(output).toContain("ok");
		expect(output).toContain("FAILED");
	});

	it("highlights agent and exit code fields", () => {
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			cat: "subagent",
			evt: "stop",
			data: { agentId: "sub_1", exitCode: 1 },
		};
		const output = formatEntries([entry]);

		expect(output).toContain("agent=sub_1");
		expect(output).toContain("exit=1");
	});

	it("highlights payload bytes and retention summaries", () => {
		const entry = toolResult("bash", 12, true, {
			payloadBytes: 2_048,
			summarizedByRetention: true,
		});
		const output = formatEntries([entry]);

		expect(output).toContain("payload=2.0KB");
		expect(output).toContain("summarized");
	});
});
