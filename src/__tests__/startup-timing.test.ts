/**
 * Tests for src/startup-timing.ts — timing emission, env-gating, and output format.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	emitStartupTiming,
	isStartupTimingEnabled,
	STARTUP_TIMING_PREFIX,
} from "../startup-timing.js";

/** Original env value for TALLOW_STARTUP_TIMING. */
let originalTimingEnv: string | undefined;

/** Captured stderr writes during a test. */
let stderrWrites: string[];

/** Original process.stderr.write before monkey-patching. */
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
	originalTimingEnv = process.env.TALLOW_STARTUP_TIMING;
	stderrWrites = [];
	originalStderrWrite = process.stderr.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stderr.write;
});

afterEach(() => {
	process.stderr.write = originalStderrWrite;
	if (originalTimingEnv !== undefined) {
		process.env.TALLOW_STARTUP_TIMING = originalTimingEnv;
	} else {
		delete process.env.TALLOW_STARTUP_TIMING;
	}
});

// ─── isStartupTimingEnabled ──────────────────────────────────────────────────

describe("isStartupTimingEnabled", () => {
	test("returns false when env var is not set", () => {
		delete process.env.TALLOW_STARTUP_TIMING;
		expect(isStartupTimingEnabled()).toBe(false);
	});

	test("returns false for empty string", () => {
		process.env.TALLOW_STARTUP_TIMING = "";
		expect(isStartupTimingEnabled()).toBe(false);
	});

	test("returns true for '1'", () => {
		process.env.TALLOW_STARTUP_TIMING = "1";
		expect(isStartupTimingEnabled()).toBe(true);
	});

	test("returns true for 'true'", () => {
		process.env.TALLOW_STARTUP_TIMING = "true";
		expect(isStartupTimingEnabled()).toBe(true);
	});

	test("returns true for arbitrary non-disabled values", () => {
		process.env.TALLOW_STARTUP_TIMING = "verbose";
		expect(isStartupTimingEnabled()).toBe(true);
	});

	test("returns false for '0'", () => {
		process.env.TALLOW_STARTUP_TIMING = "0";
		expect(isStartupTimingEnabled()).toBe(false);
	});

	test("returns false for 'false'", () => {
		process.env.TALLOW_STARTUP_TIMING = "false";
		expect(isStartupTimingEnabled()).toBe(false);
	});

	test("returns false for 'off'", () => {
		process.env.TALLOW_STARTUP_TIMING = "off";
		expect(isStartupTimingEnabled()).toBe(false);
	});

	test("returns false for 'no'", () => {
		process.env.TALLOW_STARTUP_TIMING = "no";
		expect(isStartupTimingEnabled()).toBe(false);
	});

	test("disabled values are case-insensitive", () => {
		process.env.TALLOW_STARTUP_TIMING = "FALSE";
		expect(isStartupTimingEnabled()).toBe(false);

		process.env.TALLOW_STARTUP_TIMING = "Off";
		expect(isStartupTimingEnabled()).toBe(false);

		process.env.TALLOW_STARTUP_TIMING = "NO";
		expect(isStartupTimingEnabled()).toBe(false);
	});

	test("trims whitespace from disabled values", () => {
		process.env.TALLOW_STARTUP_TIMING = "  false  ";
		expect(isStartupTimingEnabled()).toBe(false);
	});
});

// ─── emitStartupTiming ──────────────────────────────────────────────────────

describe("emitStartupTiming", () => {
	test("writes nothing when timing is disabled", () => {
		delete process.env.TALLOW_STARTUP_TIMING;
		emitStartupTiming("test_metric", 42.123456);
		expect(stderrWrites).toHaveLength(0);
	});

	test("writes JSON payload when timing is enabled", () => {
		process.env.TALLOW_STARTUP_TIMING = "1";
		emitStartupTiming("extension_load", 123.456789);

		expect(stderrWrites).toHaveLength(1);
		const line = stderrWrites[0];
		expect(line).toStartWith(STARTUP_TIMING_PREFIX);
		expect(line).toEndWith("\n");

		const jsonPart = line.slice(STARTUP_TIMING_PREFIX.length + 1, -1);
		const payload = JSON.parse(jsonPart) as {
			metric: string;
			milliseconds: number;
			ts: string;
		};
		expect(payload.metric).toBe("extension_load");
		expect(payload.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("rounds milliseconds to 3 decimal places", () => {
		process.env.TALLOW_STARTUP_TIMING = "1";
		emitStartupTiming("rounding_test", 1.23456789);

		const line = stderrWrites[0];
		const jsonPart = line.slice(STARTUP_TIMING_PREFIX.length + 1, -1);
		const payload = JSON.parse(jsonPart) as { milliseconds: number };
		expect(payload.milliseconds).toBe(1.235);
	});

	test("rounds whole numbers cleanly", () => {
		process.env.TALLOW_STARTUP_TIMING = "1";
		emitStartupTiming("whole_test", 100);

		const line = stderrWrites[0];
		const jsonPart = line.slice(STARTUP_TIMING_PREFIX.length + 1, -1);
		const payload = JSON.parse(jsonPart) as { milliseconds: number };
		expect(payload.milliseconds).toBe(100);
	});

	test("includes metadata in payload", () => {
		process.env.TALLOW_STARTUP_TIMING = "1";
		emitStartupTiming("meta_test", 50, { extensionName: "mcp-adapter", count: 3 });

		const line = stderrWrites[0];
		const jsonPart = line.slice(STARTUP_TIMING_PREFIX.length + 1, -1);
		const payload = JSON.parse(jsonPart) as {
			metric: string;
			extensionName: string;
			count: number;
		};
		expect(payload.extensionName).toBe("mcp-adapter");
		expect(payload.count).toBe(3);
	});

	test("uses STARTUP_TIMING_PREFIX constant as line prefix", () => {
		expect(STARTUP_TIMING_PREFIX).toBe("TALLOW_STARTUP_TIMING");
	});

	test("output format matches TALLOW_STARTUP_TIMING {json}", () => {
		process.env.TALLOW_STARTUP_TIMING = "1";
		emitStartupTiming("format_test", 0);

		const line = stderrWrites[0];
		// Format: "TALLOW_STARTUP_TIMING {json}\n"
		expect(line).toMatch(new RegExp(`^${STARTUP_TIMING_PREFIX} \\{.+\\}\n$`));
	});
});
