import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { PROJECT_TRUST_STORE_PATH, TRUST_DIR } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Project trust status derived from the trust store and current fingerprint.
 *
 * - `trusted` — trust entry exists and fingerprint matches.
 * - `untrusted` — no trust entry for this canonical path.
 * - `stale_fingerprint` — trust entry exists but fingerprint changed.
 */
export type ProjectTrustStatus = "trusted" | "untrusted" | "stale_fingerprint";

/**
 * Resolved trust context for a single project (canonical cwd).
 */
export interface ProjectTrustContext {
	/** Canonical realpath for the project cwd. */
	readonly canonicalCwd: string;
	/** Current fingerprint for trust-scoped project files. */
	readonly fingerprint: string;
	/** Fingerprint stored in the trust store, or null when never trusted. */
	readonly storedFingerprint: string | null;
	/** Effective status derived from stored vs current fingerprint. */
	readonly status: ProjectTrustStatus;
}

/** Persisted trust schema version for fingerprints written by this build. */
const PROJECT_TRUST_SCHEMA_VERSION = 2;

/** In-memory trust store entry for a single project. */
interface ProjectTrustStoreEntry {
	readonly fingerprint: string;
	readonly trustedAt: string;
	readonly version: number | null;
}

/** Serialized trust store entry written to disk. */
interface PersistedProjectTrustStoreEntry {
	readonly fingerprint: string;
	readonly trustedAt: string;
	readonly version?: number;
}

/** Parsed trust store keyed by canonical project path. */
type ProjectTrustStore = Record<string, ProjectTrustStoreEntry>;

// ─── Environment Keys ───────────────────────────────────────────────────────

/** Environment key for current project trust status. */
export const PROJECT_TRUST_STATUS_ENV = "TALLOW_PROJECT_TRUST_STATUS";

/** Environment key for canonical cwd tied to trust status. */
export const PROJECT_TRUST_CWD_ENV = "TALLOW_PROJECT_TRUST_CWD";

/** Environment key for current trust fingerprint. */
export const PROJECT_TRUST_FINGERPRINT_ENV = "TALLOW_PROJECT_TRUST_FINGERPRINT";

/** Environment key for stored trust fingerprint (if any). */
export const PROJECT_TRUST_STORED_FINGERPRINT_ENV = "TALLOW_PROJECT_TRUST_STORED_FINGERPRINT";

/** Optional test override for trust store path. */
const PROJECT_TRUST_STORE_OVERRIDE_ENV = "TALLOW_PROJECT_TRUST_STORE_PATH";

// ─── Trust Store I/O ────────────────────────────────────────────────────────

/**
 * Resolve the trust store path, honoring a test override env var.
 *
 * @returns Absolute path to the project trust store JSON file
 */
function getTrustStorePath(): string {
	return process.env[PROJECT_TRUST_STORE_OVERRIDE_ENV] ?? PROJECT_TRUST_STORE_PATH;
}

/**
 * Resolve the directory containing the trust store.
 *
 * @returns Absolute directory path for trust metadata
 */
function getTrustStoreDir(): string {
	const storePath = getTrustStorePath();
	return dirname(storePath || TRUST_DIR);
}

/**
 * Build a current-schema trust store entry.
 *
 * @param fingerprint - Current trust fingerprint
 * @param trustedAt - Original trust approval timestamp
 * @returns Current-schema trust store entry
 */
function createCurrentTrustStoreEntry(
	fingerprint: string,
	trustedAt: string
): ProjectTrustStoreEntry {
	return {
		fingerprint,
		trustedAt,
		version: PROJECT_TRUST_SCHEMA_VERSION,
	};
}

/**
 * Return true when a stored trust entry predates the current schema.
 *
 * @param entry - Trust store entry to inspect
 * @returns True when the entry should be migrated forward
 */
function shouldMigrateTrustStoreEntry(entry: ProjectTrustStoreEntry): boolean {
	if (entry.version === null) return true;
	return entry.version < PROJECT_TRUST_SCHEMA_VERSION;
}

/**
 * Convert an in-memory trust store to its persisted JSON representation.
 *
 * Legacy entries omit the `version` key to preserve their original shape
 * unless they are explicitly migrated.
 *
 * @param store - Trust store to serialize
 * @returns JSON-safe trust store object
 */
