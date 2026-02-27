/**
 * Append-only, hash-chained JSONL audit logger.
 *
 * One file per session: ~/.tallow/audit/{sessionId}-{date}.jsonl
 * Each entry's hash = SHA-256(canonical JSON of all fields except `hash`, + prevHash).
 * Entry #1 has prevHash: "".
 *
 * Uses synchronous I/O (same rationale as debug/logger.ts) — correctness
 * (no lost entries) matters more than throughput for an audit trail.
 *
 * There is intentionally no clear() or truncate() — immutable by design.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTallowPath } from "../_shared/tallow-paths.js";
import type { AuditActor, AuditCategory, AuditEntry, AuditTrailConfig } from "./types.js";

/** Default audit directory under the tallow home. */
const DEFAULT_AUDIT_DIR = "audit";

/** Placeholder for redacted sensitive values. */
const REDACTED = "[REDACTED]";

/** Key segments that trigger redaction (matches debug/logger.ts pattern). */
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

/** Compact patterns that may appear without separators (e.g. apiKey). */
const SENSITIVE_COMPACT_PATTERNS = [
	"accesskey",
	"apikey",
	"clientsecret",
	"privatekey",
	"setcookie",
] as const;

/**
 * Splits a key into normalized lowercase segments for pattern matching.
 * Replicates the logic from debug/logger.ts.
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
 */
export function isSensitiveKey(key: string): boolean {
	const segments = normalizeKeySegments(key);
	if (segments.length === 0) return false;

	if (segments.some((segment) => SENSITIVE_KEY_SEGMENTS.has(segment))) {
		return true;
	}

	const compact = segments.join("");
	return SENSITIVE_COMPACT_PATTERNS.some((pattern) => compact.includes(pattern));
}

/**
 * Recursively redact sensitive fields from a value.
 */
function redactValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item));
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			result[k] = isSensitiveKey(k) ? REDACTED : redactValue(v);
		}
		return result;
	}
	return value;
}

/**
 * Compute SHA-256 hash for an audit entry.
 *
 * The hash covers all fields except `hash` itself. The `prevHash` field
 * chains this entry to the previous one, creating a tamper-evident chain.
 */
export function computeEntryHash(entry: Omit<AuditEntry, "hash">): string {
	const canonical = JSON.stringify(stableStringify(entry));
	return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Recursively produce a stable (sorted-key) representation of a value.
 * Ensures hash consistency regardless of insertion order at any depth.
 */
function stableStringify(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map(stableStringify);
	if (typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = stableStringify((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * Append-only, hash-chained audit trail logger.
 *
 * Persisted on globalThis.__piAuditTrailLogger for cross-reload survival.
 */
export class AuditTrailLogger {
	readonly sessionId: string;
	readonly filePath: string;
	private seq: number;
	private lastHash: string;
	private config: AuditTrailConfig;

	constructor(sessionId: string, config?: Partial<AuditTrailConfig>) {
		this.sessionId = sessionId;
		this.config = {
			enabled: config?.enabled ?? true,
			directory: config?.directory,
			redactSensitive: config?.redactSensitive ?? true,
			excludeCategories: config?.excludeCategories,
		};

		const dir = this.config.directory ?? getTallowPath(DEFAULT_AUDIT_DIR);
		const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
		this.filePath = join(dir, `${sessionId}-${date}.jsonl`);

		// Ensure directory exists (idempotent)
		mkdirSync(dir, { recursive: true });

		// Resume support: if file already exists, recover seq and lastHash
		if (existsSync(this.filePath)) {
			const { seq, lastHash } = this.recoverState();
			this.seq = seq;
			this.lastHash = lastHash;
		} else {
			// Create file atomically in append mode
			writeFileSync(this.filePath, "", { flag: "a" });
			this.seq = 0;
			this.lastHash = "";
		}
	}

	/**
	 * Read the last line of the audit file to recover seq and hash.
	 */
	private recoverState(): { seq: number; lastHash: string } {
		try {
			const content = readFileSync(this.filePath, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			if (lines.length === 0) {
				return { seq: 0, lastHash: "" };
			}
			const lastEntry = JSON.parse(lines[lines.length - 1]) as AuditEntry;
			return { seq: lastEntry.seq, lastHash: lastEntry.hash };
		} catch {
			return { seq: 0, lastHash: "" };
		}
	}

	/**
	 * Record an audit event.
	 *
	 * @returns The recorded entry, or null if the event was excluded/disabled.
	 */
	record(params: {
		category: AuditCategory;
		event: string;
		actor: AuditActor;
		data?: Record<string, unknown>;
		before?: Record<string, unknown>;
		after?: Record<string, unknown>;
		outcome?: string;
		reason?: string;
	}): AuditEntry | null {
		if (!this.config.enabled) return null;

		if (this.config.excludeCategories?.includes(params.category)) {
			return null;
		}

		this.seq++;

		const data = this.config.redactSensitive
			? (redactValue(params.data ?? {}) as Record<string, unknown>)
			: (params.data ?? {});
		const before = params.before
			? this.config.redactSensitive
				? (redactValue(params.before) as Record<string, unknown>)
				: params.before
			: undefined;
		const after = params.after
			? this.config.redactSensitive
				? (redactValue(params.after) as Record<string, unknown>)
				: params.after
			: undefined;

		const partial: Omit<AuditEntry, "hash"> = {
			seq: this.seq,
			ts: new Date().toISOString(),
			sessionId: this.sessionId,
			category: params.category,
			event: params.event,
			actor: params.actor,
			data,
			...(before !== undefined && { before }),
			...(after !== undefined && { after }),
			...(params.outcome !== undefined && { outcome: params.outcome }),
			...(params.reason !== undefined && { reason: params.reason }),
			prevHash: this.lastHash,
		};

		const hash = computeEntryHash(partial);
		const entry: AuditEntry = { ...partial, hash };

		// Append synchronously — correctness over throughput
		appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);

		this.lastHash = hash;
		return entry;
	}

	/**
	 * Get current sequence number (for diagnostics).
	 */
	getSeq(): number {
		return this.seq;
	}

	/**
	 * Get the last hash in the chain (for diagnostics).
	 */
	getLastHash(): string {
		return this.lastHash;
	}

	/**
	 * Get current config (for diagnostics).
	 */
	getConfig(): Readonly<AuditTrailConfig> {
		return { ...this.config };
	}
}

/**
 * Create or retrieve the global audit trail logger.
 *
 * Uses globalThis.__piAuditTrailLogger for cross-reload persistence.
 */
export function getOrCreateAuditLogger(
	sessionId: string,
	config?: Partial<AuditTrailConfig>
): AuditTrailLogger {
	const G = globalThis as Record<string, unknown>;
	const existing = G.__piAuditTrailLogger as AuditTrailLogger | undefined;

	if (existing && existing.sessionId === sessionId) {
		return existing;
	}

	const logger = new AuditTrailLogger(sessionId, config);
	G.__piAuditTrailLogger = logger;
	return logger;
}
