import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebugLogger, type LogEntry } from "../logger.js";

let tmpDir: string;
const savedDebug = process.env.TALLOW_DEBUG;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tallow-debug-ext-test-"));
	// Ensure file-based logging — clear leaked TALLOW_DEBUG=stderr from other tests
	delete process.env.TALLOW_DEBUG;
});

afterEach(() => {
	if (savedDebug !== undefined) {
		process.env.TALLOW_DEBUG = savedDebug;
	} else {
		delete process.env.TALLOW_DEBUG;
	}
	rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Parses all JSONL entries from the debug log file.
 * @param logPath - Path to the log file
 * @returns Array of parsed log entries
 */
function readEntries(logPath: string): LogEntry[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * Finds an entry by category and event, failing the test if not found.
 * @param entries - Array of log entries to search
 * @param cat - Category to match
 * @param evt - Event to match
 * @returns The matching entry (asserted to exist)
 */
function findEntry(entries: LogEntry[], cat: string, evt: string): LogEntry {
	const entry = entries.find((e) => e.cat === cat && e.evt === evt);
	expect(entry).toBeDefined();
	return entry as LogEntry;
}

// ── Tool duration tracking ───────────────────────────────────

describe("tool duration tracking", () => {
	it("logs tool_call with start and tool_result with duration", () => {
		const logger = new DebugLogger("test-tool-dur", tmpDir);

		// Simulate tool_call → tool_result with timing
		const startTime = performance.now();
		logger.log("tool", "call", {
			toolCallId: "tc_1",
			name: "bash",
			args: { command: "ls" },
		});

		// Small delay for measurable duration
		const busyWait = performance.now() + 5;
		while (performance.now() < busyWait) {
			/* spin */
		}

		const durationMs = Math.round(performance.now() - startTime);
		logger.log("tool", "result", {
			toolCallId: "tc_1",
			name: "bash",
			durationMs,
			ok: true,
			contentLength: 42,
		});

		logger.close();

		const entries = readEntries(join(tmpDir, "debug.log"));
		const callEntry = findEntry(entries, "tool", "call");
		const resultEntry = findEntry(entries, "tool", "result");

		expect(callEntry.data.toolCallId).toBe("tc_1");
		expect(callEntry.data.name).toBe("bash");

		expect(resultEntry.data.toolCallId).toBe("tc_1");
		expect(resultEntry.data.durationMs).toBeGreaterThan(0);
		expect(resultEntry.data.ok).toBe(true);
	});

	it("handles concurrent tool calls with different IDs", () => {
		const logger = new DebugLogger("test-concurrent", tmpDir);

		// Two concurrent tool calls
		logger.log("tool", "call", { toolCallId: "tc_a", name: "read" });
		logger.log("tool", "call", { toolCallId: "tc_b", name: "bash" });

		// Results in reverse order
		logger.log("tool", "result", { toolCallId: "tc_b", name: "bash", durationMs: 50, ok: true });
		logger.log("tool", "result", { toolCallId: "tc_a", name: "read", durationMs: 100, ok: true });

		logger.close();

		const entries = readEntries(join(tmpDir, "debug.log"));
		const results = entries.filter((e) => e.cat === "tool" && e.evt === "result");
		expect(results.length).toBe(2);

		// tc_b finished first
		expect(results[0].data.toolCallId).toBe("tc_b");
		expect(results[1].data.toolCallId).toBe("tc_a");
	});
});

// ── Session lifecycle ────────────────────────────────────────

describe("session lifecycle logging", () => {
	it("logs session start with model, cwd, and extensions", () => {
		const logger = new DebugLogger("test-session", tmpDir);

		logger.log("session", "start", {
			cwd: "/dev/project",
			sessionId: "test-session",
			model: "anthropic/claude-sonnet-4",
			tools: ["bash", "read", "edit", "write"],
		});

		logger.close();

		const entries = readEntries(join(tmpDir, "debug.log"));
		const startEntry = findEntry(entries, "session", "start");
		expect(startEntry.data.model).toBe("anthropic/claude-sonnet-4");
		expect(startEntry.data.cwd).toBe("/dev/project");
		expect(startEntry.data.tools).toEqual(["bash", "read", "edit", "write"]);
	});

	it("logs session shutdown with summary stats", () => {
		const logger = new DebugLogger("test-shutdown", tmpDir);

		logger.log("session", "shutdown", {
			durationMs: 5000,
			totalToolCalls: 12,
			totalTurns: 3,
		});

		logger.close();

		const entries = readEntries(join(tmpDir, "debug.log"));
		const shutdownEntry = findEntry(entries, "session", "shutdown");
		expect(shutdownEntry.data.durationMs).toBe(5000);
		expect(shutdownEntry.data.totalToolCalls).toBe(12);
		expect(shutdownEntry.data.totalTurns).toBe(3);
	});
});

// ── Zero-cost when disabled ──────────────────────────────────

describe("zero-cost when disabled", () => {
	it("logger.log() after close is a no-op", () => {
		const logger = new DebugLogger("test-noop", tmpDir);
		const logPath = join(tmpDir, "debug.log");
		logger.close();

		// Read file size after close (just the header)
		const sizeBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;

		// These should be no-ops
		logger.log("tool", "call", { name: "bash" });
		logger.log("tool", "result", { name: "bash", durationMs: 10 });

		const sizeAfter = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
		expect(sizeAfter).toBe(sizeBefore);
	});
});