function serializeTrustStore(
	store: ProjectTrustStore
): Record<string, PersistedProjectTrustStoreEntry> {
	const persisted: Record<string, PersistedProjectTrustStoreEntry> = {};
	for (const [key, entry] of Object.entries(store)) {
		persisted[key] =
			typeof entry.version === "number"
				? {
						fingerprint: entry.fingerprint,
						trustedAt: entry.trustedAt,
						version: entry.version,
					}
				: {
						fingerprint: entry.fingerprint,
						trustedAt: entry.trustedAt,
					};
	}
	return persisted;
}

/**
 * Load the project trust store from disk.
 *
 * Corrupt or unreadable data is treated as an empty store to fail closed.
 *
 * @returns Parsed trust store object (possibly empty)
 */
function loadTrustStore(): ProjectTrustStore {
	const storePath = getTrustStorePath();
	if (!existsSync(storePath)) return {};

	try {
		const raw = readFileSync(storePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object") return {};

		const store: ProjectTrustStore = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!value || typeof value !== "object") continue;
			const entry = value as Partial<PersistedProjectTrustStoreEntry>;
			if (typeof entry.fingerprint !== "string" || typeof entry.trustedAt !== "string") continue;
			store[key] = {
				fingerprint: entry.fingerprint,
				trustedAt: entry.trustedAt,
				version: typeof entry.version === "number" ? entry.version : null,
			};
		}
		return store;
	} catch {
		// Corrupt trust metadata → behave as if no projects are trusted.
		return {};
	}
}

/**
 * Persist the project trust store to disk.
 *
 * Best-effort only — failures are logged but do not crash startup.
 *
 * @param store - Trust store to persist
 * @returns void
 */
function saveTrustStore(store: ProjectTrustStore): void {
	try {
		const trustDir = getTrustStoreDir();
		if (!existsSync(trustDir)) {
			mkdirSync(trustDir, { recursive: true });
		}
		const json = JSON.stringify(serializeTrustStore(store), null, "\t");
		atomicWriteFileSync(getTrustStorePath(), `${json}\n`);
	} catch {
		// Persist failures leave trust ephemeral for this process but do not
		// compromise safety — the session still treats the project as trusted
		// for its lifetime; a restart may require re-trusting.
	}
}

// ─── Fingerprint Computation ────────────────────────────────────────────────

/**
 * Resolve canonical realpath for a working directory.
 *
 * @param cwd - Original working directory
 * @returns Canonical absolute path; falls back to resolved path on failure
 */
export function getCanonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

/** Keys from `.tallow/settings*.json` that are part of the trust scope. */
const TALLOW_SETTINGS_TRUST_KEYS = [
	"plugins",
	"hooks",
	"mcpServers",
	"packages",
	"permissions",
	"shellInterpolation",
] as const;

/** Keys from `.claude/settings*.json` that can change trusted behavior. */
const CLAUDE_SETTINGS_TRUST_KEYS = ["hooks", "permissions"] as const;

/** Project-local directories whose contents affect trusted execution. */
const TRUST_SCOPED_DIRECTORIES = [
	{ label: "tallow-extensions", relativePath: join(".tallow", "extensions") },
	{ label: "tallow-agents", relativePath: join(".tallow", "agents") },
	{ label: "tallow-skills", relativePath: join(".tallow", "skills") },
	{ label: "tallow-prompts", relativePath: join(".tallow", "prompts") },
	{ label: "tallow-commands", relativePath: join(".tallow", "commands") },
	{ label: "tallow-rules", relativePath: join(".tallow", "rules") },
	{ label: "claude-agents", relativePath: join(".claude", "agents") },
	{ label: "claude-skills", relativePath: join(".claude", "skills") },
	{ label: "claude-commands", relativePath: join(".claude", "commands") },
	{ label: "claude-rules", relativePath: join(".claude", "rules") },
] as const;

/**
 * Recursively collect all files under a directory.
 *
 * @param rootDir - Directory to walk
 * @returns Sorted array of absolute file paths
 */
function collectFilesRecursively(rootDir: string): string[] {
	const files: string[] = [];
	if (!existsSync(rootDir)) return files;

	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			// Directory unreadable — skip subtree
			continue;
		}

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			try {
				if (entry.isDirectory()) {
					stack.push(fullPath);
				} else if (entry.isFile()) {
					files.push(fullPath);
				}
			} catch {
				// Entry may disappear between readdir and stat — ignore
			}
		}
	}

	files.sort((a, b) => a.localeCompare(b));
	return files;
}

