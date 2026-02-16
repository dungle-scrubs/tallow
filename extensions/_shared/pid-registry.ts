/**
 * Extension-facing PID registry for background child processes.
 *
 * Reads and writes `~/.tallow/run/pids.json` — the same file managed
 * by `src/pid-manager.ts` on the core side. The JSON schema (version 1,
 * entries with pid/command/startedAt) is the shared contract.
 *
 * Extensions call {@link registerPid} after spawning a detached child
 * and {@link unregisterPid} when the child exits or is killed.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

// ─── Types (mirror src/pid-manager.ts) ──────────────────────────────────────

/** A single tracked child process entry. */
interface PidEntry {
	pid: number;
	command: string;
	startedAt: number;
}

/** On-disk PID file schema (version 1). */
interface PidFile {
	version: 1;
	entries: PidEntry[];
}

// ─── File I/O ────────────────────────────────────────────────────────────────

/**
 * Resolve the PID file path from the agent directory env var.
 *
 * @returns Absolute path to pids.json
 * @throws {Error} When TALLOW_CODING_AGENT_DIR is not set
 */
function getPidFilePath(): string {
	const agentDir = process.env.TALLOW_CODING_AGENT_DIR;
	if (!agentDir) {
		throw new Error("TALLOW_CODING_AGENT_DIR not set — cannot locate PID file");
	}
	return join(agentDir, "run", "pids.json");
}

/**
 * Read and parse the PID file. Returns empty entries on any error.
 *
 * @returns Parsed PID file contents
 */
function readPidFile(): PidFile {
	try {
		const raw = readFileSync(getPidFilePath(), "utf-8");
		const parsed = JSON.parse(raw) as PidFile;
		if (parsed.version === 1 && Array.isArray(parsed.entries)) {
			return parsed;
		}
	} catch {
		// File missing, corrupt, or unparseable — start fresh
	}
	return { version: 1, entries: [] };
}

/**
 * Write the PID file. Creates parent directories if needed.
 *
 * @param file - PID file contents to persist
 */
function writePidFile(file: PidFile): void {
	const path = getPidFilePath();
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	atomicWriteFileSync(path, `${JSON.stringify(file, null, "\t")}\n`);
}

// ─── Locking ─────────────────────────────────────────────────────────────────

/**
 * Acquire an exclusive file lock for the PID file using O_EXCL.
 *
 * Retries briefly to handle contention from concurrent processes.
 * Falls back to unlocked access after max retries to avoid deadlock
 * from stale lockfiles.
 *
 * @returns Cleanup function to release the lock
 */
function acquirePidLock(): () => void {
	const lockPath = `${getPidFilePath()}.lock`;
	const maxRetries = 10;
	const retryDelayMs = 20;

	for (let i = 0; i < maxRetries; i++) {
		try {
			const fd = openSync(lockPath, "wx");
			closeSync(fd);
			return () => {
				try {
					unlinkSync(lockPath);
				} catch {
					/* lock already removed */
				}
			};
		} catch {
			// Lock held by another process — busy-wait
			const start = Date.now();
			while (Date.now() - start < retryDelayMs) {
				/* spin */
			}
		}
	}

	// Stale lock — force remove and proceed unprotected
	try {
		unlinkSync(lockPath);
	} catch {
		/* already gone */
	}
	return () => {};
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register a spawned child process PID in the tracking file.
 *
 * Called immediately after `spawn()` with `detached: true`. Duplicate
 * PIDs are silently ignored. Uses file locking to prevent concurrent
 * read-modify-write races.
 *
 * @param pid - Child process ID
 * @param command - Shell command that was spawned (for diagnostics)
 */
export function registerPid(pid: number, command: string): void {
	const unlock = acquirePidLock();
	try {
		const file = readPidFile();
		if (file.entries.some((e) => e.pid === pid)) return;
		file.entries.push({ pid, command, startedAt: Date.now() });
		writePidFile(file);
	} finally {
		unlock();
	}
}

/**
 * Remove a child process PID from the tracking file.
 *
 * Called when a child process exits (close/error event) or is killed.
 * No-op when the PID is not in the file. Uses file locking to prevent
 * concurrent read-modify-write races.
 *
 * @param pid - Child process ID to remove
 */
export function unregisterPid(pid: number): void {
	const unlock = acquirePidLock();
	try {
		const file = readPidFile();
		const before = file.entries.length;
		file.entries = file.entries.filter((e) => e.pid !== pid);
		if (file.entries.length < before) {
			writePidFile(file);
		}
	} finally {
		unlock();
	}
}
