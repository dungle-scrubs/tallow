/**
 * Structured diagnostic logger for tallow debug mode.
 *
 * Emits JSONL to a session-scoped log file (or stderr). Zero-cost when
 * debug mode is inactive — `isDebug()` is resolved once and cached.
 *
 * Activation precedence:
 *   1. TALLOW_DEBUG env var (truthy = file, "stderr" = stderr)
 *   2. NODE_ENV=development
 *   3. Running via tsx (source in /src/ not /dist/)
 */

import { appendFileSync, existsSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Log entry categories that partition diagnostic output. */
export type LogCategory =
	| "session"
	| "tool"
	| "model"
	| "turn"
	| "agent"
	| "mcp"
	| "subagent"
	| "error";

/** Single JSONL log entry written to the debug log. */
export interface LogEntry {
	ts: string;
	cat: LogCategory;
	evt: string;
	data: Record<string, unknown>;
}

/** Maximum string length for values in log data before truncation. */
const MAX_STRING_LENGTH = 500;

/** Cached debug mode result — resolved once per process. */
let debugCached: boolean | undefined;

/**
 * Checks whether debug mode is active.
 *
 * Resolution order:
 *   1. TALLOW_DEBUG env var (any truthy value including "stderr")
 *   2. NODE_ENV=development
 *   3. import.meta.url contains /src/ (running via tsx, not compiled dist/)
 *
 * @returns True if debug diagnostics should be emitted
 */
export function isDebug(): boolean {
	if (debugCached !== undefined) return debugCached;

	const envDebug = process.env.TALLOW_DEBUG;
	if (envDebug && envDebug !== "0" && envDebug !== "false") {
		debugCached = true;
		return true;
	}

	if (process.env.NODE_ENV === "development") {
		debugCached = true;
		return true;
	}

	// Source detection: tsx runs from /src/, compiled runs from /dist/
	if (import.meta.url.includes("/src/")) {
		debugCached = true;
		return true;
	}

	debugCached = false;
	return false;
}

/**
 * Resets the cached debug state. Only used in tests.
 */
export function resetDebugCache(): void {
	debugCached = undefined;
}

/**
 * Truncates string values in an object to MAX_STRING_LENGTH.
 * Recurses into nested objects but not arrays (arrays are serialized as-is).
 *
 * @param data - Object whose string values may need truncation
 * @returns New object with truncated strings
 */
function truncateData(data: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
			result[key] = `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length} chars]`;
		} else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			result[key] = truncateData(value as Record<string, unknown>);
		} else {
			result[key] = value;
		}
	}
	return result;
}

/**
 * Structured JSONL logger for debug diagnostics.
 *
 * Each instance writes to a single destination: either a file
 * (append mode, default ~/.tallow/debug.log) or stderr.
 * A session header is written on creation for log correlation.
 */
export class DebugLogger {
	private useStderr: boolean;
	private closed = false;
	readonly logPath: string;

	/**
	 * @param sessionId - Session identifier for log correlation
	 * @param logDir - Directory for the log file (default: ~/.tallow)
	 */
	constructor(
		readonly sessionId: string,
		logDir?: string
	) {
		this.useStderr = process.env.TALLOW_DEBUG === "stderr";
		const dir = logDir ?? join(homedir(), ".tallow");
		this.logPath = join(dir, "debug.log");

		if (!this.useStderr) {
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			// Touch the file so it exists even before the first log()
			if (!existsSync(this.logPath)) {
				writeFileSync(this.logPath, "");
			}
		}

		// Write session header
		this.log("session", "log_start", {
			sessionId,
			cwd: process.cwd(),
			pid: process.pid,
		});
	}

	/**
	 * Writes a structured JSONL log entry.
	 *
	 * Uses synchronous I/O — debug logging is infrequent and
	 * correctness (no lost entries) matters more than throughput.
	 *
	 * @param cat - Log category (session, tool, model, etc.)
	 * @param evt - Event name within the category
	 * @param data - Arbitrary data payload (string values truncated at 500 chars)
	 */
	log(cat: LogCategory, evt: string, data: Record<string, unknown>): void {
		if (this.closed) return;

		const entry: LogEntry = {
			ts: new Date().toISOString(),
			cat,
			evt,
			data: truncateData(data),
		};

		const line = `${JSON.stringify(entry)}\n`;

		if (this.useStderr) {
			process.stderr.write(line);
		} else {
			appendFileSync(this.logPath, line);
		}
	}

	/**
	 * Truncates the log file to zero bytes.
	 */
	clear(): void {
		if (!this.useStderr && existsSync(this.logPath)) {
			truncateSync(this.logPath, 0);
		}
	}

	/**
	 * Marks the logger as closed.
	 * Subsequent log() calls are no-ops.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
	}
}

/**
 * Creates a DebugLogger and stores it on globalThis for cross-reload persistence.
 *
 * @param sessionId - Session identifier
 * @param logDir - Optional override for log directory
 * @returns The created DebugLogger instance
 */
export function createDebugLogger(sessionId: string, logDir?: string): DebugLogger {
	const logger = new DebugLogger(sessionId, logDir);
	globalThis.__piDebugLogger = logger;
	return logger;
}
