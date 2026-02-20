import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimePathProvider, type RuntimePathProvider } from "../runtime-path-provider.js";

interface TestPidEntry {
	pid: number;
	command: string;
	ownerPid?: number;
	ownerStartedAt?: string;
	processStartedAt?: string;
	startedAt: number;
}

interface TestSessionOwner {
	pid: number;
	startedAt?: string;
}

let tmpDir = "";
let runDir = "";
let legacyPidFilePath = "";
let sessionPidDir = "";
let cleanupAllTrackedPidsFn: () => number;
let cleanupOrphanPidsFn: () => number;
let setPidManagerPathProviderForTestsFn: (provider?: RuntimePathProvider) => void;
const spawnedPids = new Set<number>();

beforeAll(async () => {
	tmpDir = join(tmpdir(), `pid-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	runDir = join(tmpDir, "run");
	legacyPidFilePath = join(runDir, "pids.json");
	sessionPidDir = join(runDir, "pids");
	mkdirSync(sessionPidDir, { recursive: true });
	process.env.TALLOW_HOME = tmpDir;

	const mod = await import(`../pid-manager.js?t=${Date.now()}`);
	cleanupAllTrackedPidsFn = mod.cleanupAllTrackedPids;
	cleanupOrphanPidsFn = mod.cleanupOrphanPids;
	setPidManagerPathProviderForTestsFn = mod.setPidManagerPathProviderForTests;
	setPidManagerPathProviderForTestsFn(
		createRuntimePathProvider(() => process.env.TALLOW_HOME ?? tmpDir)
	);
});

beforeEach(() => {
	rmSync(runDir, { recursive: true, force: true });
	mkdirSync(sessionPidDir, { recursive: true });
});

afterEach(() => {
	for (const pid of spawnedPids) {
		killProcessGroup(pid, "SIGKILL");
	}
	spawnedPids.clear();
});

afterAll(() => {
	setPidManagerPathProviderForTestsFn();
	rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.TALLOW_HOME;
});

/**
 * Convert owner metadata into a filesystem-safe key.
 *
 * @param owner - Session owner identity
 * @returns Filename-safe owner key
 */
function toOwnerKey(owner: TestSessionOwner): string {
	const startedAtSlug = (owner.startedAt ?? "unknown")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const normalizedStartedAt = startedAtSlug.length > 0 ? startedAtSlug : "unknown";
	return `${owner.pid}-${normalizedStartedAt}`;
}

/**
 * Resolve a session PID file path for an owner.
 *
 * @param owner - Session owner identity
 * @returns Session PID file path
 */
function getSessionPidFilePath(owner: TestSessionOwner): string {
	return join(sessionPidDir, `${toOwnerKey(owner)}.json`);
}

/**
 * Write a session-scoped PID file.
 *
 * @param owner - Session owner identity
 * @param entries - PID entries to persist
 * @returns Nothing
 */
function writeSessionPidFile(owner: TestSessionOwner, entries: TestPidEntry[]): void {
	const path = getSessionPidFilePath(owner);
	writeFileSync(path, JSON.stringify({ version: 2, owner, entries }, null, "\t"));
}

/**
 * Write a legacy global PID file.
 *
 * @param entries - Legacy PID entries
 * @returns Nothing
 */
function writeLegacyPidFile(entries: TestPidEntry[]): void {
	writeFileSync(legacyPidFilePath, JSON.stringify({ version: 1, entries }, null, "\t"));
}

/**
 * Read session PID entries for a given owner.
 *
 * @param owner - Session owner identity
 * @returns Parsed entries (empty when file missing)
 */
function readSessionPidEntries(owner: TestSessionOwner): TestPidEntry[] {
	const path = getSessionPidFilePath(owner);
	if (!existsSync(path)) {
		return [];
	}
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
		entries?: TestPidEntry[];
	};
	return parsed.entries ?? [];
}

/**
 * List all session PID files.
 *
 * @returns Absolute paths to session files
 */
function listSessionPidFiles(): string[] {
	if (!existsSync(sessionPidDir)) {
		return [];
	}
	return readdirSync(sessionPidDir)
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => join(sessionPidDir, entry));
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
	test("cleanupOrphanPids signals stale-owner entries with matching child identity", async () => {
		const childPid = spawnSleeper();
		const childStartedAt = await requireProcessStartedAt(childPid);
		const staleOwner = { pid: 999_999, startedAt: "Mon Jan  1 00:00:00 2001" };

		writeSessionPidFile(staleOwner, [
			{
				command: "sleep 60",
				ownerPid: staleOwner.pid,
				ownerStartedAt: staleOwner.startedAt,
				pid: childPid,
				processStartedAt: childStartedAt,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(1);
		expect(await waitForExit(childPid)).toBe(true);
		expect(existsSync(getSessionPidFilePath(staleOwner))).toBe(false);
	});

	test("cleanupOrphanPids preserves files owned by live sessions", async () => {
		const ownerPid = spawnSleeper();
		const ownerStartedAt = await requireProcessStartedAt(ownerPid);
		const childPid = spawnSleeper();
		const childStartedAt = await requireProcessStartedAt(childPid);
		const owner = { pid: ownerPid, startedAt: ownerStartedAt };

		writeSessionPidFile(owner, [
			{
				command: "sleep 60",
				ownerPid: owner.pid,
				ownerStartedAt: owner.startedAt,
				pid: childPid,
				processStartedAt: childStartedAt,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(0);
		expect(isAlive(childPid)).toBe(true);
		expect(readSessionPidEntries(owner)).toHaveLength(1);
	});

	test("cleanupOrphanPids skips files with unknown owner identity", () => {
		const childPid = spawnSleeper();
		const unknownOwner = { pid: -1 };

		writeSessionPidFile(unknownOwner, [
			{
				command: "sleep 60",
				pid: childPid,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(0);
		expect(isAlive(childPid)).toBe(true);
		expect(readSessionPidEntries(unknownOwner)).toHaveLength(1);
	});

	test("cleanupOrphanPids prunes only stale-owner files", async () => {
		const liveOwnerPid = spawnSleeper();
		const liveOwnerStartedAt = await requireProcessStartedAt(liveOwnerPid);
		const liveChildPid = spawnSleeper();
		const liveChildStartedAt = await requireProcessStartedAt(liveChildPid);
		const staleChildPid = spawnSleeper();
		const staleChildStartedAt = await requireProcessStartedAt(staleChildPid);

		const liveOwner = { pid: liveOwnerPid, startedAt: liveOwnerStartedAt };
		const staleOwner = { pid: 999_999, startedAt: "Mon Jan  1 00:00:00 2001" };

		writeSessionPidFile(liveOwner, [
			{
				command: "live child",
				ownerPid: liveOwner.pid,
				ownerStartedAt: liveOwner.startedAt,
				pid: liveChildPid,
				processStartedAt: liveChildStartedAt,
				startedAt: Date.now(),
			},
		]);
		writeSessionPidFile(staleOwner, [
			{
				command: "stale child",
				ownerPid: staleOwner.pid,
				ownerStartedAt: staleOwner.startedAt,
				pid: staleChildPid,
				processStartedAt: staleChildStartedAt,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(1);
		expect(await waitForExit(staleChildPid)).toBe(true);
		expect(readSessionPidEntries(liveOwner)).toHaveLength(1);
		expect(existsSync(getSessionPidFilePath(staleOwner))).toBe(false);
	});

	test("cleanupOrphanPids migrates and sweeps legacy global PID files", async () => {
		const childPid = spawnSleeper();
		const childStartedAt = await requireProcessStartedAt(childPid);

		writeLegacyPidFile([
			{
				command: "legacy child",
				ownerPid: 999_999,
				ownerStartedAt: "Mon Jan  1 00:00:00 2001",
				pid: childPid,
				processStartedAt: childStartedAt,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupOrphanPidsFn();
		expect(killed).toBe(1);
		expect(await waitForExit(childPid)).toBe(true);
		expect(existsSync(legacyPidFilePath)).toBe(false);
		expect(listSessionPidFiles()).toHaveLength(0);
	});

	test("cleanupAllTrackedPids only cleans the current session file", async () => {
		const currentStartedAt = await requireProcessStartedAt(process.pid);
		const currentOwner = { pid: process.pid, startedAt: currentStartedAt };

		const ownChildPid = spawnSleeper();
		const ownChildStartedAt = await requireProcessStartedAt(ownChildPid);
		writeSessionPidFile(currentOwner, [
			{
				command: "own child",
				ownerPid: currentOwner.pid,
				ownerStartedAt: currentOwner.startedAt,
				pid: ownChildPid,
				processStartedAt: ownChildStartedAt,
				startedAt: Date.now(),
			},
		]);

		const otherOwnerPid = spawnSleeper();
		const otherOwnerStartedAt = await requireProcessStartedAt(otherOwnerPid);
		const otherChildPid = spawnSleeper();
		const otherChildStartedAt = await requireProcessStartedAt(otherChildPid);
		const otherOwner = { pid: otherOwnerPid, startedAt: otherOwnerStartedAt };
		writeSessionPidFile(otherOwner, [
			{
				command: "other child",
				ownerPid: otherOwner.pid,
				ownerStartedAt: otherOwner.startedAt,
				pid: otherChildPid,
				processStartedAt: otherChildStartedAt,
				startedAt: Date.now(),
			},
		]);

		const killed = cleanupAllTrackedPidsFn();
		expect(killed).toBe(1);
		expect(await waitForExit(ownChildPid)).toBe(true);
		expect(existsSync(getSessionPidFilePath(currentOwner))).toBe(false);
		expect(isAlive(otherChildPid)).toBe(true);
		expect(readSessionPidEntries(otherOwner)).toHaveLength(1);
	});

	test("cleanupOrphanPids supports injected runtime path providers", () => {
		const injectedHome = join(
			tmpdir(),
			`pid-manager-injected-home-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		const injectedSessionDir = join(injectedHome, "run", "pids");
		const injectedCorruptPath = join(injectedSessionDir, "corrupt.json");
		mkdirSync(injectedSessionDir, { recursive: true });
		writeFileSync(injectedCorruptPath, "NOT VALID JSON{{{");

		setPidManagerPathProviderForTestsFn(createRuntimePathProvider(() => injectedHome));
		const previousHome = process.env.TALLOW_HOME;
		delete process.env.TALLOW_HOME;

		try {
			expect(cleanupOrphanPidsFn()).toBe(0);
			expect(existsSync(injectedCorruptPath)).toBe(false);
		} finally {
			if (previousHome === undefined) {
				delete process.env.TALLOW_HOME;
			} else {
				process.env.TALLOW_HOME = previousHome;
			}
			setPidManagerPathProviderForTestsFn(
				createRuntimePathProvider(() => process.env.TALLOW_HOME ?? tmpDir)
			);
			rmSync(injectedHome, { recursive: true, force: true });
		}
	});

	test("cleanupOrphanPids honors TALLOW_HOME changes after module import", () => {
		const runtimeHome = join(
			tmpdir(),
			`pid-manager-runtime-home-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		const runtimeSessionDir = join(runtimeHome, "run", "pids");
		const runtimeCorruptPath = join(runtimeSessionDir, "corrupt.json");
		mkdirSync(runtimeSessionDir, { recursive: true });
		writeFileSync(runtimeCorruptPath, "NOT VALID JSON{{{");

		const previousHome = process.env.TALLOW_HOME;
		process.env.TALLOW_HOME = runtimeHome;

		try {
			expect(cleanupOrphanPidsFn()).toBe(0);
			expect(existsSync(runtimeCorruptPath)).toBe(false);
		} finally {
			if (previousHome === undefined) {
				delete process.env.TALLOW_HOME;
			} else {
				process.env.TALLOW_HOME = previousHome;
			}
			rmSync(runtimeHome, { recursive: true, force: true });
		}
	});

	test("cleanupOrphanPids tolerates corrupt session files", () => {
		const corruptPath = join(sessionPidDir, "corrupt.json");
		writeFileSync(corruptPath, "NOT VALID JSON{{{");

		expect(cleanupOrphanPidsFn()).toBe(0);
		expect(existsSync(corruptPath)).toBe(false);
	});
});
