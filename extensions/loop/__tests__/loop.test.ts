/**
 * Unit tests for the loop extension's pure helpers.
 *
 * Tests interval parsing, countdown formatting, argument parsing,
 * max iterations, and until-condition extraction.
 */

import { describe, expect, test } from "bun:test";
import {
	extractUntilCondition,
	formatCountdown,
	parseInterval,
	parseLoopArgs,
	parseMaxIterations,
} from "../index.js";

describe("parseInterval", () => {
	test("parses seconds", () => {
		expect(parseInterval("30s")).toBe(30_000);
		expect(parseInterval("1s")).toBe(1_000);
		expect(parseInterval("120s")).toBe(120_000);
	});

	test("parses minutes", () => {
		expect(parseInterval("5m")).toBe(300_000);
		expect(parseInterval("1m")).toBe(60_000);
	});

	test("parses hours", () => {
		expect(parseInterval("1h")).toBe(3_600_000);
		expect(parseInterval("2h")).toBe(7_200_000);
	});

	test("rejects bare numbers", () => {
		expect(parseInterval("30")).toBeNull();
		expect(parseInterval("5")).toBeNull();
	});

	test("rejects unknown units", () => {
		expect(parseInterval("5x")).toBeNull();
		expect(parseInterval("10d")).toBeNull();
		expect(parseInterval("2w")).toBeNull();
	});

	test("rejects non-numeric values", () => {
		expect(parseInterval("abc")).toBeNull();
		expect(parseInterval("fivem")).toBeNull();
	});

	test("rejects empty string", () => {
		expect(parseInterval("")).toBeNull();
	});

	test("rejects zero", () => {
		expect(parseInterval("0s")).toBeNull();
		expect(parseInterval("0m")).toBeNull();
	});
});

describe("parseMaxIterations", () => {
	test("parses x<N> format", () => {
		expect(parseMaxIterations("x100")).toBe(100);
		expect(parseMaxIterations("x1")).toBe(1);
		expect(parseMaxIterations("x10")).toBe(10);
	});

	test("rejects zero", () => {
		expect(parseMaxIterations("x0")).toBeNull();
	});

	test("rejects non-x formats", () => {
		expect(parseMaxIterations("100")).toBeNull();
		expect(parseMaxIterations("100x")).toBeNull();
		expect(parseMaxIterations("abc")).toBeNull();
		expect(parseMaxIterations("")).toBeNull();
	});
});

describe("extractUntilCondition", () => {
	test("extracts double-quoted condition", () => {
		const result = extractUntilCondition(["until", '"build', "is", 'done"', "check", "status"]);
		expect(result.condition).toBe("build is done");
		expect(result.remaining).toEqual(["check", "status"]);
	});

	test("extracts single-quoted condition", () => {
		const result = extractUntilCondition(["until", "'tests", "pass'", "run", "tests"]);
		expect(result.condition).toBe("tests pass");
		expect(result.remaining).toEqual(["run", "tests"]);
	});

	test("extracts single-word quoted condition", () => {
		const result = extractUntilCondition(["until", '"done"', "check"]);
		expect(result.condition).toBe("done");
		expect(result.remaining).toEqual(["check"]);
	});

	test("extracts unquoted single-word condition", () => {
		const result = extractUntilCondition(["until", "done", "check", "status"]);
		expect(result.condition).toBe("done");
		expect(result.remaining).toEqual(["check", "status"]);
	});

	test("returns null when no until keyword", () => {
		const result = extractUntilCondition(["check", "deploy", "status"]);
		expect(result.condition).toBeNull();
		expect(result.remaining).toEqual(["check", "deploy", "status"]);
	});

	test("preserves tokens before until", () => {
		const result = extractUntilCondition(["x10", "until", '"done"', "check"]);
		expect(result.condition).toBe("done");
		expect(result.remaining).toEqual(["x10", "check"]);
	});

	test("handles until at end with no condition", () => {
		const result = extractUntilCondition(["check", "until"]);
		expect(result.condition).toBeNull();
		expect(result.remaining).toEqual(["check", "until"]);
	});
});

describe("formatCountdown", () => {
	test("returns 'now' for zero or negative", () => {
		expect(formatCountdown(0)).toBe("now");
		expect(formatCountdown(-1000)).toBe("now");
	});

	test("formats seconds only", () => {
		expect(formatCountdown(1_000)).toBe("1s");
		expect(formatCountdown(30_000)).toBe("30s");
		expect(formatCountdown(59_000)).toBe("59s");
	});

	test("formats minutes and seconds", () => {
		expect(formatCountdown(90_000)).toBe("1m30s");
		expect(formatCountdown(150_000)).toBe("2m30s");
	});

	test("formats exact minutes without seconds", () => {
		expect(formatCountdown(60_000)).toBe("1m");
		expect(formatCountdown(300_000)).toBe("5m");
	});

	test("formats hours and minutes", () => {
		expect(formatCountdown(3_600_000)).toBe("1h");
		expect(formatCountdown(3_900_000)).toBe("1h5m");
		expect(formatCountdown(7_200_000)).toBe("2h");
	});

	test("rounds up partial seconds", () => {
		expect(formatCountdown(500)).toBe("1s");
		expect(formatCountdown(1_500)).toBe("2s");
	});
});

