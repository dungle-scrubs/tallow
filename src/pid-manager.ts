/**
 * Session-scoped PID cleanup for detached subprocesses.
 *
 * Runtime extensions register child PIDs in per-session files under
 * `~/.tallow/run/pids/`. Startup orphan cleanup sweeps only stale owner files,
 * while shutdown cleanup only touches the current session's file.
 *
 * Legacy global state in `~/.tallow/run/pids.json` is migrated lazily on
 * startup so existing installations continue to work.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getRuntimePathProvider } from "./config.js";
import type { RuntimePathProvider } from "./runtime-path-provider.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single tracked child process entry. */
export interface PidEntry {
	pid: number;
	command: string;
	ownerPid?: number;
	ownerStartedAt?: string;
	processStartedAt?: string;
	startedAt: number;
}

/** Owner identity for a session-scoped PID file. */
interface SessionOwner {
	pid: number;
	startedAt?: string;
}

/** Legacy global PID file schema (version 1). */
interface LegacyPidFile {
	version: 1;
	entries: PidEntry[];
}

/** Session-scoped PID file schema (version 2). */
interface SessionPidFile {
	version: 2;
	owner: SessionOwner;
	entries: PidEntry[];
}

// ─── Runtime path helpers ───────────────────────────────────────────────────

/** Runtime path provider used by PID manager lookups. */
let pidManagerPathProvider: RuntimePathProvider = getRuntimePathProvider();

/**
 * Override PID-manager runtime paths for tests.
 *
 * @param provider - Optional provider override (reset when omitted)
 * @returns Nothing
 */
export function setPidManagerPathProviderForTests(provider?: RuntimePathProvider): void {
	pidManagerPathProvider = provider ?? getRuntimePathProvider();
}

/**
 * Resolve the legacy global PID file path.
 *
 * @returns Absolute path to run/pids.json
 */
function getLegacyPidFilePath(): string {
	return pidManagerPathProvider.getLegacyPidFilePath();
}

/**
 * Resolve the session-scoped PID directory path.
 *
 * @returns Absolute path to run/pids/
 */
function getSessionPidDirPath(): string {
	return pidManagerPathProvider.getSessionPidDir();
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Check whether a value matches the PID entry schema.
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
 * Check whether a value matches the session-owner schema.
 *
 * @param value - Unknown JSON value to validate
 * @returns True when the value is a valid session owner
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
 * Validate and normalize raw legacy PID file JSON.
 *
 * @param value - Parsed JSON value
 * @returns Normalized legacy PID file, or null when invalid
 */
function normalizeLegacyPidFile(value: unknown): LegacyPidFile | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 1) return null;
	if (!Array.isArray(candidate.entries)) return null;
	return {
		version: 1,
		entries: candidate.entries.filter(isPidEntry),
	};
}

/**
 * Validate and normalize raw session PID file JSON.
 *
 * @param value - Parsed JSON value
 * @returns Normalized session PID file, or null when invalid
 */
function normalizeSessionPidFile(value: unknown): SessionPidFile | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 2) return null;
	if (!isSessionOwner(candidate.owner)) return null;
	if (!Array.isArray(candidate.entries)) return null;
	return {
		version: 2,
		owner: candidate.owner,
		entries: candidate.entries.filter(isPidEntry),
	};
}

// ─── Path helpers ────────────────────────────────────────────────────────────

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
 * Resolve a session PID file path for a given owner.
 *
 * @param owner - Session owner identity
 * @returns Absolute path to the owner-scoped PID file
 */
function getSessionPidFilePath(owner: SessionOwner): string {
	return join(getSessionPidDirPath(), `${toOwnerKey(owner)}.json`);
}

/**
 * Check whether owner metadata is sufficient for identity matching.
 *
 * @param owner - Session owner identity
 * @returns True when owner pid/start-time are both present and usable
 */
function hasOwnerIdentity(owner: SessionOwner): owner is { pid: number; startedAt: string } {
	return owner.pid > 0 && typeof owner.startedAt === "string";
}

// ─── File I/O ────────────────────────────────────────────────────────────────

/**
 * Read and parse the legacy global PID file.
 *
 * @returns Normalized legacy file, or null when missing/invalid
 */
