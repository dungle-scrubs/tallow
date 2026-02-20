import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TestPidEntry {
	pid: number;
	command: string;
	ownerPid?: number;
	ownerStartedAt?: string;
	processStartedAt?: string;
	startedAt: number;
}

let tmpDir = "";
let pidFilePath = "";
let cleanupAllTrackedPidsFn: () => number;
let cleanupOrphanPidsFn: () => number;
const spawnedPids = new Set<number>();

beforeAll(async () => {
	tmpDir = join(tmpdir(), `pid-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	pidFilePath = join(tmpDir, "run", "pids.json");
	mkdirSync(join(tmpDir, "run"), { recursive: true });
	process.env.TALLOW_HOME = tmpDir;

	const mod = await import(`../pid-manager.js?t=${Date.now()}`);
	cleanupAllTrackedPidsFn = mod.cleanupAllTrackedPids;
	cleanupOrphanPidsFn = mod.cleanupOrphanPids;
});

beforeEach(() => {
	mkdirSync(join(tmpDir, "run"), { recursive: true });
	try {
		unlinkSync(pidFilePath);
	} catch {
		// File already absent
	}
});

afterEach(() => {
	for (const pid of spawnedPids) {
		killProcessGroup(pid, "SIGKILL");
	}
	spawnedPids.clear();
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.TALLOW_HOME;
});

/**
 * Write a PID file in the expected format.
 *
 * @param entries - PID entries to write
 * @returns Nothing
 */
function writePidFile(entries: TestPidEntry[]): void {
	writeFileSync(pidFilePath, JSON.stringify({ version: 1, entries }, null, "\t"));
}

/**
 * Read PID entries from disk for assertions.
 *
 * @returns Parsed entries, or an empty array if the file is missing
 */
function readPidEntries(): TestPidEntry[] {
	if (!existsSync(pidFilePath)) {
		return [];
	}
	const parsed = JSON.parse(readFileSync(pidFilePath, "utf-8")) as {
		entries?: TestPidEntry[];
	};
	return parsed.entries ?? [];
}

/**
 * Spawn a detached `sleep` process we can target in cleanup tests.
 *
 * @returns PID of the spawned child process
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
 * Signal the process group for a detached child.
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
 * Check if a process is alive.
 *
 * @param pid - Process ID to probe
 * @returns True when the process is alive
 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read process start metadata from `ps`.
 *
 * @param pid - Process ID to inspect
 * @returns Start-time string, or null when unavailable
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
 * Poll until a process start identity becomes readable.
 *
 * @param pid - Process ID to inspect
 * @returns Start-time identity string
 * @throws {Error} When metadata cannot be read before timeout
 */
async function requireProcessStartedAt(pid: number): Promise<string> {
	const timeoutMs = 1_000;
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		const identity = readProcessStartedAt(pid);
		if (identity) {
			return identity;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error(`Failed to read process start metadata for PID ${pid}`);
}

/**
 * Wait until a process exits.
 *
 * @param pid - Process ID to observe
 * @returns True when the process exited before timeout
 */
async function waitForExit(pid: number): Promise<boolean> {
	const timeoutMs = 1_000;
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		if (!isAlive(pid)) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	return false;
}

describe("pid-manager", () => {
	test("cleanupOrphanPids signals orphan entries with matching child identity", async () => {
		const pid = spawnSleeper();
		const processStartedAt = await requireProcessStartedAt(pid);

		writePidFile([
			{
				command: "sleep 60",
				ownerPid: 999_999,
				ownerStartedAt: "Mon Jan  1 00:00:00 2001",
				pid,
				processStartedAt,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(1);
		expect(await waitForExit(pid)).toBe(true);
		expect(existsSync(pidFilePath)).toBe(false);
	});

	test("cleanupOrphanPids preserves entries owned by live sessions", async () => {
		const ownerPid = spawnSleeper();
		const ownerStartedAt = await requireProcessStartedAt(ownerPid);
		const childPid = spawnSleeper();
		const childStartedAt = await requireProcessStartedAt(childPid);

		writePidFile([
			{
				command: "sleep 60",
				ownerPid,
				ownerStartedAt,
				pid: childPid,
				processStartedAt: childStartedAt,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(0);
		expect(isAlive(childPid)).toBe(true);
		expect(readPidEntries()).toHaveLength(1);
		expect(readPidEntries()[0]?.pid).toBe(childPid);
	});

	test("cleanupOrphanPids skips signaling when child identity mismatches", () => {
		const pid = spawnSleeper();

		writePidFile([
			{
				command: "sleep 60",
				ownerPid: 999_999,
				ownerStartedAt: "Mon Jan  1 00:00:00 2001",
				pid,
				processStartedAt: "Mon Jan  1 00:00:00 2001",
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(0);
		expect(isAlive(pid)).toBe(true);
		expect(readPidEntries()).toHaveLength(1);
	});

	test("cleanupOrphanPids skips signaling when owner metadata is missing", () => {
		const pid = spawnSleeper();

		writePidFile([
			{
				command: "sleep 60",
				pid,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(0);
		expect(isAlive(pid)).toBe(true);
		expect(readPidEntries()).toHaveLength(1);
	});

	test("cleanupOrphanPids prunes only targeted entries", async () => {
		const ownerPid = spawnSleeper();
		const ownerStartedAt = await requireProcessStartedAt(ownerPid);
		const retainedPid = spawnSleeper();
		const retainedStartedAt = await requireProcessStartedAt(retainedPid);
		const orphanPid = spawnSleeper();
		const orphanStartedAt = await requireProcessStartedAt(orphanPid);

		writePidFile([
			{
				command: "sleep retained",
				ownerPid,
				ownerStartedAt,
				pid: retainedPid,
				processStartedAt: retainedStartedAt,
				startedAt: Date.now(),
			},
			{
				command: "sleep orphan",
				ownerPid: 999_999,
				ownerStartedAt: "Mon Jan  1 00:00:00 2001",
				pid: orphanPid,
				processStartedAt: orphanStartedAt,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(1);
		expect(await waitForExit(orphanPid)).toBe(true);
		const entries = readPidEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.pid).toBe(retainedPid);
		expect(isAlive(retainedPid)).toBe(true);
	});

	test("cleanupAllTrackedPids uses the same identity safety check", () => {
		const pid = spawnSleeper();

		writePidFile([
			{
				command: "sleep 60",
				pid,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupAllTrackedPidsFn();
		expect(killed).toBe(0);
		expect(isAlive(pid)).toBe(true);
		expect(existsSync(pidFilePath)).toBe(false);
	});

	test("cleanupOrphanPids handles corrupt PID files safely", () => {
		writeFileSync(pidFilePath, "NOT VALID JSON{{{");
		expect(cleanupOrphanPidsFn()).toBe(0);
	});
});