describe("parseLoopArgs", () => {
	test("empty string returns status", () => {
		expect(parseLoopArgs("")).toEqual({ action: "status" });
		expect(parseLoopArgs("  ")).toEqual({ action: "status" });
	});

	test("'stop' returns stop action", () => {
		expect(parseLoopArgs("stop")).toEqual({ action: "stop" });
	});

	test("'off' returns stop action", () => {
		expect(parseLoopArgs("off")).toEqual({ action: "stop" });
	});

	test("'status' returns status action", () => {
		expect(parseLoopArgs("status")).toEqual({ action: "status" });
	});

	test("valid interval + prompt returns start action", () => {
		const result = parseLoopArgs("5m check deploy");
		expect(result).toEqual({
			action: "start",
			intervalMs: 300_000,
			intervalLabel: "5m",
			prompt: "check deploy",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("slash commands work as prompts", () => {
		const result = parseLoopArgs("30s /stats");
		expect(result).toEqual({
			action: "start",
			intervalMs: 30_000,
			intervalLabel: "30s",
			prompt: "/stats",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("interval without prompt returns error", () => {
		const result = parseLoopArgs("5m");
		expect(result).toEqual({
			action: "error",
			message: "Missing prompt. Usage: /loop 5m <prompt>",
		});
	});

	test("invalid interval returns error", () => {
		const result = parseLoopArgs("5x check deploy");
		expect(result).toEqual({
			action: "error",
			message: 'Invalid interval "5x". Use format: 30s, 5m, 1h',
		});
	});

	test("bare invalid word returns error", () => {
		const result = parseLoopArgs("banana");
		expect(result).toEqual({
			action: "error",
			message: 'Invalid interval "banana". Use format: 30s, 5m, 1h',
		});
	});

	test("preserves full prompt text including extra spaces", () => {
		const result = parseLoopArgs("1h summarize git log --oneline -20");
		expect(result).toEqual({
			action: "start",
			intervalMs: 3_600_000,
			intervalLabel: "1h",
			prompt: "summarize git log --oneline -20",
			maxIterations: null,
			untilCondition: null,
		});
	});

	// ── Max iterations ───────────────────────────────────────────────

	test("parses x<N> max iterations", () => {
		const result = parseLoopArgs("1m x100 run tests");
		expect(result).toEqual({
			action: "start",
			intervalMs: 60_000,
			intervalLabel: "1m",
			prompt: "run tests",
			maxIterations: 100,
			untilCondition: null,
		});
	});

	test("x<N> works with single iteration", () => {
		const result = parseLoopArgs("5s x1 check once");
		expect(result).toEqual({
			action: "start",
			intervalMs: 5_000,
			intervalLabel: "5s",
			prompt: "check once",
			maxIterations: 1,
			untilCondition: null,
		});
	});

	// ── Until condition ──────────────────────────────────────────────

	test("parses until condition with double quotes", () => {
		const result = parseLoopArgs('2m until "build is done" check fuse index');
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check fuse index",
			maxIterations: null,
			untilCondition: "build is done",
		});
	});

	test("parses until condition with single quotes", () => {
		const result = parseLoopArgs("1m until 'tests pass' run test suite");
		expect(result).toEqual({
			action: "start",
			intervalMs: 60_000,
			intervalLabel: "1m",
			prompt: "run test suite",
			maxIterations: null,
			untilCondition: "tests pass",
		});
	});

	test("parses unquoted until condition", () => {
		const result = parseLoopArgs("5m until done check status");
		expect(result).toEqual({
			action: "start",
			intervalMs: 300_000,
			intervalLabel: "5m",
			prompt: "check status",
			maxIterations: null,
			untilCondition: "done",
		});
	});

	// ── Combined x<N> + until ────────────────────────────────────────

	test("parses both x<N> and until condition", () => {
		const result = parseLoopArgs('1m x50 until "tests pass" run the test suite');
		expect(result).toEqual({
			action: "start",
			intervalMs: 60_000,
			intervalLabel: "1m",
			prompt: "run the test suite",
			maxIterations: 50,
			untilCondition: "tests pass",
		});
	});

	test("until before x<N> also works", () => {
		const result = parseLoopArgs('1m until "deployed" x10 check deploy status');
		expect(result).toEqual({
			action: "start",
			intervalMs: 60_000,
			intervalLabel: "1m",
			prompt: "check deploy status",
			maxIterations: 10,
			untilCondition: "deployed",
		});
	});
});
