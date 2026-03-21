/**
 * Unit tests for the loop extension's pure helpers.
 *
 * Tests interval parsing, countdown formatting, argument parsing,
 * max iterations, until-condition extraction, natural-language parsing,
 * and command building.
 */

import { describe, expect, test } from "bun:test";
import {
	buildLoopCommand,
	extractUntilCondition,
	formatCountdown,
	parseInterval,
	parseLoopArgs,
	parseMaxIterations,
	parseNaturalLanguageLoop,
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

// ── Natural language parsing ─────────────────────────────────────────────

describe("parseNaturalLanguageLoop", () => {
	// ── Interval extraction ──────────────────────────────────────────

	test("extracts 'every N minutes'", () => {
		const result = parseNaturalLanguageLoop("check ci every 2 minutes");
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("extracts 'every N seconds'", () => {
		const result = parseNaturalLanguageLoop("run tests every 30 seconds");
		expect(result).toEqual({
			action: "start",
			intervalMs: 30_000,
			intervalLabel: "30s",
			prompt: "run tests",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("extracts 'every N hrs'", () => {
		const result = parseNaturalLanguageLoop("check logs every 2 hrs");
		expect(result).toEqual({
			action: "start",
			intervalMs: 7_200_000,
			intervalLabel: "2h",
			prompt: "check logs",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("extracts 'every minute' (no number → 1)", () => {
		const result = parseNaturalLanguageLoop("check deploy every minute");
		expect(result).toEqual({
			action: "start",
			intervalMs: 60_000,
			intervalLabel: "1m",
			prompt: "check deploy",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("extracts 'every hour'", () => {
		const result = parseNaturalLanguageLoop("summarize logs every hour");
		expect(result).toEqual({
			action: "start",
			intervalMs: 3_600_000,
			intervalLabel: "1h",
			prompt: "summarize logs",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("extracts 'every Nm' shorthand", () => {
		const result = parseNaturalLanguageLoop("check ci every 5m");
		expect(result).toEqual({
			action: "start",
			intervalMs: 300_000,
			intervalLabel: "5m",
			prompt: "check ci",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("extracts bare interval without 'every'", () => {
		const result = parseNaturalLanguageLoop("check ci 2m");
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("returns null when no interval found", () => {
		expect(parseNaturalLanguageLoop("check ci please")).toBeNull();
	});

	test("returns null when no prompt remains", () => {
		expect(parseNaturalLanguageLoop("every 2m")).toBeNull();
	});

	// ── Condition extraction ─────────────────────────────────────────

	test("extracts 'until' condition at end", () => {
		const result = parseNaturalLanguageLoop("check ci every 2 minutes until it passes");
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: null,
			untilCondition: "it passes",
		});
	});

	test("extracts 'stop when' condition at end", () => {
		const result = parseNaturalLanguageLoop("run tests every 30s, stop when they pass");
		expect(result).toEqual({
			action: "start",
			intervalMs: 30_000,
			intervalLabel: "30s",
			prompt: "run tests",
			maxIterations: null,
			untilCondition: "they pass",
		});
	});

	test("extracts condition at start with comma separator", () => {
		const result = parseNaturalLanguageLoop("until the build passes, check ci every 2m");
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: null,
			untilCondition: "the build passes",
		});
	});

	test("strips quotes from NL condition", () => {
		const result = parseNaturalLanguageLoop('check ci every 2m until "the build is green"');
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: null,
			untilCondition: "the build is green",
		});
	});

	test("strips trailing punctuation from condition", () => {
		const result = parseNaturalLanguageLoop("check ci every 2m until it passes.");
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: null,
			untilCondition: "it passes",
		});
	});

	// ── Max iterations extraction ────────────────────────────────────

	test("extracts 'N times'", () => {
		const result = parseNaturalLanguageLoop("check ci every 2m 10 times");
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: 10,
			untilCondition: null,
		});
	});

	test("extracts 'max N'", () => {
		const result = parseNaturalLanguageLoop("check ci every 2m max 20");
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: 20,
			untilCondition: null,
		});
	});

	test("extracts 'max N tries'", () => {
		const result = parseNaturalLanguageLoop("monitor deploy health every minute, max 20 tries");
		expect(result).toEqual({
			action: "start",
			intervalMs: 60_000,
			intervalLabel: "1m",
			prompt: "monitor deploy health",
			maxIterations: 20,
			untilCondition: null,
		});
	});

	test("extracts 'at most N'", () => {
		const result = parseNaturalLanguageLoop("check ci every 5m at most 15");
		expect(result).toEqual({
			action: "start",
			intervalMs: 300_000,
			intervalLabel: "5m",
			prompt: "check ci",
			maxIterations: 15,
			untilCondition: null,
		});
	});

	test("extracts x<N> in NL context", () => {
		const result = parseNaturalLanguageLoop("check ci every 2m x10");
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: 10,
			untilCondition: null,
		});
	});

	// ── Combined: all features ───────────────────────────────────────

	test("extracts interval + condition + max iterations", () => {
		const result = parseNaturalLanguageLoop(
			"run tests every 30 seconds, max 20, until they all pass"
		);
		expect(result).toEqual({
			action: "start",
			intervalMs: 30_000,
			intervalLabel: "30s",
			prompt: "run tests",
			maxIterations: 20,
			untilCondition: "they all pass",
		});
	});

	test("handles realistic CI monitoring request", () => {
		const result = parseNaturalLanguageLoop(
			"check the latest GitHub Actions run for this branch every 2 minutes until the latest CI run is green"
		);
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check the latest GitHub Actions run for this branch",
			maxIterations: null,
			untilCondition: "the latest CI run is green",
		});
	});

	test("handles 'stop when' with comma", () => {
		const result = parseNaturalLanguageLoop("run the test suite every 30s, stop when tests pass");
		expect(result).toEqual({
			action: "start",
			intervalMs: 30_000,
			intervalLabel: "30s",
			prompt: "run the test suite",
			maxIterations: null,
			untilCondition: "tests pass",
		});
	});

	// ── Interval position doesn't matter ─────────────────────────────

	test("interval at start of text", () => {
		const result = parseNaturalLanguageLoop("every 5 minutes check if the build finished");
		expect(result).toEqual({
			action: "start",
			intervalMs: 300_000,
			intervalLabel: "5m",
			prompt: "check if the build finished",
			maxIterations: null,
			untilCondition: null,
		});
	});

	test("interval in middle of text", () => {
		const result = parseNaturalLanguageLoop("check ci every 2m until it's green");
		expect(result).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: null,
			untilCondition: "it's green",
		});
	});
});

// ── buildLoopCommand ─────────────────────────────────────────────────────

describe("buildLoopCommand", () => {
	test("builds simple command", () => {
		expect(
			buildLoopCommand({
				action: "start",
				intervalMs: 300_000,
				intervalLabel: "5m",
				prompt: "check deploy",
				maxIterations: null,
				untilCondition: null,
			})
		).toBe("/loop 5m check deploy");
	});

	test("includes max iterations", () => {
		expect(
			buildLoopCommand({
				action: "start",
				intervalMs: 60_000,
				intervalLabel: "1m",
				prompt: "run tests",
				maxIterations: 10,
				untilCondition: null,
			})
		).toBe("/loop 1m x10 run tests");
	});

	test("includes until condition", () => {
		expect(
			buildLoopCommand({
				action: "start",
				intervalMs: 120_000,
				intervalLabel: "2m",
				prompt: "check ci",
				maxIterations: null,
				untilCondition: "build is green",
			})
		).toBe('/loop 2m until "build is green" check ci');
	});

	test("includes both max iterations and condition", () => {
		expect(
			buildLoopCommand({
				action: "start",
				intervalMs: 30_000,
				intervalLabel: "30s",
				prompt: "run the test suite",
				maxIterations: 50,
				untilCondition: "tests pass",
			})
		).toBe('/loop 30s x50 until "tests pass" run the test suite');
	});

	test("round-trips through parseLoopArgs", () => {
		const nl = parseNaturalLanguageLoop("check ci every 2 minutes until the build passes");
		if (!nl) throw new Error("Expected NL parse to succeed");
		const command = buildLoopCommand(nl);
		const strict = parseLoopArgs(command.replace(/^\/loop\s+/, ""));
		expect(strict).toEqual({
			action: "start",
			intervalMs: 120_000,
			intervalLabel: "2m",
			prompt: "check ci",
			maxIterations: null,
			untilCondition: "the build passes",
		});
	});
});
