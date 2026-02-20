/**
 * Extension-facing PID registry for background child processes.
 *
 * Reads and writes `~/.tallow/run/pids.json` — the same file managed
 * by `src/pid-manager.ts` on the core side. The JSON schema (version 1,
 * entries with pid/command/startedAt plus optional owner identity and
 * process-start metadata) is the shared contract.
 *
 * Extensions call {@link registerPid} after spawning a detached child
 * and {@link unregisterPid} when the child exits or is killed.
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

// ─── Types (mirror src/pid-manager.ts) ──────────────────────────────────────

/** A single tracked child process entry. */
interface PidEntry {
	pid: number;
	command: string;
	ownerPid?: number;
	ownerStartedAt?: string;
	processStartedAt?: string;
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
 * Check whether a value matches the PID entry schema.
 *
 * Supports legacy entries without `processStartedAt` for migration safety.
 *
 * @param value - Unknown JSON value to validate
 * @returns True when the value is a supported PID entry
 */
function isPidEntry(value: unknown): value is PidEntry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.pid !== "number") return false;
	if (typeof candidate.command !== "string") return false;
	if (typeof candidate.startedAt !== "number") return false;
	if (candidate.ownerPid != null && typeof candidate.ownerPid !== "number") {
		return false;
	}
	if (candidate.ownerStartedAt != null && typeof candidate.ownerStartedAt !== "string") {
		return false;
	}
	if (candidate.processStartedAt != null && typeof candidate.processStartedAt !== "string") {
		return false;
	}
	return true;
}

/**
 * Validate and normalize raw PID file JSON.
 *
 * @param value - Parsed JSON value
 * @returns Normalized PID file, or null when invalid
 */
function normalizePidFile(value: unknown): PidFile | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 1) return null;
	if (!Array.isArray(candidate.entries)) return null;
	const entries = candidate.entries.filter(isPidEntry);
	return {
		version: 1,
		entries,
	};
}

/**
 * Read and parse the PID file. Returns empty entries on any error.
 *
 * @returns Parsed PID file contents
 */
function readPidFile(): PidFile {
	try {
		const raw = readFileSync(getPidFilePath(), "utf-8");
		const parsed = normalizePidFile(JSON.parse(raw) as unknown);
		if (parsed) {
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

/**
 * Read process start time from `ps` so PID reuse can be detected later.
 *
 * @param pid - Process ID to inspect
 * @returns Process start string from `ps`, or null when unavailable
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
		if (file.entries.some((entry) => entry.pid === pid)) return;

		const ownerStartedAt = readProcessStartedAt(process.pid);
		const processStartedAt = readProcessStartedAt(pid);
		file.entries.push({
			command,
			ownerPid: process.pid,
			ownerStartedAt: ownerStartedAt ?? undefined,
			pid,
			processStartedAt: processStartedAt ?? undefined,
			startedAt: Date.now(),
		});
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
		file.entries = file.entries.filter((entry) => entry.pid !== pid);
		if (file.entries.length < before) {
			writePidFile(file);
		}
	} finally {
		unlock();
	}
}