/**
 * Hash a settings file, optionally restricting the fingerprint to selected top-level keys.
 *
 * @param hash - Hash accumulator receiving the file fingerprint
 * @param canonicalCwd - Canonical project root used for relative path stability
 * @param filePath - Absolute settings file path
 * @param label - Stable label written into the hash stream
 * @param keys - Optional subset of top-level keys to include
 * @returns void
 */
function hashSettingsFile(
	hash: ReturnType<typeof createHash>,
	canonicalCwd: string,
	filePath: string,
	label: string,
	keys?: readonly string[]
): void {
	hash.update(`${label}:${relative(canonicalCwd, filePath)}\n`);
	if (!existsSync(filePath)) {
		hash.update("missing\n");
		return;
	}

	let raw: string | null = null;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		raw = null;
	}

	if (raw === null) {
		hash.update("unreadable\n");
		return;
	}

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!keys) {
			hash.update(JSON.stringify(parsed));
			return;
		}

		const subset: Record<string, unknown> = {};
		for (const key of keys) {
			if (Object.hasOwn(parsed, key)) {
				subset[key] = parsed[key];
			}
		}
		hash.update(JSON.stringify(subset));
	} catch {
		// Invalid JSON still needs to invalidate trust deterministically.
		hash.update("raw:\n");
		hash.update(raw);
	}
}

/**
 * Hash a project-local file or directory tree into the project trust fingerprint.
 *
 * @param hash - Hash accumulator receiving the tree fingerprint
 * @param canonicalCwd - Canonical project root used for relative path stability
 * @param label - Stable label written into the hash stream
 * @param fullPath - Absolute file or directory path
 * @returns void
 */
function hashProjectPath(
	hash: ReturnType<typeof createHash>,
	canonicalCwd: string,
	label: string,
	fullPath: string
): void {
	const files = collectFilesRecursively(fullPath);
	if (files.length === 0) {
		hash.update(`${label}-none\n`);
		return;
	}

	hash.update(`${label}\n`);
	for (const filePath of files) {
		const rel = relative(canonicalCwd, filePath);
		hash.update(`file:${rel}\n`);
		try {
			const content = readFileSync(filePath);
			hash.update(content);
		} catch {
			hash.update("<unreadable>\n");
		}
	}
}

/**
 * Compute a stable SHA-256 fingerprint over trust-scoped project files.
 *
 * Trust scope:
 * - `.tallow/settings*.json` keys: plugins, hooks, mcpServers, packages,
 *   permissions, shellInterpolation
 * - `.claude/settings*.json` keys: hooks, permissions
 * - `.tallow/hooks.json` (entire contents)
 * - project-local trusted resource directories such as agents/extensions/skills
 *
 * @param canonicalCwd - Canonical project root path
 * @returns Hex-encoded fingerprint string
 */
export function computeProjectFingerprint(canonicalCwd: string): string {
	const hash = createHash("sha256");
	const projectConfigDir = join(canonicalCwd, ".tallow");
	const projectClaudeDir = join(canonicalCwd, ".claude");

	hash.update(`tallow-project-trust/v${PROJECT_TRUST_SCHEMA_VERSION}\n`);

	hashSettingsFile(
		hash,
		canonicalCwd,
		join(projectConfigDir, "settings.json"),
		"tallow-settings",
		TALLOW_SETTINGS_TRUST_KEYS
	);
	hashSettingsFile(
		hash,
		canonicalCwd,
		join(projectConfigDir, "settings.local.json"),
		"tallow-settings-local",
		TALLOW_SETTINGS_TRUST_KEYS
	);
	hashSettingsFile(
		hash,
		canonicalCwd,
		join(projectClaudeDir, "settings.json"),
		"claude-settings",
		CLAUDE_SETTINGS_TRUST_KEYS
	);
	hashSettingsFile(
		hash,
		canonicalCwd,
		join(projectClaudeDir, "settings.local.json"),
		"claude-settings-local",
		CLAUDE_SETTINGS_TRUST_KEYS
	);
	hashSettingsFile(hash, canonicalCwd, join(projectConfigDir, "hooks.json"), "tallow-hooks");

	for (const directory of TRUST_SCOPED_DIRECTORIES) {
		hashProjectPath(
			hash,
			canonicalCwd,
			directory.label,
			join(canonicalCwd, directory.relativePath)
		);
	}

	return hash.digest("hex");
}

// ─── Env Projection ─────────────────────────────────────────────────────────

/**
 * Project trust statuses that are accepted from environment variables.
 */
