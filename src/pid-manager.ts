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

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { TALLOW_HOME } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single tracked child process entry. */
export interface PidEntry {
	pid: number;
	command: string;
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
 * Read and parse the PID file. Returns empty entries on any error.
 *
 * @returns Parsed PID file contents
 */
function readPidFile(): PidFile {
	try {
		const raw = readFileSync(PID_FILE_PATH, "utf-8");
		const parsed = JSON.parse(raw) as PidFile;
		if (parsed.version === 1 && Array.isArray(parsed.entries)) {
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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Clean up orphaned child processes left over from a previous session.
 *
 * Reads the PID file, probes each entry with `kill -0`, sends SIGTERM
 * to the process group of any that are still alive (negative PID targets
 * the group since children are spawned with `detached: true`), then
 * clears the file.
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
		if (isProcessAlive(entry.pid)) {
			try {
				// Negative PID → send to the process group (detached children are group leaders)
				process.kill(-entry.pid, "SIGTERM");
				killed++;
			} catch {
				// Process may have exited between probe and kill — harmless
			}
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
 * `session_shutdown` fires. If extensions already killed and unregistered
 * their processes, this is a no-op.
 *
 * @returns Number of processes signalled
 */
export function cleanupAllTrackedPids(): number {
	const file = readPidFile();
	if (file.entries.length === 0) return 0;

	let killed = 0;
	for (const entry of file.entries) {
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
