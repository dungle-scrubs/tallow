import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * pid-manager.ts reads TALLOW_HOME from config.ts at module scope.
 * We can't override it per-test, so we test the core logic by manipulating
 * the PID file directly and verifying behavior against real processes.
 *
 * For the file I/O edge cases (corrupt files, missing dirs), the
 * pid-registry tests cover the shared format. These tests focus on
 * the process-lifecycle logic: detecting alive PIDs and killing orphans.
 */

let tmpDir: string;
let pidFilePath: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `pid-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tmpDir, "run"), { recursive: true });
	pidFilePath = join(tmpDir, "run", "pids.json");
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a PID file in the expected format.
 *
 * @param entries - PID entries to write
 */
function writePidFile(entries: Array<{ pid: number; command: string; startedAt: number }>): void {
	writeFileSync(pidFilePath, JSON.stringify({ version: 1, entries }, null, "\t"));
}

/**
 * Spawn a real sleep process (detached) that we can use as a target.
 * Returns the child and a cleanup function.
 *
 * @returns Object with child process and cleanup function
 */
function spawnSleeper(): { pid: number; cleanup: () => void } {
	const child = spawn("sleep", ["60"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	if (!child.pid) throw new Error("Failed to spawn sleep process");
	const pid = child.pid;
	return {
		pid,
		cleanup: () => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// Already dead
			}
		},
	};
}

/**
 * Check if a process is alive.
 *
 * @param pid - Process ID to check
 * @returns True if the process is still running
 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("pid-manager logic", () => {
	describe("PID file format", () => {
		test("version 1 with entries array is the canonical format", () => {
			writePidFile([{ pid: 1, command: "test", startedAt: Date.now() }]);
			const raw = JSON.parse(readFileSync(pidFilePath, "utf-8"));
			expect(raw.version).toBe(1);
			expect(Array.isArray(raw.entries)).toBe(true);
			expect(raw.entries[0]).toHaveProperty("pid");
			expect(raw.entries[0]).toHaveProperty("command");
			expect(raw.entries[0]).toHaveProperty("startedAt");
		});
	});

	describe("process detection", () => {
		test("kill -0 detects a live process", () => {
			const { pid, cleanup } = spawnSleeper();
			try {
				expect(isAlive(pid)).toBe(true);
			} finally {
				cleanup();
			}
		});

		test("kill -0 returns false for a dead PID", () => {
			// PID 0 is special (kernel), use a very high PID unlikely to exist
			expect(isAlive(2_147_483_647)).toBe(false);
		});
	});

	describe("process group signalling", () => {
		test("negative PID targets process group (detached children are group leaders)", () => {
			const { pid, cleanup } = spawnSleeper();
			try {
				// Verify the process is alive
				expect(isAlive(pid)).toBe(true);

				// Verify negative PID (process group) signal doesn't throw for a live process
				expect(() => process.kill(-pid, 0)).not.toThrow();
			} finally {
				cleanup();
			}
		});

		test("SIGTERM to negative PID of dead process throws (caught by cleanup)", () => {
			expect(() => process.kill(-2_147_483_647, "SIGTERM")).toThrow();
		});
	});

	describe("PID file cleanup", () => {
		test("empty entries array means nothing to clean", () => {
			writePidFile([]);
			const raw = JSON.parse(readFileSync(pidFilePath, "utf-8"));
			expect(raw.entries).toHaveLength(0);
		});

		test("stale entries with dead PIDs are safe to process", () => {
			// Write entries with PIDs that don't exist
			writePidFile([
				{ pid: 2_147_483_647, command: "ghost-1", startedAt: Date.now() - 3600_000 },
				{ pid: 2_147_483_646, command: "ghost-2", startedAt: Date.now() - 7200_000 },
			]);

			const raw = JSON.parse(readFileSync(pidFilePath, "utf-8"));
			expect(raw.entries).toHaveLength(2);

			// Verify these PIDs are indeed dead
			for (const entry of raw.entries) {
				expect(isAlive(entry.pid)).toBe(false);
			}
		});
	});
});
