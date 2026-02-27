/**
 * Pharma-grade audit trail types for tallow sessions.
 *
 * Every auditable event is recorded as an immutable, hash-chained entry
 * in append-only JSONL files. The hash chain provides tamper evidence:
 * modifying any entry breaks the chain for all subsequent entries.
 */

/** Actor that triggered the auditable event. */
export type AuditActor = "user" | "agent" | "hook" | "system" | "subagent";

/** High-level category for partitioning audit entries. */
export type AuditCategory =
	| "session"
	| "tool"
	| "shell_policy"
	| "permission"
	| "hook"
	| "agent"
	| "turn"
	| "input"
	| "model"
	| "config";

/**
 * Single immutable audit trail entry.
 *
 * Fields are readonly — entries must never be mutated after creation.
 * The `hash` field provides tamper evidence via SHA-256 chaining.
 */
export interface AuditEntry {
	/** Monotonically increasing sequence number within the session file. */
	readonly seq: number;
	/** ISO-8601 timestamp with millisecond precision. */
	readonly ts: string;
	/** Session identifier for correlation across entries. */
	readonly sessionId: string;
	/** High-level event category. */
	readonly category: AuditCategory;
	/** Specific event name (e.g. "tool_call", "policy_blocked"). */
	readonly event: string;
	/** Actor that triggered the event. */
	readonly actor: AuditActor;
	/** Arbitrary event payload. */
	readonly data: Record<string, unknown>;
	/** State before the event (for change tracking). */
	readonly before?: Record<string, unknown>;
	/** State after the event (for change tracking). */
	readonly after?: Record<string, unknown>;
	/** Event outcome. */
	readonly outcome?: string;
	/** Human-readable reason (e.g. policy rule that blocked). */
	readonly reason?: string;
	/** SHA-256 hash of this entry (excluding `hash`) chained with `prevHash`. */
	readonly hash: string;
	/** Hash of the previous entry ("" for the first entry in a session). */
	readonly prevHash: string;
}

/**
 * Configuration for the audit trail extension.
 */
export interface AuditTrailConfig {
	/** Whether audit logging is active. Default: true. */
	enabled: boolean;
	/** Directory for audit JSONL files. Default: ~/.tallow/audit/. */
	directory?: string;
	/** Redact sensitive keys (passwords, tokens, etc.). Default: true. */
	redactSensitive: boolean;
	/** Categories to exclude from logging. */
	excludeCategories?: AuditCategory[];
}

/**
 * Result of an integrity verification check.
 */
export interface IntegrityResult {
	/** Whether the entire hash chain is valid. */
	valid: boolean;
	/** Total number of entries checked. */
	totalEntries: number;
	/** Sequence number of the first broken entry (if any). */
	firstBrokenSeq?: number;
	/** Human-readable error message for the first break. */
	errorMessage?: string;
}

/**
 * Metadata for a single audit trail file.
 */
export interface AuditFileInfo {
	/** Absolute path to the JSONL file. */
	path: string;
	/** Session ID extracted from the filename. */
	sessionId: string;
	/** Date extracted from the filename. */
	date: string;
	/** File size in bytes. */
	sizeBytes: number;
	/** Number of entries (lines) in the file. */
	entryCount: number;
}

/**
 * Options for querying the audit trail.
 */
export interface AuditQueryOptions {
	/** Filter by category. */
	category?: AuditCategory;
	/** Filter by event name. */
	event?: string;
	/** Filter by actor. */
	actor?: AuditActor;
	/** Filter by outcome. */
	outcome?: string;
	/** Only include entries after this ISO timestamp. */
	since?: string;
	/** Only include entries before this ISO timestamp. */
	until?: string;
	/** Free-text search across serialized entry data. */
	search?: string;
	/** Maximum number of entries to return. */
	limit?: number;
}

/** Supported export formats. */
export type AuditExportFormat = "jsonl" | "csv" | "json";
