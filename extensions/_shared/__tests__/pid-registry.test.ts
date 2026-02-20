import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStaticRuntimePathProvider } from "../../../src/runtime-path-provider.js";

// Set env before importing the module under test (it reads TALLOW_CODING_AGENT_DIR at call time)
let tmpDir: string;
const spawnedPids = new Set<number>();

beforeEach(() => {
	tmpDir = join(tmpdir(), `pid-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env.TALLOW_CODING_AGENT_DIR = tmpDir;
});

afterEach(() => {
	for (const pid of spawnedPids) {
		killProcessGroup(pid, "SIGKILL");
	}
	spawnedPids.clear();
	rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.TALLOW_CODING_AGENT_DIR;
});

// Dynamic import so each test gets the env var set above
async function loadModule() {
	// Bust the module cache by using a unique query string
	const mod = (await import(
		`../pid-registry.js?t=${Date.now()}`
	)) as typeof import("../pid-registry.js");
	mod.setPidRegistryPathProviderForTests(createStaticRuntimePathProvider(tmpDir));
	return mod;
}

/**
 * List all session-scoped PID files in the temp directory.
 *
 * @returns Absolute paths to session PID files
 */
function listSessionPidFiles(): string[] {
	const dir = join(tmpDir, "run", "pids");
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir)
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => join(dir, entry));
}

/**
 * Read the single session PID file used by this process.
 *
 * @returns Parsed JSON contents
 */
function readRawPidFile(): {
	version: number;
	owner: {
		pid: number;
		startedAt?: string;
	};
	entries: Array<{
		pid: number;
		command: string;
		ownerPid?: number;
		ownerStartedAt?: string;
		processStartedAt?: string;
		startedAt: number;
	}>;
} {
	const files = listSessionPidFiles();
	if (files.length !== 1) {
		throw new Error(`Expected exactly one session PID file, got ${files.length}`);
	}
	return JSON.parse(readFileSync(files[0], "utf-8"));
}

/**
 * Spawn a detached `sleep` process for metadata tests.
 *
 * @returns PID of the spawned process
 * @throws {Error} When spawning fails
 */
function spawnSleeper(): number {
	const child = spawn("sleep", ["60"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	if (!child.pid) {
		throw new Error("Failed to spawn sleep process");
	}
	spawnedPids.add(child.pid);
	return child.pid;
}

/**
 * Signal a detached process group for cleanup.
 *
 * @param pid - Group leader PID
 * @param signal - Signal to deliver
 * @returns Nothing
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// Already dead
	}
}

/**
 * Read process start metadata from `ps` for assertion parity.
 *
 * @param pid - Process ID to inspect
 * @returns Process start string, or null when unavailable
 */
function readProcessStartedAt(pid: number): string | null {
	const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.error || result.status !== 0) {
		return null;
	}
	const startedAt = result.stdout.trim();
	return startedAt.length > 0 ? startedAt : null;
}

/**
 * Resolve the expected session PID file path for the current process.
 *
 * @returns Session PID file path
 */
function getCurrentSessionPidFilePath(): string {
	const startedAt = readProcessStartedAt(process.pid) ?? "unknown";
	const startedAtSlug = startedAt
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const normalizedStartedAt = startedAtSlug.length > 0 ? startedAtSlug : "unknown";
	return join(tmpDir, "run", "pids", `${process.pid}-${normalizedStartedAt}.json`);
}

describe("pid-registry", () => {
	describe("registerPid", () => {
		test("creates run directory and PID file on first call", async () => {
			const { registerPid } = await loadModule();
			registerPid(12345, "npm test");

			const file = readRawPidFile();
			expect(file.version).toBe(2);
			expect(file.owner.pid).toBe(process.pid);
			expect(file.entries).toHaveLength(1);
			expect(file.entries[0].pid).toBe(12345);
			expect(file.entries[0].command).toBe("npm test");
			expect(file.entries[0].ownerPid).toBe(process.pid);
			expect(typeof file.entries[0].startedAt).toBe("number");
			if (file.entries[0].ownerStartedAt !== undefined) {
				expect(typeof file.entries[0].ownerStartedAt).toBe("string");
			}
			if (file.entries[0].processStartedAt !== undefined) {
				expect(typeof file.entries[0].processStartedAt).toBe("string");
			}
		});

		test("stores processStartedAt metadata when available", async () => {
			const { registerPid } = await loadModule();
			const pid = spawnSleeper();
			const expectedStartedAt = readProcessStartedAt(pid);

			registerPid(pid, "sleep 60");

			const file = readRawPidFile();
			const entry = file.entries.find((candidate) => candidate.pid === pid);
			expect(entry).toBeDefined();
			if (expectedStartedAt) {
				expect(entry?.processStartedAt).toBe(expectedStartedAt);
			} else {
				expect(entry?.processStartedAt).toBeUndefined();
			}
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

		test("writes session-scoped files without mutating legacy global file", async () => {
			const runDir = join(tmpDir, "run");
			mkdirSync(runDir, { recursive: true });
			const legacyPath = join(runDir, "pids.json");
			writeFileSync(
				legacyPath,
				JSON.stringify({
					version: 1,
					entries: [{ pid: 999, command: "legacy", startedAt: Date.now() - 1_000 }],
				})
			);

			const { registerPid } = await loadModule();
			registerPid(123, "new-process");

			const file = readRawPidFile();
			expect(file.entries.find((entry) => entry.pid === 123)).toBeDefined();

			const legacy = JSON.parse(readFileSync(legacyPath, "utf-8")) as {
				entries?: Array<{ pid: number }>;
			};
			expect(legacy.entries?.[0]?.pid).toBe(999);
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

		test("removes the session file when the last PID is unregistered", async () => {
			const { registerPid, unregisterPid } = await loadModule();
			registerPid(100, "cmd-a");
			unregisterPid(100);
			expect(listSessionPidFiles()).toHaveLength(0);
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

	describe("lock contention safety", () => {
		test("registerPid fails safe when lock is held and does not break lock file", async () => {
			const ownerStartedAt = readProcessStartedAt(process.pid) ?? undefined;
			const sessionPath = getCurrentSessionPidFilePath();
			const lockPath = `${sessionPath}.lock`;
			mkdirSync(dirname(sessionPath), { recursive: true });
			writeFileSync(
				sessionPath,
				JSON.stringify({
					version: 2,
					owner: { pid: process.pid, startedAt: ownerStartedAt },
					entries: [{ pid: 100, command: "cmd-a", startedAt: Date.now() }],
				})
			);
			writeFileSync(lockPath, "locked");

			const { registerPid } = await loadModule();
			registerPid(200, "cmd-b");

			const file = readRawPidFile();
			expect(file.entries).toHaveLength(1);
			expect(file.entries[0].pid).toBe(100);
			expect(existsSync(lockPath)).toBe(true);
			try {
				unlinkSync(lockPath);
			} catch {
				// Cleanup best-effort
			}
		});

		test("unregisterPid fails safe when lock is held and leaves entries intact", async () => {
			const ownerStartedAt = readProcessStartedAt(process.pid) ?? undefined;
			const sessionPath = getCurrentSessionPidFilePath();
			const lockPath = `${sessionPath}.lock`;
			mkdirSync(dirname(sessionPath), { recursive: true });
			writeFileSync(
				sessionPath,
				JSON.stringify({
					version: 2,
					owner: { pid: process.pid, startedAt: ownerStartedAt },
					entries: [
						{ pid: 100, command: "cmd-a", startedAt: Date.now() },
						{ pid: 200, command: "cmd-b", startedAt: Date.now() },
					],
				})
			);
			writeFileSync(lockPath, "locked");

			const { unregisterPid } = await loadModule();
			unregisterPid(100);

			const file = readRawPidFile();
			expect(file.entries).toHaveLength(2);
			expect(file.entries.map((entry) => entry.pid)).toEqual([100, 200]);
			expect(existsSync(lockPath)).toBe(true);
			try {
				unlinkSync(lockPath);
			} catch {
				// Cleanup best-effort
			}
		});
	});

	describe("corrupt/missing file handling", () => {
		test("handles corrupt JSON gracefully", async () => {
			const sessionPath = getCurrentSessionPidFilePath();
			mkdirSync(dirname(sessionPath), { recursive: true });
			writeFileSync(sessionPath, "NOT VALID JSON{{{");

			const { registerPid } = await loadModule();
			registerPid(100, "cmd-a");

			const file = readRawPidFile();
			expect(file.version).toBe(2);
			expect(file.entries).toHaveLength(1);
		});

		test("handles wrong version gracefully", async () => {
			const sessionPath = getCurrentSessionPidFilePath();
			mkdirSync(dirname(sessionPath), { recursive: true });
			writeFileSync(sessionPath, JSON.stringify({ version: 99, entries: [] }));

			const { registerPid } = await loadModule();
			registerPid(100, "cmd-a");

			const file = readRawPidFile();
			expect(file.version).toBe(2);
			expect(file.entries).toHaveLength(1);
		});

		test("handles missing entries array gracefully", async () => {
			const sessionPath = getCurrentSessionPidFilePath();
			mkdirSync(dirname(sessionPath), { recursive: true });
			writeFileSync(sessionPath, JSON.stringify({ version: 2, owner: { pid: process.pid } }));

			const { registerPid } = await loadModule();
			registerPid(100, "cmd-a");

			const file = readRawPidFile();
			expect(file.entries).toHaveLength(1);
		});
	});
});
