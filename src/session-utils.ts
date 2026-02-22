/**
 * Session utilities for deterministic session targeting.
 *
 * Provides lookup-by-ID and create-with-ID capabilities on top of pi's
 * SessionManager, which only supports random UUID sessions natively.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { type SessionHeader, SessionManager } from "@mariozechner/pi-coding-agent";
import { atomicWriteFileSync } from "./atomic-write.js";
import { TALLOW_HOME } from "./config.js";
import { encodeSessionDirName } from "./session-migration.js";

/** Current session file format version (mirrors pi's CURRENT_SESSION_VERSION) */
const SESSION_VERSION = 3;

/** Path characters that can escape the session directory when embedded in IDs. */
const FORBIDDEN_SESSION_ID_CHARS = /[\\/\0]/;

/**
 * Validate that a session ID is safe to embed in a session filename.
 *
 * @param sessionId - Raw session ID from CLI/runtime input
 * @returns Nothing
 * @throws {Error} When the ID is empty or contains path separators
 */
export function assertValidSessionId(sessionId: string): void {
	if (sessionId.trim().length === 0) {
		throw new Error("Session ID cannot be empty");
	}
	if (FORBIDDEN_SESSION_ID_CHARS.test(sessionId)) {
		throw new Error("Session ID cannot contain path separators");
	}
}

/**
 * Assert that a computed session file path stays within the target sessions directory.
 *
 * @param sessionsDir - Intended parent sessions directory
 * @param filePath - Candidate session file path
 * @returns Nothing
 * @throws {Error} When the resolved path escapes the sessions directory
 */
function assertContainedSessionPath(sessionsDir: string, filePath: string): void {
	const resolvedSessionsDir = resolve(sessionsDir);
	const resolvedFilePath = resolve(filePath);
	const prefix = resolvedSessionsDir.endsWith(sep)
		? resolvedSessionsDir
		: `${resolvedSessionsDir}${sep}`;
	if (!resolvedFilePath.startsWith(prefix)) {
		throw new Error("Session path resolved outside the sessions directory");
	}
}

/**
 * Compute the per-cwd session directory path.
 *
 * @param cwd - Working directory
 * @returns Absolute path to the session subdirectory
 */
function sessionDirForCwd(cwd: string): string {
	return join(TALLOW_HOME, "sessions", encodeSessionDirName(cwd));
}

/**
 * Find a session file by ID within the per-cwd session directory.
 *
 * Searches by filename suffix first (`*_<sessionId>.jsonl`), then falls
 * back to parsing each file's header line for an `id` match.
 *
 * @param sessionId - The session ID to find (UUID or user-chosen string)
 * @param cwd - Working directory (determines which session subdirectory)
 * @returns Absolute path to the session file, or null if not found
 */
export function findSessionById(sessionId: string, cwd: string): string | null {
	const sessionsDir = sessionDirForCwd(cwd);
	if (!existsSync(sessionsDir)) return null;

	let files: string[];
	try {
		files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}

	// Fast path: match by filename suffix convention (<timestamp>_<id>.jsonl)
	const suffixMatch = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
	if (suffixMatch) return join(sessionsDir, suffixMatch);

	// Slow path: parse header lines
	for (const file of files) {
		const filePath = join(sessionsDir, file);
		try {
			const content = readFileSync(filePath, "utf-8");
			const firstNewline = content.indexOf("\n");
			const headerLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
			const header = JSON.parse(headerLine) as SessionHeader;
			if (header.type === "session" && header.id === sessionId) {
				return filePath;
			}
		} catch {
			// Corrupt or unreadable file — skip
		}
	}

	return null;
}

/**
 * Create a new session file with a specific ID and open it.
 *
 * Pi's SessionManager.create() generates random UUIDs. This writes a
 * minimal header-only JSONL file with the desired ID, then opens it
 * via SessionManager.open() — no pi framework changes needed.
 *
 * @param sessionId - Desired session ID
 * @param cwd - Working directory
 * @returns SessionManager instance for the new session
 */
export function createSessionWithId(sessionId: string, cwd: string): SessionManager {
	assertValidSessionId(sessionId);

	const sessionsDir = sessionDirForCwd(cwd);
	mkdirSync(sessionsDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filename = `${timestamp}_${sessionId}.jsonl`;
	const filePath = join(sessionsDir, filename);
	assertContainedSessionPath(sessionsDir, filePath);

	const header: SessionHeader = {
		type: "session",
		version: SESSION_VERSION,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd,
	};

	atomicWriteFileSync(filePath, `${JSON.stringify(header)}\n`);
	return SessionManager.open(filePath, sessionsDir);
}