const VALID_TRUST_STATUSES = new Set<ProjectTrustStatus>([
	"trusted",
	"untrusted",
	"stale_fingerprint",
]);

/**
 * Read the current project trust status from environment variables.
 *
 * Invalid or missing values fail closed to `untrusted`.
 *
 * @returns Trust status from process environment
 */
export function getProjectTrustStatusFromEnv(): ProjectTrustStatus {
	const raw = process.env[PROJECT_TRUST_STATUS_ENV];
	if (raw && VALID_TRUST_STATUSES.has(raw as ProjectTrustStatus)) {
		return raw as ProjectTrustStatus;
	}
	return "untrusted";
}

/**
 * Return whether the current process environment marks the project as trusted.
 *
 * @returns True when trust status is `trusted`
 */
export function isProjectTrustedFromEnv(): boolean {
	return getProjectTrustStatusFromEnv() === "trusted";
}

/**
 * Apply a project trust context to process environment variables so
 * extensions can enforce trust-gated behavior without importing core modules.
 *
 * @param context - Resolved project trust context
 * @returns void
 */
export function applyProjectTrustContextToEnv(context: ProjectTrustContext): void {
	process.env[PROJECT_TRUST_STATUS_ENV] = context.status;
	process.env[PROJECT_TRUST_CWD_ENV] = context.canonicalCwd;
	process.env[PROJECT_TRUST_FINGERPRINT_ENV] = context.fingerprint;
	if (context.storedFingerprint) {
		process.env[PROJECT_TRUST_STORED_FINGERPRINT_ENV] = context.storedFingerprint;
	} else {
		delete process.env[PROJECT_TRUST_STORED_FINGERPRINT_ENV];
	}
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve trust status for a project based on the current fingerprint
 * and the persisted trust store entry.
 *
 * @param cwd - Working directory (may be relative); will be canonicalized
 * @returns Resolved project trust context
 */
export function resolveProjectTrust(cwd: string): ProjectTrustContext {
	const canonicalCwd = getCanonicalCwd(cwd);
	const fingerprint = computeProjectFingerprint(canonicalCwd);
	const store = loadTrustStore();
	const entry = store[canonicalCwd] ?? null;

	if (!entry) {
		return {
			canonicalCwd,
			fingerprint,
			storedFingerprint: null,
			status: "untrusted",
		};
	}

	if (shouldMigrateTrustStoreEntry(entry)) {
		const migratedEntry = createCurrentTrustStoreEntry(fingerprint, entry.trustedAt);
		store[canonicalCwd] = migratedEntry;
		saveTrustStore(store);
		return {
			canonicalCwd,
			fingerprint,
			storedFingerprint: migratedEntry.fingerprint,
			status: "trusted",
		};
	}

	const status: ProjectTrustStatus =
		entry.fingerprint === fingerprint ? "trusted" : "stale_fingerprint";
	return {
		canonicalCwd,
		fingerprint,
		storedFingerprint: entry.fingerprint,
		status,
	};
}

/**
 * Mark the current project as trusted by recording its fingerprint
 * in the trust store.
 *
 * @param cwd - Working directory to trust
 * @returns Updated project trust context with status "trusted"
 */
export function trustProject(cwd: string): ProjectTrustContext {
	const canonicalCwd = getCanonicalCwd(cwd);
	const fingerprint = computeProjectFingerprint(canonicalCwd);
	const store = loadTrustStore();

	store[canonicalCwd] = createCurrentTrustStoreEntry(fingerprint, new Date().toISOString());

	saveTrustStore(store);

	return {
		canonicalCwd,
		fingerprint,
		storedFingerprint: fingerprint,
		status: "trusted",
	};
}

/**
 * Remove any stored trust entry for the current project.
 *
 * The current fingerprint is still returned so callers can show it
 * in diagnostics, but no trust metadata is persisted.
 *
 * @param cwd - Working directory to untrust
 * @returns Project trust context with status "untrusted"
 */
export function untrustProject(cwd: string): ProjectTrustContext {
	const canonicalCwd = getCanonicalCwd(cwd);
	const fingerprint = computeProjectFingerprint(canonicalCwd);
	const store = loadTrustStore();
	const existing = store[canonicalCwd] ?? null;

	if (existing) {
		delete store[canonicalCwd];
		saveTrustStore(store);
	}

	return {
		canonicalCwd,
		fingerprint,
		storedFingerprint: existing?.fingerprint ?? null,
		status: "untrusted",
	};
}
