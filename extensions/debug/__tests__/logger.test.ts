import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebugLogger, isDebug, resetDebugCache } from "../logger.js";

let tmpDir: string;
const savedDebug = process.env.TALLOW_DEBUG;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tallow-debug-test-"));
	// Ensure no leaked TALLOW_DEBUG from other test files
	delete process.env.TALLOW_DEBUG;
	resetDebugCache();
});

afterEach(() => {
	// Restore original state before cleanup
	if (savedDebug !== undefined) {
		process.env.TALLOW_DEBUG = savedDebug;
	} else {
		delete process.env.TALLOW_DEBUG;
	}
	rmSync(tmpDir, { recursive: true, force: true });
});

// ── isDebug() ────────────────────────────────────────────────

describe("isDebug()", () => {
	const origEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...origEnv };
		resetDebugCache();
	});

	it("returns true when TALLOW_DEBUG=1", () => {
		process.env.TALLOW_DEBUG = "1";
		expect(isDebug()).toBe(true);
	});

	it("returns true when TALLOW_DEBUG=stderr", () => {
		process.env.TALLOW_DEBUG = "stderr";
		expect(isDebug()).toBe(true);
	});

	it("returns true when NODE_ENV=development", () => {
		delete process.env.TALLOW_DEBUG;
		process.env.NODE_ENV = "development";
		expect(isDebug()).toBe(true);
	});

	it("returns false when TALLOW_DEBUG=0", () => {
		process.env.TALLOW_DEBUG = "0";
		delete process.env.NODE_ENV;
		// Can't reliably test source detection in bun — force production-like
		expect(isDebug()).toBe(false);
	});

	it("returns false when TALLOW_DEBUG=false", () => {
		process.env.TALLOW_DEBUG = "false";
		delete process.env.NODE_ENV;
		expect(isDebug()).toBe(false);
	});

	it("caches result after first call", () => {
		process.env.TALLOW_DEBUG = "1";
		expect(isDebug()).toBe(true);

		// Change env — should still return cached value
		process.env.TALLOW_DEBUG = "0";
		expect(isDebug()).toBe(true);
	});
});

// ── DebugLogger.log() ────────────────────────────────────────

describe("DebugLogger.log()", () => {
	it("writes valid JSONL to file", () => {
		const logger = new DebugLogger("test-session-1", tmpDir);
		logger.log("tool", "call", { name: "bash", args: { command: "ls" } });
		logger.close();

		const logPath = join(tmpDir, "debug.log");
		expect(existsSync(logPath)).toBe(true);

		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		// First line is the log_start header, second is our entry
		expect(lines.length).toBe(2);

		const header = JSON.parse(lines[0]);
		expect(header.cat).toBe("session");
		expect(header.evt).toBe("log_start");
		expect(header.data.sessionId).toBe("test-session-1");

		const entry = JSON.parse(lines[1]);
		expect(entry.cat).toBe("tool");
		expect(entry.evt).toBe("call");
		expect(entry.data.name).toBe("bash");
		expect(entry.data.args).toEqual({ command: "ls" });
	});

	it("includes ISO timestamp", () => {
		const logger = new DebugLogger("test-ts", tmpDir);
		logger.log("session", "test", { foo: "bar" });
		logger.close();

		const lines = readFileSync(join(tmpDir, "debug.log"), "utf-8").trim().split("\n");
		const entry = JSON.parse(lines[1]);
		// ISO 8601 format check
		expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it("truncates long string values at 500 chars", () => {
		const logger = new DebugLogger("test-trunc", tmpDir);
		const longString = "x".repeat(1000);
		logger.log("tool", "result", { output: longString });
		logger.close();

		const lines = readFileSync(join(tmpDir, "debug.log"), "utf-8").trim().split("\n");
		const entry = JSON.parse(lines[1]);
		expect(entry.data.output.length).toBeLessThan(600);
		expect(entry.data.output).toContain("…[1000 chars]");
	});

	it("truncates nested object string values", () => {
		const logger = new DebugLogger("test-nested", tmpDir);
		const longString = "y".repeat(800);
		logger.log("tool", "call", { args: { command: longString } });
		logger.close();

		const lines = readFileSync(join(tmpDir, "debug.log"), "utf-8").trim().split("\n");
		const entry = JSON.parse(lines[1]);
		expect(entry.data.args.command).toContain("…[800 chars]");
	});

	it("preserves short string values intact", () => {
		const logger = new DebugLogger("test-short", tmpDir);
		logger.log("session", "start", { cwd: "/dev/project" });
		logger.close();

		const lines = readFileSync(join(tmpDir, "debug.log"), "utf-8").trim().split("\n");
		const entry = JSON.parse(lines[1]);
		expect(entry.data.cwd).toBe("/dev/project");
	});
});

// ── DebugLogger.close() ─────────────────────────────────────

describe("DebugLogger.close()", () => {
	it("makes subsequent log() calls no-ops", () => {
		const logger = new DebugLogger("test-close", tmpDir);
		logger.close();
		logger.log("session", "after_close", { should: "not appear" });

		const logPath = join(tmpDir, "debug.log");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		// Only the header line from construction
		expect(lines.length).toBe(1);
		expect(JSON.parse(lines[0]).evt).toBe("log_start");
	});
});

// ── DebugLogger.clear() ─────────────────────────────────────

describe("DebugLogger.clear()", () => {
	it("truncates the log file", () => {
		const logger = new DebugLogger("test-clear", tmpDir);
		logger.log("session", "test", { data: "will be cleared" });
		logger.clear();

		const logPath = join(tmpDir, "debug.log");
		const content = readFileSync(logPath, "utf-8");
		expect(content).toBe("");

		logger.close();
	});
});

// ── stderr mode ──────────────────────────────────────────────

describe("stderr mode", () => {
	const origEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...origEnv };
	});

	it("does not create a file when TALLOW_DEBUG=stderr", () => {
		process.env.TALLOW_DEBUG = "stderr";
		const stderrDir = join(tmpDir, "stderr-test");
		mkdirSync(stderrDir, { recursive: true });

		const logger = new DebugLogger("test-stderr", stderrDir);
		logger.log("session", "test", { mode: "stderr" });
		logger.close();

		// No log file should be created (writes go to stderr)
		const logPath = join(stderrDir, "debug.log");
		expect(existsSync(logPath)).toBe(false);
	});
});
