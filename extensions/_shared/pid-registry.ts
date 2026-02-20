/**
 * Extension-facing PID registry for background child processes.
 *
 * Reads and writes session-scoped PID files under `~/.tallow/run/pids/`.
 * Each tallow session writes only its own file so shutdown/unregister flows
 * never mutate entries that belong to other active sessions.
 *
 * Extensions call {@link registerPid} after spawning a detached child
 * and {@link unregisterPid} when the child exits or is killed.
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

// ─── Types (mirror src/pid-manager.ts) ──────────────────────────────────────

/** Session owner identity used for per-session PID files. */
interface SessionOwner {
	pid: number;
	startedAt?: string;
}

/** A single tracked child process entry. */
interface PidEntry {
	pid: number;
	command: string;
	ownerPid?: number;
	ownerStartedAt?: string;
	processStartedAt?: string;
	startedAt: number;
}

/** On-disk session PID file schema (version 2). */
interface SessionPidFile {
	version: 2;
	owner: SessionOwner;
	entries: PidEntry[];
}

// ─── Owner/session path helpers ─────────────────────────────────────────────

/** Cached owner identity for this process. */
let cachedOwnerIdentity: SessionOwner | null = null;

/**
 * Resolve the tallow home directory from env.
 *
 * @returns Absolute path to TALLOW_CODING_AGENT_DIR
 * @throws {Error} When TALLOW_CODING_AGENT_DIR is not set
 */
function getAgentDir(): string {
	const agentDir = process.env.TALLOW_CODING_AGENT_DIR;
	if (!agentDir) {
		throw new Error("TALLOW_CODING_AGENT_DIR not set — cannot locate PID registry");
	}
	return agentDir;
}

/**
 * Resolve the session-scoped PID directory.
 *
 * @returns Absolute path to run/pids
 */
function getSessionPidDir(): string {
	return join(getAgentDir(), "run", "pids");
}

/**
 * Convert owner metadata into a filesystem-safe key.
 *
 * @param owner - Session owner identity
 * @returns Filename-safe owner key
 */
function toOwnerKey(owner: SessionOwner): string {
	const startedAtSlug = (owner.startedAt ?? "unknown")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const normalizedStartedAt = startedAtSlug.length > 0 ? startedAtSlug : "unknown";
	return `${owner.pid}-${normalizedStartedAt}`;
}

/**
 * Resolve the current session PID file path.
 *
 * @param owner - Session owner identity
 * @returns Absolute path to this session's PID file
 */
function getSessionPidFilePath(owner: SessionOwner): string {
	return join(getSessionPidDir(), `${toOwnerKey(owner)}.json`);
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

/**
 * Resolve and memoize the current process owner identity.
 *
 * @returns Owner identity for this tallow process
 */
function getCurrentOwnerIdentity(): SessionOwner {
	if (cachedOwnerIdentity) {
		return cachedOwnerIdentity;
	}
	cachedOwnerIdentity = {
		pid: process.pid,
		startedAt: readProcessStartedAt(process.pid) ?? undefined,
	};
	return cachedOwnerIdentity;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Check whether a value matches the session-owner schema.
 *
 * @param value - Unknown JSON value to validate
 * @returns True when value is a valid session owner
 */
function isSessionOwner(value: unknown): value is SessionOwner {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.pid !== "number") return false;
	if (candidate.startedAt != null && typeof candidate.startedAt !== "string") {
		return false;
	}
	return true;
}

/**
 * Check whether a value matches the PID entry schema.
 *
 * Supports legacy entries without owner/process identity metadata.
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
 * Validate and normalize raw session PID file JSON.
 *
 * @param value - Parsed JSON value
 * @param fallbackOwner - Owner used when file is missing/invalid
 * @returns Normalized session PID file, or null when invalid
 */
function normalizeSessionPidFile(
	value: unknown,
	fallbackOwner: SessionOwner
): SessionPidFile | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 2) return null;
	if (!Array.isArray(candidate.entries)) return null;

	const owner = isSessionOwner(candidate.owner) ? candidate.owner : fallbackOwner;
	const entries = candidate.entries.filter(isPidEntry);
	return {
		version: 2,
		owner,
		entries,
	};
}

// ─── File I/O ────────────────────────────────────────────────────────────────

/**
 * Read and parse this session's PID file.
 *
 * @param filePath - Session PID file path
 * @param owner - Owner identity for fallback initialization
 * @returns Parsed session PID file contents
 */
function readSessionPidFile(filePath: string, owner: SessionOwner): SessionPidFile {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = normalizeSessionPidFile(JSON.parse(raw) as unknown, owner);
		if (parsed) {
			return parsed;
		}
	} catch {
		// File missing, corrupt, or unparseable — start fresh
	}
	return { version: 2, owner, entries: [] };
}

/**
 * Write the session PID file. Creates parent directories if needed.
 *
 * @param filePath - Session PID file path
 * @param file - PID file contents to persist
 * @returns Nothing
 */
function writeSessionPidFile(filePath: string, file: SessionPidFile): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	atomicWriteFileSync(filePath, `${JSON.stringify(file, null, "\t")}\n`);
}

/**
 * Remove a session PID file if it exists.
 *
 * @param filePath - Session PID file path
 * @returns Nothing
 */
function removeSessionPidFile(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		// Already absent
	}
}

// ─── Locking ─────────────────────────────────────────────────────────────────

/**
 * Acquire an exclusive file lock for a session PID file using O_EXCL.
 *
 * Retries briefly to handle contention from concurrent writes. Falls back to
 * unlocked access after max retries to preserve current behavior.
 *
 * @param filePath - Session PID file path
 * @returns Cleanup function to release the lock
 */
function acquirePidLock(filePath: string): () => void {
	const lockPath = `${filePath}.lock`;
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
 * Register a spawned child process PID in this session's tracking file.
 *
 * Called immediately after `spawn()` with `detached: true`. Duplicate
 * PIDs are silently ignored. Uses file locking to prevent concurrent
 * read-modify-write races.
 *
 * @param pid - Child process ID
 * @param command - Shell command that was spawned (for diagnostics)
 */
export function registerPid(pid: number, command: string): void {
	const owner = getCurrentOwnerIdentity();
	const filePath = getSessionPidFilePath(owner);
	const unlock = acquirePidLock(filePath);

	try {
		const file = readSessionPidFile(filePath, owner);
		if (file.entries.some((entry) => entry.pid === pid)) return;

		const processStartedAt = readProcessStartedAt(pid);
		file.entries.push({
			command,
			ownerPid: owner.pid,
			ownerStartedAt: owner.startedAt,
			pid,
			processStartedAt: processStartedAt ?? undefined,
			startedAt: Date.now(),
		});
		writeSessionPidFile(filePath, file);
	} finally {
		unlock();
	}
}

/**
 * Remove a child process PID from this session's tracking file.
 *
 * Called when a child process exits (close/error event) or is killed.
 * No-op when the PID is not in the file. Uses file locking to prevent
 * concurrent read-modify-write races.
 *
 * @param pid - Child process ID to remove
 */
export function unregisterPid(pid: number): void {
	const owner = getCurrentOwnerIdentity();
	const filePath = getSessionPidFilePath(owner);
	const unlock = acquirePidLock(filePath);

	try {
		const file = readSessionPidFile(filePath, owner);
		const before = file.entries.length;
		file.entries = file.entries.filter((entry) => entry.pid !== pid);
		if (file.entries.length === 0) {
			removeSessionPidFile(filePath);
			return;
		}
		if (file.entries.length < before) {
			writeSessionPidFile(filePath, file);
		}
	} finally {
		unlock();
	}
}
