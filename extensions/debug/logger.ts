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

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getTallowHomeDir } from "../_shared/tallow-paths.js";

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

/** Placeholder value used when sensitive fields are redacted. */
const REDACTED_VALUE = "[REDACTED]";

/** Sensitive key segments that should always be redacted. */
const SENSITIVE_KEY_SEGMENTS = new Set([
	"auth",
	"authorization",
	"bearer",
	"cookie",
	"cookies",
	"credential",
	"credentials",
	"key",
	"password",
	"passwd",
	"passphrase",
	"secret",
	"token",
]);

/** Compact key patterns that may appear without separators (e.g. apiKey). */
const SENSITIVE_COMPACT_PATTERNS = [
	"accesskey",
	"apikey",
	"clientsecret",
	"privatekey",
	"setcookie",
] as const;

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
 * Splits a key into normalized lowercase segments for pattern matching.
 *
 * @param key - Raw object key from a log payload
 * @returns Normalized key segments (e.g. "apiKey" → ["api", "key"])
 */
function normalizeKeySegments(key: string): string[] {
	const normalized = key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.toLowerCase();
	return normalized.split("_").filter(Boolean);
}

/**
 * Checks whether a key name should be treated as sensitive.
 *
 * @param key - Object key to evaluate
 * @returns True when the key matches the redaction policy
 */
function isSensitiveKey(key: string): boolean {
	const segments = normalizeKeySegments(key);
	if (segments.length === 0) return false;

	if (segments.some((segment) => SENSITIVE_KEY_SEGMENTS.has(segment))) {
		return true;
	}

	const compact = segments.join("");
	return SENSITIVE_COMPACT_PATTERNS.some((pattern) => compact.includes(pattern));
}

/**
 * Recursively redacts sensitive fields from an unknown value.
 *
 * @param value - Value to redact
 * @returns A deep-cloned value with sensitive keys replaced by [REDACTED]
 */
function redactValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item));
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
			result[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactValue(nestedValue);
		}
		return result;
	}

	return value;
}

/**
 * Redacts sensitive fields in a log payload.
 *
 * @param data - Log payload object
 * @returns Redacted payload object
 */
function redactData(data: Record<string, unknown>): Record<string, unknown> {
	return redactValue(data) as Record<string, unknown>;
}

/**
 * Recursively truncates long string values in a payload value.
 *
 * @param value - Value to truncate
 * @returns Deep-cloned value with long strings shortened for log safety
 */
function truncateValue(value: unknown): unknown {
	if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
		return `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length} chars]`;
	}

	if (Array.isArray(value)) {
		return value.map((item) => truncateValue(item));
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
			result[key] = truncateValue(nestedValue);
		}
		return result;
	}

	return value;
}

/**
 * Truncates string values in an object to MAX_STRING_LENGTH.
 * Recurses into nested objects and arrays.
 *
 * @param data - Object whose string values may need truncation
 * @returns New object with truncated strings
 */
function truncateData(data: Record<string, unknown>): Record<string, unknown> {
	return truncateValue(data) as Record<string, unknown>;
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
		const dir = logDir ?? getTallowHomeDir();
		this.logPath = join(dir, "debug.log");

		if (!this.useStderr) {
			// mkdirSync with recursive is idempotent (no TOCTOU race)
			mkdirSync(dir, { recursive: true });
			// Append mode creates the file atomically if it doesn't exist
			writeFileSync(this.logPath, "", { flag: "a" });
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
	 * @param data - Arbitrary data payload (sensitive keys redacted, long strings truncated)
	 */
	log(cat: LogCategory, evt: string, data: Record<string, unknown>): void {
		if (this.closed) return;

		const entry: LogEntry = {
			ts: new Date().toISOString(),
			cat,
			evt,
			data: truncateData(redactData(data)),
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

// ── Log Query Infrastructure ─────────────────────────────────

/** Filter options for querying log entries. */
export interface QueryOptions {
	/** Filter by log category (session, tool, model, etc.) */
	category?: LogCategory;
	/** Filter by event type within a category */
	eventType?: string;
	/** Maximum number of entries to return (newest first) */
	limit?: number;
	/** Only include entries after this ISO timestamp */
	since?: string;
	/** Free-text search across serialized entry data */
	search?: string;
}

/**
 * Reads and filters JSONL log entries from the debug log.
 *
 * Parses each line individually — malformed lines are silently skipped.
 * Results are returned newest-first (reversed from file order).
 *
 * @param logPath - Absolute path to the JSONL log file
 * @param options - Filter criteria for narrowing results
 * @returns Array of matching LogEntry objects, newest first
 */
export function queryLog(logPath: string, options: QueryOptions = {}): LogEntry[] {
	if (!existsSync(logPath)) return [];

	const content = readFileSync(logPath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);

	const sinceMs = options.since ? new Date(options.since).getTime() : null;
	const searchLower = options.search?.toLowerCase();

	const matched: LogEntry[] = [];

	for (const line of lines) {
		let entry: LogEntry;
		try {
			entry = JSON.parse(line) as LogEntry;
		} catch {
			continue; // skip malformed lines
		}

		// Category filter
		if (options.category && entry.cat !== options.category) continue;

		// Event type filter
		if (options.eventType && entry.evt !== options.eventType) continue;

		// Timestamp filter
		if (sinceMs !== null) {
			const entryMs = new Date(entry.ts).getTime();
			if (entryMs < sinceMs) continue;
		}

		// Free-text search across serialized data
		if (searchLower) {
			const serialized = JSON.stringify(entry.data).toLowerCase();
			if (!serialized.includes(searchLower) && !entry.evt.toLowerCase().includes(searchLower)) {
				continue;
			}
		}

		matched.push(entry);
	}

	// Return newest first
	matched.reverse();

	// Apply limit after filtering
	if (options.limit && options.limit > 0) {
		return matched.slice(0, options.limit);
	}

	return matched;
}
