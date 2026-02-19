import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

/** On-disk trust store entry for a single project. */
interface ProjectTrustStoreEntry {
	readonly fingerprint: string;
	readonly trustedAt: string;
}

/** Parsed trust store keyed by canonical project path. */
type ProjectTrustStore = Record<string, ProjectTrustStoreEntry>;

// ─── Trust Store I/O ────────────────────────────────────────────────────────

/**
 * Load the project trust store from disk.
 *
 * Corrupt or unreadable data is treated as an empty store to fail closed.
 *
 * @returns Parsed trust store object (possibly empty)
 */
function loadTrustStore(): ProjectTrustStore {
	if (!existsSync(PROJECT_TRUST_STORE_PATH)) return {};

	try {
		const raw = readFileSync(PROJECT_TRUST_STORE_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object") return {};

		const store: ProjectTrustStore = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!value || typeof value !== "object") continue;
			const entry = value as Partial<ProjectTrustStoreEntry>;
			if (typeof entry.fingerprint !== "string" || typeof entry.trustedAt !== "string") continue;
			store[key] = { fingerprint: entry.fingerprint, trustedAt: entry.trustedAt };
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
		if (!existsSync(TRUST_DIR)) {
			mkdirSync(TRUST_DIR, { recursive: true });
		}
		const json = JSON.stringify(store, null, "\t");
		atomicWriteFileSync(PROJECT_TRUST_STORE_PATH, `${json}\n`);
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

/** Keys from .tallow/settings.json that are part of the trust scope. */
const SETTINGS_TRUST_KEYS = [
	"plugins",
	"hooks",
	"mcpServers",
	"packages",
	"permissions",
	"shellInterpolation",
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
 * Compute a stable SHA-256 fingerprint over trust-scoped project files.
 *
 * Trust scope:
 * - .tallow/settings.json keys: plugins, hooks, mcpServers, packages,
 *   permissions, shellInterpolation
 * - .tallow/hooks.json (entire contents)
 * - .tallow/extensions/** (all files under this directory)
 *
 * @param canonicalCwd - Canonical project root path
 * @returns Hex-encoded fingerprint string
 */
export function computeProjectFingerprint(canonicalCwd: string): string {
	const hash = createHash("sha256");
	const projectConfigDir = join(canonicalCwd, ".tallow");

	hash.update("tallow-project-trust/v1\n");

	// .tallow/settings.json subset
	const settingsPath = join(projectConfigDir, "settings.json");
	if (existsSync(settingsPath)) {
		let raw: string | null = null;
		try {
			raw = readFileSync(settingsPath, "utf-8");
		} catch {
			raw = null;
		}

		hash.update("settings\n");

		if (raw !== null) {
			try {
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				const subset: Record<string, unknown> = {};
				for (const key of SETTINGS_TRUST_KEYS) {
					if (Object.hasOwn(parsed, key)) {
						subset[key] = parsed[key];
					}
				}
				hash.update(JSON.stringify(subset));
			} catch {
				// Invalid JSON — fall back to raw content so changes still
				// invalidate trust even if the file is temporarily corrupt.
				hash.update("raw:\n");
				hash.update(raw);
			}
		} else {
			hash.update("missing\n");
		}
	} else {
		hash.update("settings-missing\n");
	}

	// .tallow/hooks.json (entire file, canonicalized when JSON)
	const hooksPath = join(projectConfigDir, "hooks.json");
	if (existsSync(hooksPath)) {
		try {
			const raw = readFileSync(hooksPath, "utf-8");
			try {
				const parsed = JSON.parse(raw) as unknown;
				hash.update("hooks-json\n");
				hash.update(JSON.stringify(parsed));
			} catch {
				hash.update("hooks-raw\n");
				hash.update(raw);
			}
		} catch {
			hash.update("hooks-unreadable\n");
		}
	} else {
		hash.update("hooks-missing\n");
	}

	// .tallow/extensions/** (all files, path + bytes)
	const extensionsDir = join(projectConfigDir, "extensions");
	const extensionFiles = collectFilesRecursively(extensionsDir);
	if (extensionFiles.length === 0) {
		hash.update("extensions-none\n");
	} else {
		hash.update("extensions\n");
		for (const filePath of extensionFiles) {
			const rel = relative(canonicalCwd, filePath);
			// Include relative path so renames also affect fingerprint.
			hash.update(`file:${rel}\n`);
			try {
				const content = readFileSync(filePath);
				hash.update(content);
			} catch {
				// Unreadable file still contributes a stable token so changes
				// in readability/fix also update the fingerprint.
				hash.update("<unreadable>\n");
			}
		}
	}

	return hash.digest("hex");
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
	const storedFingerprint = entry?.fingerprint ?? null;

	let status: ProjectTrustStatus;
	if (!entry) {
		status = "untrusted";
	} else if (entry.fingerprint === fingerprint) {
		status = "trusted";
	} else {
		status = "stale_fingerprint";
	}

	return { canonicalCwd, fingerprint, storedFingerprint, status };
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

	store[canonicalCwd] = {
		fingerprint,
		trustedAt: new Date().toISOString(),
	};

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
