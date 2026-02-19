/**
 * PID file manager for tracking background child processes.
 *
 * Writes spawned PIDs to `~/.tallow/run/pids.json` so orphaned processes
 * can be cleaned up on next startup when the parent was killed (SIGKILL,
 * OOM, terminal crash) and the normal `session_shutdown` path didn't run.
 *
 * The file format is shared with `extensions/_shared/pid-registry.ts`
 * which handles extension-side registration. Both modules operate on the
 * same JSON file independently — the file schema is the contract.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { TALLOW_HOME } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single tracked child process entry. */
export interface PidEntry {
	pid: number;
	command: string;
	processStartedAt?: string;
	startedAt: number;
}

/** On-disk PID file schema (version 1). */
interface PidFile {
	version: 1;
	entries: PidEntry[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Path to the PID tracking file. */
const PID_FILE_PATH = join(TALLOW_HOME, "run", "pids.json");

// ─── File I/O ────────────────────────────────────────────────────────────────

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
		const raw = readFileSync(PID_FILE_PATH, "utf-8");
		const parsed = normalizePidFile(JSON.parse(raw) as unknown);
		if (parsed) {
			return parsed;
		}
	} catch {
		// File missing, corrupt, or unparseable — start fresh
	}
	return { version: 1, entries: [] };
}

// ─── Process checks ─────────────────────────────────────────────────────────

/**
 * Check whether a process is still alive via `kill -0`.
 *
 * @param pid - Process ID to probe
 * @returns True when the process exists and is reachable
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read process start time from `ps` for PID-reuse-safe identity checks.
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
 * Verify that a PID entry still points to the originally tracked process.
 *
 * @param entry - Tracked PID entry
 * @returns True when start-time identity matches
 */
function hasMatchingProcessIdentity(entry: PidEntry): boolean {
	if (!entry.processStartedAt) {
		return false;
	}
	const currentStartedAt = readProcessStartedAt(entry.pid);
	if (!currentStartedAt) {
		return false;
	}
	return currentStartedAt === entry.processStartedAt;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Clean up orphaned child processes left over from a previous session.
 *
 * Reads the PID file, probes each entry with `kill -0`, validates identity
 * via process start time, then sends SIGTERM to the process group of entries
 * that are still alive and verifiably match the originally tracked process.
 *
 * Called once at startup inside `createTallowSession()`.
 *
 * @returns Number of orphaned processes killed
 */
export function cleanupOrphanPids(): number {
	const file = readPidFile();
	if (file.entries.length === 0) return 0;

	let killed = 0;

	for (const entry of file.entries) {
		if (!isProcessAlive(entry.pid)) {
			continue;
		}
		if (!hasMatchingProcessIdentity(entry)) {
			// Missing/mismatched identity is treated as unsafe — skip signaling.
			continue;
		}
		try {
			// Negative PID → send to the process group (detached children are group leaders)
			process.kill(-entry.pid, "SIGTERM");
			killed++;
		} catch {
			// Process may have exited between probe and kill — harmless
		}
	}

	// Always clear the file — stale entries from dead processes are useless
	try {
		unlinkSync(PID_FILE_PATH);
	} catch {
		// Already gone or never existed
	}

	return killed;
}

/**
 * Kill all tracked child processes and remove the PID file.
 *
 * Called during process shutdown (SIGTERM / SIGINT) as a safety net after
 * `session_shutdown` fires. Entries are only signaled when identity checks
 * confirm they still refer to the originally tracked processes.
 *
 * @returns Number of processes signalled
 */
export function cleanupAllTrackedPids(): number {
	const file = readPidFile();
	if (file.entries.length === 0) return 0;

	let killed = 0;
	for (const entry of file.entries) {
		if (!isProcessAlive(entry.pid)) {
			continue;
		}
		if (!hasMatchingProcessIdentity(entry)) {
			continue;
		}
		try {
			process.kill(-entry.pid, "SIGTERM");
			killed++;
		} catch {
			// Already dead — expected after session_shutdown ran
		}
	}

	try {
		unlinkSync(PID_FILE_PATH);
	} catch {
		// Already gone
	}

	return killed;
}