function readLegacyPidFile(): LegacyPidFile | null {
	try {
		const raw = readFileSync(getLegacyPidFilePath(), "utf-8");
		return normalizeLegacyPidFile(JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

/**
 * Read and parse a session PID file.
 *
 * @param filePath - Session PID file path
 * @returns Normalized session file, or null when missing/invalid
 */
function readSessionPidFile(filePath: string): SessionPidFile | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		return normalizeSessionPidFile(JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

/**
 * Write a session PID file.
 *
 * @param filePath - Session PID file path
 * @param file - Session PID contents
 * @returns Nothing
 */
function writeSessionPidFile(filePath: string, file: SessionPidFile): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(filePath, `${JSON.stringify(file, null, "\t")}\n`);
}

/**
 * Remove a file if it exists.
 *
 * @param filePath - File path to remove
 * @returns Nothing
 */
function removeFile(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		// Already absent
	}
}

/**
 * List session-scoped PID files.
 *
 * @returns Absolute paths to all session PID files
 */
function listSessionPidFiles(): string[] {
	const sessionPidDir = getSessionPidDirPath();
	if (!existsSync(sessionPidDir)) {
		return [];
	}

	try {
		return readdirSync(sessionPidDir)
			.filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
			.map((entry) => join(sessionPidDir, entry));
	} catch {
		return [];
	}
}

/**
 * Merge PID entries by PID, preferring newer incoming entries.
 *
 * @param existing - Existing entries from a destination file
 * @param incoming - Incoming entries from migration source
 * @returns Deduplicated merged entries
 */
function mergeEntries(existing: readonly PidEntry[], incoming: readonly PidEntry[]): PidEntry[] {
	const byPid = new Map<number, PidEntry>();
	for (const entry of existing) {
		byPid.set(entry.pid, entry);
	}
	for (const entry of incoming) {
		byPid.set(entry.pid, entry);
	}
	return [...byPid.values()];
}

/**
 * Migrate legacy global PID state into session-scoped files.
 *
 * @returns Nothing
 */
function migrateLegacyPidFile(): void {
	const legacy = readLegacyPidFile();
	if (!legacy) {
		return;
	}

	const legacyPidFilePath = getLegacyPidFilePath();
	const sessionPidDir = getSessionPidDirPath();

	if (legacy.entries.length === 0) {
		removeFile(legacyPidFilePath);
		return;
	}

	if (!existsSync(sessionPidDir)) {
		mkdirSync(sessionPidDir, { recursive: true });
	}

	const grouped = new Map<string, SessionPidFile>();
	for (const entry of legacy.entries) {
		const owner: SessionOwner =
			typeof entry.ownerPid === "number"
				? { pid: entry.ownerPid, startedAt: entry.ownerStartedAt }
				: { pid: -1, startedAt: undefined };
		const key = toOwnerKey(owner);
		const current = grouped.get(key) ?? { version: 2, owner, entries: [] };
		current.entries.push(entry);
		grouped.set(key, current);
	}

	for (const file of grouped.values()) {
		const filePath = getSessionPidFilePath(file.owner);
		const existing = readSessionPidFile(filePath);
		const merged = mergeEntries(existing?.entries ?? [], file.entries);
		const owner = existing?.owner ?? file.owner;
		writeSessionPidFile(filePath, { version: 2, owner, entries: merged });
	}

	removeFile(legacyPidFilePath);
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

/**
 * Verify whether a session owner is still active and identity-matched.
 *
 * @param owner - Session owner identity
 * @returns True when owner process is still active and unchanged
 */
function hasMatchingSessionOwner(owner: SessionOwner): boolean {
	if (!hasOwnerIdentity(owner)) {
		return false;
	}
	if (!isProcessAlive(owner.pid)) {
		return false;
	}
	const currentOwnerStartedAt = readProcessStartedAt(owner.pid);
	if (!currentOwnerStartedAt) {
		return false;
	}
	return currentOwnerStartedAt === owner.startedAt;
}

/**
 * Sweep entries for a stale owner file.
 *
 * @param entries - Entries from a stale-owner session file
 * @returns Killed count and remaining entries
 */
function cleanupStaleOwnerEntries(entries: readonly PidEntry[]): {
	killed: number;
	remaining: PidEntry[];
} {
	let killed = 0;
	const remaining: PidEntry[] = [];

	for (const entry of entries) {
		if (!isProcessAlive(entry.pid)) {
			continue;
		}
		if (!hasMatchingProcessIdentity(entry)) {
			// Missing/mismatched child identity is unsafe — keep entry.
			remaining.push(entry);
			continue;
		}
		try {
			// Negative PID -> signal process group (detached children are group leaders)
			process.kill(-entry.pid, "SIGTERM");
			killed++;
		} catch {
			// Process may have exited between probe and kill — keep conservative state.
			remaining.push(entry);
		}
	}

	return { killed, remaining };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Clean up orphaned child processes left over from stale sessions.
 *
 * Startup cleanup migrates any legacy global PID file, then sweeps only
 * session files whose owner identity is present and no longer active.
 * Files owned by live sessions are left untouched.
 *
 * @returns Number of orphaned processes killed
 */
export function cleanupOrphanPids(): number {
	migrateLegacyPidFile();

	let killed = 0;
	for (const filePath of listSessionPidFiles()) {
		const file = readSessionPidFile(filePath);
		if (!file) {
			removeFile(filePath);
			continue;
		}

		if (hasMatchingSessionOwner(file.owner)) {
			// Live owner session — never interfere.
			continue;
		}

		if (!hasOwnerIdentity(file.owner)) {
			// Unknown owner identity fails safe — no blind signaling.
			continue;
		}

		const result = cleanupStaleOwnerEntries(file.entries);
		killed += result.killed;
		if (result.remaining.length === 0) {
			removeFile(filePath);
		} else {
			writeSessionPidFile(filePath, {
				...file,
				entries: result.remaining,
			});
		}
	}

	return killed;
}

/**
 * Kill tracked child processes owned by the current session only.
 *
 * Called during process shutdown (SIGTERM / SIGINT) as a safety net after
 * `session_shutdown` fires. Files owned by other sessions are untouched.
 *
 * @returns Number of processes signaled
 */
export function cleanupAllTrackedPids(): number {
	migrateLegacyPidFile();

	let killed = 0;
	const currentStartedAt = readProcessStartedAt(process.pid);

	for (const filePath of listSessionPidFiles()) {
		const file = readSessionPidFile(filePath);
		if (!file) {
			continue;
		}
		if (file.owner.pid !== process.pid) {
			continue;
		}
		if (typeof file.owner.startedAt !== "string" || !currentStartedAt) {
			continue;
		}
		if (file.owner.startedAt !== currentStartedAt) {
			continue;
		}

		const result = cleanupStaleOwnerEntries(file.entries);
		killed += result.killed;
		removeFile(filePath);
	}

	return killed;
}
