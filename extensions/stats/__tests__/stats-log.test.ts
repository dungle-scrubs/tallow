/**
 * Tests for stats-log JSONL persistence: append, read, countSessions.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SessionStats } from "../stats-log.js";
import { appendStats, countSessions, readAllStats } from "../stats-log.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Creates a minimal valid SessionStats for testing. */
function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
	return {
		sessionId: "test-session-1",
		startTime: "2026-02-15T10:00:00Z",
		endTime: "2026-02-15T10:30:00Z",
		durationMs: 1_800_000,
		model: "claude-sonnet-4-5",
		cwd: "/tmp/test",
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

// ── Test setup ───────────────────────────────────────────────────────────────

let tmpDir: string;
let logPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-test-"));
	logPath = path.join(tmpDir, "stats.jsonl");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── readAllStats ─────────────────────────────────────────────────────────────

describe("readAllStats", () => {
	it("returns empty array when file does not exist", () => {
		expect(readAllStats(logPath)).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		fs.writeFileSync(logPath, "");
		expect(readAllStats(logPath)).toEqual([]);
	});

	it("skips malformed lines", () => {
		fs.writeFileSync(logPath, "not json\n{bad\n");
		expect(readAllStats(logPath)).toEqual([]);
	});

	it("reads valid entries", () => {
		const stats = makeStats();
		fs.writeFileSync(logPath, `${JSON.stringify(stats)}\n`);

		const result = readAllStats(logPath);
		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe("test-session-1");
		expect(result[0].totalCost).toBe(0.05);
	});

	it("reads multiple entries preserving order", () => {
		const s1 = makeStats({ sessionId: "s1" });
		const s2 = makeStats({ sessionId: "s2" });
		fs.writeFileSync(logPath, `${JSON.stringify(s1)}\n${JSON.stringify(s2)}\n`);

		const result = readAllStats(logPath);
		expect(result).toHaveLength(2);
		expect(result[0].sessionId).toBe("s1");
		expect(result[1].sessionId).toBe("s2");
	});

	it("skips malformed lines but keeps valid ones", () => {
		const valid = makeStats({ sessionId: "valid" });
		fs.writeFileSync(logPath, `garbage\n${JSON.stringify(valid)}\n{broken\n`);

		const result = readAllStats(logPath);
		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe("valid");
	});
});

// ── appendStats ──────────────────────────────────────────────────────────────

describe("appendStats", () => {
	it("creates file and parent dirs if missing", () => {
		const nested = path.join(tmpDir, "a", "b", "stats.jsonl");
		appendStats(makeStats(), nested);

		expect(fs.existsSync(nested)).toBe(true);
		const result = readAllStats(nested);
		expect(result).toHaveLength(1);
	});

	it("appends to existing file", () => {
		appendStats(makeStats({ sessionId: "first" }), logPath);
		appendStats(makeStats({ sessionId: "second" }), logPath);

		const result = readAllStats(logPath);
		expect(result).toHaveLength(2);
		expect(result[0].sessionId).toBe("first");
		expect(result[1].sessionId).toBe("second");
	});

	it("writes valid JSON per line", () => {
		appendStats(makeStats(), logPath);

		const raw = fs.readFileSync(logPath, "utf-8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(() => JSON.parse(lines[0])).not.toThrow();
	});
});

// ── countSessions ────────────────────────────────────────────────────────────

describe("countSessions", () => {
	it("returns 0 when file does not exist", () => {
		expect(countSessions(logPath)).toBe(0);
	});

	it("counts non-empty lines", () => {
		appendStats(makeStats({ sessionId: "a" }), logPath);
		appendStats(makeStats({ sessionId: "b" }), logPath);
		appendStats(makeStats({ sessionId: "c" }), logPath);

		expect(countSessions(logPath)).toBe(3);
	});
});
