import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set env before importing the module under test (it reads TALLOW_CODING_AGENT_DIR at call time)
let tmpDir: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `pid-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env.TALLOW_CODING_AGENT_DIR = tmpDir;
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.TALLOW_CODING_AGENT_DIR;
});

// Dynamic import so each test gets the env var set above
async function loadModule() {
	// Bust the module cache by using a unique query string
	const mod = await import(`../pid-registry.js?t=${Date.now()}`);
	return mod as typeof import("../pid-registry.js");
}

/**
 * Read the raw PID file from the temp directory.
 *
 * @returns Parsed JSON contents
 */
function readRawPidFile(): {
	version: number;
	entries: Array<{ pid: number; command: string; startedAt: number }>;
} {
	const path = join(tmpDir, "run", "pids.json");
	return JSON.parse(readFileSync(path, "utf-8"));
}

describe("pid-registry", () => {
	describe("registerPid", () => {
		test("creates run directory and PID file on first call", async () => {
			const { registerPid } = await loadModule();
			registerPid(12345, "npm test");

			const file = readRawPidFile();
			expect(file.version).toBe(1);
			expect(file.entries).toHaveLength(1);
			expect(file.entries[0].pid).toBe(12345);
			expect(file.entries[0].command).toBe("npm test");
			expect(typeof file.entries[0].startedAt).toBe("number");
		});

		test("appends to existing entries", async () => {
			const { registerPid } = await loadModule();
			registerPid(100, "cmd-a");
			registerPid(200, "cmd-b");

			const file = readRawPidFile();
			expect(file.entries).toHaveLength(2);
			expect(file.entries[0].pid).toBe(100);
			expect(file.entries[1].pid).toBe(200);
		});

		test("ignores duplicate PIDs", async () => {
			const { registerPid } = await loadModule();
			registerPid(100, "cmd-a");
			registerPid(100, "cmd-a-again");

			const file = readRawPidFile();
			expect(file.entries).toHaveLength(1);
			expect(file.entries[0].command).toBe("cmd-a");
		});
	});

	describe("unregisterPid", () => {
		test("removes a registered PID", async () => {
			const { registerPid, unregisterPid } = await loadModule();
			registerPid(100, "cmd-a");
			registerPid(200, "cmd-b");
			unregisterPid(100);

			const file = readRawPidFile();
			expect(file.entries).toHaveLength(1);
			expect(file.entries[0].pid).toBe(200);
		});

		test("no-ops when PID is not in file", async () => {
			const { registerPid, unregisterPid } = await loadModule();
			registerPid(100, "cmd-a");
			unregisterPid(999);

			const file = readRawPidFile();
			expect(file.entries).toHaveLength(1);
		});

		test("no-ops when PID file does not exist", async () => {
			const { unregisterPid } = await loadModule();
			// Should not throw
			unregisterPid(999);
		});
	});

	describe("corrupt/missing file handling", () => {
		test("handles corrupt JSON gracefully", async () => {
			const runDir = join(tmpDir, "run");
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "pids.json"), "NOT VALID JSON{{{");

			const { registerPid } = await loadModule();
			registerPid(100, "cmd-a");

			const file = readRawPidFile();
			expect(file.version).toBe(1);
			expect(file.entries).toHaveLength(1);
		});

		test("handles wrong version gracefully", async () => {
			const runDir = join(tmpDir, "run");
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "pids.json"), JSON.stringify({ version: 99, entries: [] }));

			const { registerPid } = await loadModule();
			registerPid(100, "cmd-a");

			const file = readRawPidFile();
			expect(file.version).toBe(1);
			expect(file.entries).toHaveLength(1);
		});

		test("handles missing entries array gracefully", async () => {
			const runDir = join(tmpDir, "run");
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "pids.json"), JSON.stringify({ version: 1 }));

			const { registerPid } = await loadModule();
			registerPid(100, "cmd-a");

			const file = readRawPidFile();
			expect(file.entries).toHaveLength(1);
		});
	});
});
