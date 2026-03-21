/**
 * Shared PID schema types and validators.
 *
 * Used by both `src/pid-manager.ts` (startup orphan cleanup) and
 * `extensions/_shared/pid-registry.ts` (extension-facing registration).
 * Centralises the on-disk format so both consumers stay in sync.
 */

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
export interface SessionOwner {
	pid: number;
	startedAt?: string;
}

/** Session-scoped PID file schema (version 2). */
export interface SessionPidFile {
	version: 2;
	owner: SessionOwner;
	entries: PidEntry[];
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Check whether a value matches the PID entry schema.
 *
 * Supports legacy entries without owner/process identity metadata.
 *
 * @param value - Unknown JSON value to validate
 * @returns True when the value is a supported PID entry
 */
export function isPidEntry(value: unknown): value is PidEntry {
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
export function isSessionOwner(value: unknown): value is SessionOwner {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.pid !== "number") return false;
	if (candidate.startedAt != null && typeof candidate.startedAt !== "string") {
		return false;
	}
	return true;
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/**
 * Convert owner metadata into a filesystem-safe key.
 *
 * @param owner - Session owner identity
 * @returns Filename-safe owner key
 */
export function toOwnerKey(owner: SessionOwner): string {
	const startedAtSlug = (owner.startedAt ?? "unknown")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const normalizedStartedAt = startedAtSlug.length > 0 ? startedAtSlug : "unknown";
	return `${owner.pid}-${normalizedStartedAt}`;
}
