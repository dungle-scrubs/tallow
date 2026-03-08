/**
 * Unit tests for the loop extension's pure helpers.
 *
 * Tests interval parsing, countdown formatting, and argument parsing.
 * Integration tests for the full loop lifecycle live in
 * `extensions/__integration__/loop.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { formatCountdown, parseInterval, parseLoopArgs } from "../index.js";

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
		});
	});

	test("slash commands work as prompts", () => {
		const result = parseLoopArgs("30s /stats");
		expect(result).toEqual({
			action: "start",
			intervalMs: 30_000,
			intervalLabel: "30s",
			prompt: "/stats",
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
		});
	});
});
