/**
 * Plugin system — resolves, fetches, caches, and detects plugin formats.
 *
 * Supports two plugin formats:
 * - **Claude Code plugins**: `.claude-plugin/plugin.json` + resources (commands, agents, skills, hooks)
 * - **Tallow extensions**: `extension.json` + compiled `index.ts`
 *
 * Remote plugins are cached by version. Local plugins are never cached.
 *
 * Plugin spec formats:
 * - `github:owner/repo@version`            — root of repo
 * - `github:owner/repo/subpath@version`    — subdirectory within repo
 * - `https://github.com/owner/repo.git`    — full git URL
 * - `./local/path` or `/absolute/path`     — local directory (never cached)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { TALLOW_HOME } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Parsed plugin spec — the result of parsing a plugin string. */
export interface PluginSpec {
	/** Original spec string */
	readonly raw: string;
	/** Whether this is a local path (never cached) */
	readonly isLocal: boolean;
	/** For remote: GitHub owner */
	readonly owner?: string;
	/** For remote: GitHub repo name */
	readonly repo?: string;
	/** For remote: subdirectory within repo (empty string for root) */
	readonly subpath?: string;
	/** For remote: version tag, branch, or commit SHA */
	readonly ref?: string;
	/** For local: resolved absolute path */
	readonly localPath?: string;
}

/**
 * Normalized remote plugin spec used by fetch/cache operations.
 *
 * This shape is produced after validation and normalization, and is the only
 * form accepted by security-sensitive path/cache helpers.
 */
export interface NormalizedRemotePluginSpec {
	/** Original spec string */
	readonly raw: string;
	/** Always false for remote specs */
	readonly isLocal: false;
	/** Normalized cache key (filesystem-safe) */
	readonly cacheKey: string;
	/** Normalized GitHub owner */
	readonly owner: string;
	/** Optional normalized git ref */
	readonly ref?: string;
	/** Normalized GitHub repo */
	readonly repo: string;
	/** Normalized safe subpath (empty string for repo root) */
	readonly subpath: string;
}

/** Detected plugin format after inspecting a directory. */
export type PluginFormat = "claude-code" | "tallow-extension" | "unknown";

/** Metadata from a Claude Code plugin.json */
export interface ClaudePluginManifest {
	readonly name: string;
	readonly description?: string;
	readonly version?: string;
	readonly author?: { name?: string; email?: string };
}

/** Metadata from extension capabilities in extension.json */
export interface TallowExtensionCapabilities {
	readonly commands?: readonly string[];
	readonly events?: readonly string[];
	readonly tools?: readonly string[];
}

/** Extension dependency/interaction metadata. */
export interface TallowExtensionRelationship {
	readonly kind?: string;
	readonly name: string;
	readonly reason?: string;
}

/** Execution surface declared by an extension manifest. */
export interface TallowExtensionPermissionSurface {
	readonly filesystem?: "none" | "read" | "write";
	readonly network?: boolean;
	readonly shell?: boolean;
	readonly subprocess?: boolean;
}

/** Metadata from a tallow extension.json */
export interface TallowExtensionManifest {
	readonly capabilities?: TallowExtensionCapabilities;
	readonly category?: string;
	readonly description?: string;
	readonly files?: readonly string[];
	readonly name: string;
	readonly permissionSurface?: TallowExtensionPermissionSurface;
	readonly relationships?: readonly TallowExtensionRelationship[];
	readonly tags?: readonly string[];
	readonly version?: string;
	readonly whenToUse?: readonly string[];
}

/** Result of resolving a plugin — path on disk + detected format. */
export interface ResolvedPlugin {
	readonly spec: PluginSpec;
	readonly path: string;
	readonly format: PluginFormat;
	readonly manifest: ClaudePluginManifest | TallowExtensionManifest | null;
	/** Whether the plugin was loaded from cache (false for local plugins) */
	readonly cached: boolean;
}

/** Resources extracted from a Claude Code plugin directory. */
export interface ClaudePluginResources {
	/** Paths to skill directories or SKILL.md files */
	readonly skillPaths: string[];
	/** Path to commands/ directory (if it exists) */
	readonly commandsDir?: string;
	/** Path to agents/ directory (if it exists) */
	readonly agentsDir?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Cache directory for remote plugins */
const CACHE_DIR = join(TALLOW_HOME, "cache", "plugins");

/** Metadata file stored alongside cached plugins */
const CACHE_META_FILE = ".tallow-plugin-cache.json";

/** TTL for mutable-ref cached plugins (e.g., @main) — 24 hours */
const MUTABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Spec Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a plugin spec string into a structured PluginSpec.
 *
 * Accepted formats:
 * - `github:owner/repo` — repo root, default branch
 * - `github:owner/repo@v1.0.0` — repo root, pinned version
 * - `github:owner/repo/plugins/foo@v1.0.0` — subdirectory, pinned version
 * - `./relative/path` or `/absolute/path` — local plugin
 * - `~/path` — local plugin with home expansion
 *
 * @param spec - Raw plugin spec string
 * @returns Parsed PluginSpec
 * @throws Error if the spec format is invalid
 */
export function parsePluginSpec(spec: string): PluginSpec {
	const trimmed = spec.trim();

	// Local paths: ./relative, /absolute, ~/home-relative
	if (
		trimmed.startsWith("./") ||
		trimmed.startsWith("../") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("~")
	) {
		const expanded = trimmed.startsWith("~") ? join(homedir(), trimmed.slice(1)) : resolve(trimmed);

		return {
			raw: spec,
			isLocal: true,
			localPath: expanded,
		};
	}

	// GitHub shorthand: github:owner/repo[/subpath][@ref]
	if (trimmed.startsWith("github:")) {
		const rest = trimmed.slice("github:".length);
		return parseGitHubSpec(spec, rest);
	}

	// Full GitHub URL: https://github.com/owner/repo[/tree/ref/subpath]
	// Uses URL parsing instead of regex to avoid ReDoS on untrusted input.
	try {
		const url = new URL(trimmed);
		if (url.hostname === "github.com") {
			const parts = url.pathname.split("/").filter(Boolean);
			if (parts.length >= 2) {
				const owner = parts[0];
				const repo = parts[1].replace(/\.git$/, "");
				let ref: string | undefined;
				let subpath = "";
				if (parts[2] === "tree" && parts.length >= 4) {
					ref = normalizePluginRef(parts[3], spec);
					subpath = normalizePluginSubpath(parts.slice(4).join("/"), spec);
				}
				return {
					raw: spec,
					isLocal: false,
					owner,
					repo,
					subpath,
					ref,
				};
			}
		}
	} catch {
		// Not a valid URL — fall through to the error below
	}

	throw new Error(
		`Invalid plugin spec: "${spec}". Expected github:owner/repo[@version], ` +
			`a GitHub URL, or a local path (./path, /path, ~/path).`
	);
}

/**
 * Parse the github:owner/repo[/subpath][@ref] portion.
 *
 * @param raw - Original full spec string
 * @param rest - The part after "github:"
 * @returns Parsed PluginSpec
 */
function parseGitHubSpec(raw: string, rest: string): PluginSpec {
	// Split off @ref from the end
	let ref: string | undefined;
	const atIdx = rest.lastIndexOf("@");
	let pathPart = rest;
	if (atIdx > 0) {
		ref = rest.slice(atIdx + 1);
		pathPart = rest.slice(0, atIdx);
	}

	const segments = pathPart.split("/").filter(Boolean);
	if (segments.length < 2) {
		throw new Error(
			`Invalid GitHub plugin spec: "${raw}". Expected github:owner/repo[/subpath][@version].`
		);
	}

	const [owner, repo, ...subpathParts] = segments;
	return {
		raw,
		isLocal: false,
		owner,
		repo,
		subpath: normalizePluginSubpath(subpathParts.join("/"), raw),
		ref: normalizePluginRef(ref, raw),
	};
}

/** Windows-style absolute path prefix (e.g. C:\\path). */
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Normalize and validate a remote plugin ref.
 *
 * Rejects:
 * - empty refs
 * - path separators (`/` or `\\`)
 * - traversal markers (`..`)
 * - absolute-path prefixes
 *
 * @param ref - Raw ref from plugin spec
 * @param specForError - Original spec string used for error context
 * @returns Normalized ref, or undefined when absent
 * @throws Error when the ref is malformed or unsafe
 */
export function normalizePluginRef(
	ref: string | undefined,
	specForError = "plugin spec"
): string | undefined {
	if (ref == null) {
		return undefined;
	}

	const trimmed = ref.trim();
	if (!trimmed) {
		throw new Error(`Invalid plugin ref in "${specForError}": ref cannot be empty.`);
	}

	const normalized = trimmed.replaceAll("\\", "/");
	if (normalized.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(trimmed)) {
		throw new Error(`Invalid plugin ref in "${specForError}": absolute refs are not allowed.`);
	}

	if (normalized.includes("/")) {
		throw new Error(`Invalid plugin ref in "${specForError}": path separators are not allowed.`);
	}

	if (normalized.includes("..")) {
		throw new Error(`Invalid plugin ref in "${specForError}": path traversal is not allowed.`);
	}

	return trimmed;
}

/**
 * Normalize and validate a remote plugin subpath.
 *
 * Rejects:
 * - absolute paths
 * - traversal segments (`..`) after normalization
 *
 * @param subpath - Raw subpath from plugin spec
 * @param specForError - Original spec string used for error context
 * @returns Normalized relative subpath (POSIX separators), or empty string
 * @throws Error when the subpath is absolute or attempts traversal
 */
export function normalizePluginSubpath(subpath: string, specForError = "plugin spec"): string {
	const trimmed = subpath.trim();
	if (!trimmed) return "";

	if (trimmed.startsWith("/") || trimmed.startsWith("\\") || WINDOWS_ABSOLUTE_PATH.test(trimmed)) {
		throw new Error(`Invalid plugin subpath in "${specForError}": absolute paths are not allowed.`);
	}

	const normalized = posix.normalize(trimmed.replaceAll("\\", "/"));
	if (normalized === "" || normalized === ".") return "";

	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error(`Invalid plugin subpath in "${specForError}": path traversal is not allowed.`);
	}

	const segments = normalized.split("/").filter(Boolean);
	if (segments.some((segment) => segment === "..")) {
		throw new Error(`Invalid plugin subpath in "${specForError}": path traversal is not allowed.`);
	}

	return segments.join("/");
}

/** Valid owner/repo token pattern used by github: specs. */
const SAFE_REMOTE_TOKEN = /^[A-Za-z0-9._-]+$/;

/** Input parts used to build a normalized plugin cache key. */
interface CacheKeyParts {
	readonly owner: string;
	readonly ref?: string;
	readonly repo: string;
	readonly subpath: string;
}

/**
 * Normalize and validate a GitHub owner/repo token.
 *
 * @param value - Token to validate
 * @param field - Human-readable field name for error messages
 * @param rawSpec - Original plugin spec string
 * @returns Normalized token
 * @throws Error if the token is missing or contains unsupported characters
 */
function normalizeRemoteToken(value: string | undefined, field: string, rawSpec: string): string {
	const normalized = (value ?? "").trim();
	if (!normalized) {
		throw new Error(`Invalid GitHub plugin spec: "${rawSpec}". Missing ${field}.`);
	}
	if (!SAFE_REMOTE_TOKEN.test(normalized)) {
		throw new Error(
			`Invalid GitHub plugin spec: "${rawSpec}". ${field} contains unsupported characters.`
		);
	}
	return normalized;
}

/**
 * Convert an arbitrary string into a filesystem-safe cache-key segment.
 *
 * @param value - Raw value to convert
 * @returns Cache-key-safe segment containing only `[A-Za-z0-9._-]` and `--`
 */
function toSafeCacheSegment(value: string): string {
	const normalized = value
		.trim()
		.replaceAll("\\", "/")
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			const safe = segment
				.normalize("NFKC")
				.replace(/[^A-Za-z0-9._-]+/g, "-")
				.replace(/^-+|-+$/g, "");
			return safe || "x";
		})
		.join("--");

	return normalized || "default";
}

/**
 * Build a deterministic, filesystem-safe cache key for a remote plugin.
 *
 * The key includes a human-readable slug and a short hash suffix so values
 * that normalize to the same slug still remain distinct.
 *
 * @param parts - Normalized cache-key parts
 * @returns Filesystem-safe cache key
 */
export function buildPluginCacheKey(parts: CacheKeyParts): string {
	const ownerSlug = toSafeCacheSegment(parts.owner);
	const repoSlug = toSafeCacheSegment(parts.repo);
	const subpathSlug = parts.subpath ? `--${toSafeCacheSegment(parts.subpath)}` : "";
	const refSlug = toSafeCacheSegment(parts.ref ?? "default");
	const canonical = JSON.stringify({
		owner: parts.owner,
		ref: parts.ref ?? "",
		repo: parts.repo,
		subpath: parts.subpath,
	});
	const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);

	return `${ownerSlug}--${repoSlug}${subpathSlug}@${refSlug}~${digest}`;
}

/**
 * Normalize and validate a parsed remote plugin spec.
 *
 * @param spec - Parsed plugin spec
 * @returns Normalized remote spec safe for fetch/cache operations
 * @throws Error if the spec is local or contains invalid remote fields
 */
export function normalizeRemotePluginSpec(spec: PluginSpec): NormalizedRemotePluginSpec {
	if (spec.isLocal) {
		throw new Error("Local plugins cannot be normalized as remote specs");
	}

	const owner = normalizeRemoteToken(spec.owner, "owner", spec.raw);
	const repo = normalizeRemoteToken(spec.repo, "repo", spec.raw);
	const subpath = normalizePluginSubpath(spec.subpath ?? "", spec.raw);
	const ref = normalizePluginRef(spec.ref, spec.raw);

	return {
		raw: spec.raw,
		isLocal: false,
		cacheKey: buildPluginCacheKey({ owner, repo, subpath, ref }),
		owner,
		repo,
		subpath,
		ref,
	};
}

/**
 * Check whether a target path is contained within a root path.
 *
 * @param rootPath - Canonical root path
 * @param targetPath - Candidate absolute path
 * @returns True when target is within root (or equal to root)
 */
function isPathContained(rootPath: string, targetPath: string): boolean {
	const rel = relative(rootPath, targetPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Assert that a path is contained within a trusted root.
 *
 * Performs lexical containment checks first, then canonical checks when both
 * paths exist. This catches symlink-based escapes while allowing checks for
 * paths that do not exist yet (e.g. future cache directories).
 *
 * @param rootPath - Trusted root directory
 * @param targetPath - Candidate path to validate
 * @param label - Human-readable label used in error messages
 * @returns Absolute validated target path
 * @throws Error when the target escapes the trusted root
 */
function assertPathContained(
	rootPath: string,
	targetPath: string,
	label: string,
	escapeMessage = `Invalid ${label}: resolved path escapes trusted root.`
): string {
	const absoluteRoot = resolve(rootPath);
	const absoluteTarget = resolve(targetPath);

	if (!isPathContained(absoluteRoot, absoluteTarget)) {
		throw new Error(escapeMessage);
	}

	if (!existsSync(absoluteRoot) || !existsSync(absoluteTarget)) {
		return absoluteTarget;
	}

	const canonicalRoot = realpathSync(absoluteRoot);
	const canonicalTarget = realpathSync(absoluteTarget);
	if (!isPathContained(canonicalRoot, canonicalTarget)) {
		throw new Error(escapeMessage);
	}

	return canonicalTarget;
}

/**
 * Resolve a plugin subpath against a clone root and enforce containment.
 *
 * Performs both lexical and canonical checks so symlink-based escapes are
 * rejected even when the joined path appears to be inside the repository.
 *
 * @param cloneRoot - Absolute path to the cloned repository root
 * @param subpath - Plugin subpath to resolve
 * @returns Canonical absolute path contained in cloneRoot
 * @throws Error when the resolved subpath escapes cloneRoot or is missing
 */
export function resolveContainedSubpath(cloneRoot: string, subpath: string): string {
	const canonicalRoot = realpathSync(cloneRoot);
	const normalizedSubpath = normalizePluginSubpath(subpath);
	const candidatePath = resolve(canonicalRoot, normalizedSubpath);
	const checkedPath = assertPathContained(
		canonicalRoot,
		candidatePath,
		"plugin subpath",
		"Invalid plugin subpath: resolved path escapes repository root."
	);

	if (!existsSync(checkedPath)) {
		throw new Error(`Plugin subpath "${normalizedSubpath}" not found in repository.`);
	}

	const canonicalCandidate = realpathSync(checkedPath);
	assertPathContained(
		canonicalRoot,
		canonicalCandidate,
		"plugin subpath",
		"Invalid plugin subpath: resolved path escapes repository root."
	);
	return canonicalCandidate;
}

// ─── Version Detection ──────────────────────────────────────────────────────

/** Semver tag pattern (with or without 'v' prefix) */
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/**
 * Check if a ref string looks like an immutable semver tag.
 *
 * @param ref - Version ref string (e.g., "v1.0.0", "main", "abc123")
 * @returns True if the ref appears to be a semver tag
 */
export function isImmutableRef(ref: string | undefined): boolean {
	if (!ref) return false;
	return SEMVER_PATTERN.test(ref);
}

// ─── Cache Management ────────────────────────────────────────────────────────

/** Metadata stored alongside a cached plugin. */
interface CacheMeta {
	/** Original spec string */
	spec: string;
	/** Resolved git commit SHA */
	commitSha?: string;
	/** When this cache entry was created */
	cachedAt: string;
	/** Whether this is an immutable (semver) cache entry */
	immutable: boolean;
}

/**
 * Get the cache directory path for a given plugin spec.
 *
 * @param spec - Parsed or normalized remote plugin spec
 * @returns Absolute path to the cache directory
 */
export function getCachePath(spec: PluginSpec | NormalizedRemotePluginSpec): string {
	if (spec.isLocal) {
		throw new Error("Local plugins are not cached");
	}
	const normalized = "cacheKey" in spec ? spec : normalizeRemotePluginSpec(spec);
	const candidatePath = join(CACHE_DIR, normalized.cacheKey);
	return assertPathContained(CACHE_DIR, candidatePath, "plugin cache path");
}

/**
 * Check if a cached plugin is still valid.
 *
 * - Immutable refs (semver tags): valid forever once cached
 * - Mutable refs (branches, no ref): valid for MUTABLE_CACHE_TTL_MS
 *
 * @param cachePath - Path to the cached plugin directory
 * @param _spec - Parsed plugin spec (reserved for future per-spec invalidation)
 * @returns True if the cache is valid and can be used
 */
export function isCacheValid(cachePath: string, _spec: PluginSpec): boolean {
	const metaPath = join(cachePath, CACHE_META_FILE);
	if (!existsSync(metaPath)) return false;

	try {
		const meta: CacheMeta = JSON.parse(readFileSync(metaPath, "utf-8"));

		// Immutable (semver) — valid forever
		if (meta.immutable) return true;

		// Mutable — check TTL
		const cachedAt = new Date(meta.cachedAt).getTime();
		return Date.now() - cachedAt < MUTABLE_CACHE_TTL_MS;
	} catch {
		return false;
	}
}

/**
 * Write cache metadata for a fetched plugin.
 *
 * @param cachePath - Path to the cached plugin directory
 * @param spec - Original plugin spec
 * @param commitSha - Git commit SHA that was fetched
 */
function writeCacheMeta(cachePath: string, spec: PluginSpec, commitSha?: string): void {
	const meta: CacheMeta = {
		spec: spec.raw,
		commitSha,
		cachedAt: new Date().toISOString(),
		immutable: isImmutableRef(spec.ref),
	};
	writeFileSync(join(cachePath, CACHE_META_FILE), JSON.stringify(meta, null, "\t"));
}

// ─── Fetching ────────────────────────────────────────────────────────────────

/**
 * Fetch a remote plugin from GitHub into the cache directory.
 *
 * Uses `git clone --depth 1` for efficiency. If a subpath is specified,
 * the full repo is cloned then only the subpath is preserved.
 *
 * @param spec - Normalized remote plugin spec
 * @param cachePath - Target cache directory
 * @throws Error if git clone fails
 */
export function fetchPlugin(spec: NormalizedRemotePluginSpec, cachePath: string): void {
	mkdirSync(CACHE_DIR, { recursive: true });
	const safeCachePath = assertPathContained(CACHE_DIR, cachePath, "plugin cache path");
	const repoUrl = `https://github.com/${spec.owner}/${spec.repo}.git`;

	// Clean up any partial previous fetch
	if (existsSync(safeCachePath)) {
		rmSync(safeCachePath, { recursive: true, force: true });
	}

	mkdirSync(safeCachePath, { recursive: true });

	// Clone into a temp dir, then extract the subpath
	const tmpClone = join(dirname(safeCachePath), `.tmp-clone-${Date.now()}`);

	try {
		const cloneArgs = ["clone", "--depth", "1"];
		if (spec.ref) {
			cloneArgs.push("--branch", spec.ref);
		}
		cloneArgs.push(repoUrl, tmpClone);

		execFileSync("git", cloneArgs, {
			stdio: "pipe",
			timeout: 60_000,
		});

		// Get the commit SHA for cache metadata
		let commitSha: string | undefined;
		try {
			commitSha = execFileSync("git", ["-C", tmpClone, "rev-parse", "HEAD"], {
				encoding: "utf-8",
				stdio: "pipe",
			}).trim();
		} catch {
			// Non-fatal — we just won't have the SHA in metadata
		}

		// If subpath, move only that directory to the cache location
		if (spec.subpath) {
			let subDir: string;
			try {
				subDir = resolveContainedSubpath(tmpClone, spec.subpath);
			} catch (error) {
				if (error instanceof Error && error.message.includes("not found in repository")) {
					throw new Error(
						`Subpath "${spec.subpath}" not found in ${spec.owner}/${spec.repo}. ` +
							`Available top-level entries: ${readdirSync(tmpClone)
								.filter((e) => !e.startsWith("."))
								.join(", ")}`
					);
				}
				throw error;
			}

			// Remove the target and rename the validated subdir into place
			rmSync(safeCachePath, { recursive: true, force: true });
			renameSync(subDir, safeCachePath);
		} else {
			// No subpath — move entire clone (minus .git) to cache
			rmSync(join(tmpClone, ".git"), { recursive: true, force: true });
			rmSync(safeCachePath, { recursive: true, force: true });
			renameSync(tmpClone, safeCachePath);
		}

		writeCacheMeta(safeCachePath, spec, commitSha);
	} finally {
		// Clean up temp clone dir if it still exists
		if (existsSync(tmpClone)) {
			rmSync(tmpClone, { recursive: true, force: true });
		}
	}
}

// ─── Format Detection ────────────────────────────────────────────────────────

/**
 * Detect the plugin format from a directory on disk.
 *
 * @param pluginPath - Absolute path to the plugin directory
 * @returns Detected format: "claude-code", "tallow-extension", or "unknown"
 */
export function detectPluginFormat(pluginPath: string): PluginFormat {
	// Claude Code plugin: .claude-plugin/plugin.json
	if (existsSync(join(pluginPath, ".claude-plugin", "plugin.json"))) {
		return "claude-code";
	}

	// Tallow extension: extension.json (with or without compiled index)
	if (existsSync(join(pluginPath, "extension.json"))) {
		return "tallow-extension";
	}

	return "unknown";
}

type JsonRecord = Record<string, unknown>;

/**
 * Check whether a value is a plain JSON object.
 *
 * @param value - Value to test
 * @returns True when value is a non-array object
 */
function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an optional array of non-empty strings.
 *
 * @param value - Candidate array value
 * @returns Normalized string array or undefined
 */
function parseStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const parsed = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);

	return parsed.length > 0 ? parsed : undefined;
}

/**
 * Parse extension relationship metadata.
 *
 * @param value - Candidate relationships value
 * @returns Parsed relationships array or undefined
 */
function parseRelationships(value: unknown): readonly TallowExtensionRelationship[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const parsed = value
		.map((item) => {
			if (typeof item === "string") {
				const name = item.trim();
				return name ? { name } : null;
			}
			if (!isJsonRecord(item) || typeof item.name !== "string") return null;

			const name = item.name.trim();
			if (!name) return null;

			const kind = typeof item.kind === "string" ? item.kind : undefined;
			const reason = typeof item.reason === "string" ? item.reason : undefined;

			return {
				kind,
				name,
				reason,
			};
		})
		.filter((item): item is TallowExtensionRelationship => item !== null);

	return parsed.length > 0 ? parsed : undefined;
}

/**
 * Parse capability metadata from an extension manifest.
 *
 * @param root - Parsed manifest object
 * @returns Parsed capabilities object or undefined
 */
function parseCapabilities(root: JsonRecord): TallowExtensionCapabilities | undefined {
	const capabilitiesRoot = isJsonRecord(root.capabilities) ? root.capabilities : root;
	const commands = parseStringArray(capabilitiesRoot.commands);
	const events = parseStringArray(capabilitiesRoot.events);
	const tools = parseStringArray(capabilitiesRoot.tools);

	if (!commands && !events && !tools) return undefined;

	return {
		commands,
		events,
		tools,
	};
}

/**
 * Parse permission surface metadata from an extension manifest.
 *
 * @param value - Candidate permissionSurface value
 * @returns Parsed permission surface object or undefined
 */
function parsePermissionSurface(value: unknown): TallowExtensionPermissionSurface | undefined {
	if (!isJsonRecord(value)) return undefined;

	const filesystem =
		value.filesystem === "none" || value.filesystem === "read" || value.filesystem === "write"
			? value.filesystem
			: undefined;
	const network = typeof value.network === "boolean" ? value.network : undefined;
	const shell = typeof value.shell === "boolean" ? value.shell : undefined;
	const subprocess = typeof value.subprocess === "boolean" ? value.subprocess : undefined;

	if (
		filesystem === undefined &&
		network === undefined &&
		shell === undefined &&
		subprocess === undefined
	) {
		return undefined;
	}

	return {
		filesystem,
		network,
		shell,
		subprocess,
	};
}

/**
 * Parse whenToUse metadata from an extension manifest.
 *
 * @param value - Candidate whenToUse value
 * @returns Parsed whenToUse array or undefined
 */
function parseWhenToUse(value: unknown): readonly string[] | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? [trimmed] : undefined;
	}
	return parseStringArray(value);
}

/**
 * Parse a Claude Code plugin manifest.
 *
 * @param value - Parsed JSON value
 * @returns Claude manifest or null when invalid
 */
function parseClaudePluginManifest(value: unknown): ClaudePluginManifest | null {
	if (!isJsonRecord(value) || typeof value.name !== "string") return null;

	return {
		author: isJsonRecord(value.author)
			? {
					email: typeof value.author.email === "string" ? value.author.email : undefined,
					name: typeof value.author.name === "string" ? value.author.name : undefined,
				}
			: undefined,
		description: typeof value.description === "string" ? value.description : undefined,
		name: value.name,
		version: typeof value.version === "string" ? value.version : undefined,
	};
}

/**
 * Parse a tallow extension manifest.
 *
 * @param value - Parsed JSON value
 * @returns Tallow extension manifest or null when invalid
 */
function parseTallowExtensionManifest(value: unknown): TallowExtensionManifest | null {
	if (!isJsonRecord(value) || typeof value.name !== "string") return null;

	const name = value.name.trim();
	if (!name) return null;

	return {
		capabilities: parseCapabilities(value),
		category: typeof value.category === "string" ? value.category : undefined,
		description: typeof value.description === "string" ? value.description : undefined,
		files: parseStringArray(value.files),
		name,
		permissionSurface: parsePermissionSurface(value.permissionSurface),
		relationships: parseRelationships(value.relationships),
		tags: parseStringArray(value.tags),
		version: typeof value.version === "string" ? value.version : undefined,
		whenToUse: parseWhenToUse(value.whenToUse),
	};
}

/**
 * Read the manifest from a plugin directory.
 *
 * @param pluginPath - Absolute path to the plugin directory
 * @param format - Detected plugin format
 * @returns Parsed manifest, or null if unreadable
 */
export function readPluginManifest(
	pluginPath: string,
	format: PluginFormat
): ClaudePluginManifest | TallowExtensionManifest | null {
	try {
		switch (format) {
			case "claude-code": {
				const content = readFileSync(join(pluginPath, ".claude-plugin", "plugin.json"), "utf-8");
				return parseClaudePluginManifest(JSON.parse(content));
			}
			case "tallow-extension": {
				const content = readFileSync(join(pluginPath, "extension.json"), "utf-8");
				return parseTallowExtensionManifest(JSON.parse(content));
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}

// ─── Claude Code Plugin Resource Extraction ──────────────────────────────────

/**
 * Extract resource paths from a Claude Code plugin directory.
 *
 * Scans for skills/, commands/, and agents/ directories and returns
 * paths that can be fed into tallow's resource loader.
 *
 * @param pluginPath - Absolute path to the Claude Code plugin directory
 * @returns Extracted resource paths
 */
export function extractClaudePluginResources(pluginPath: string): ClaudePluginResources {
	const skillPaths: string[] = [];

	// Skills: each subdirectory of skills/ with a SKILL.md
	const skillsDir = join(pluginPath, "skills");
	if (existsSync(skillsDir)) {
		try {
			for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
				if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
				const skillMd = join(skillsDir, entry.name, "SKILL.md");
				if (existsSync(skillMd)) {
					skillPaths.push(skillMd);
				} else {
					// Fallback to directory path
					skillPaths.push(join(skillsDir, entry.name));
				}
			}
		} catch {
			// Unreadable — skip
		}
	}

	const commandsDir = join(pluginPath, "commands");
	const agentsDir = join(pluginPath, "agents");

	return {
		skillPaths,
		commandsDir: existsSync(commandsDir) ? commandsDir : undefined,
		agentsDir: existsSync(agentsDir) ? agentsDir : undefined,
	};
}

// ─── Main Resolver ───────────────────────────────────────────────────────────

/**
 * Resolve a single plugin spec to a directory on disk.
 *
 * For local plugins: validates the path exists, detects format.
 * For remote plugins: checks cache, fetches if needed, detects format.
 *
 * @param spec - Raw plugin spec string or pre-parsed PluginSpec
 * @returns Resolved plugin with path, format, and manifest
 * @throws Error if the plugin cannot be resolved
 */
export function resolvePlugin(spec: string | PluginSpec): ResolvedPlugin {
	const parsed = typeof spec === "string" ? parsePluginSpec(spec) : spec;

	if (parsed.isLocal) {
		return resolveLocalPlugin(parsed);
	}

	return resolveRemotePlugin(parsed);
}

/**
 * Resolve a local plugin — just validate and detect format.
 *
 * @param spec - Parsed local plugin spec
 * @returns Resolved plugin
 */
function resolveLocalPlugin(spec: PluginSpec): ResolvedPlugin {
	const pluginPath = spec.localPath ?? "";
	if (!pluginPath) {
		throw new Error("Local plugin spec is missing a path");
	}

	if (!existsSync(pluginPath)) {
		throw new Error(`Local plugin not found: ${pluginPath}`);
	}

	if (!statSync(pluginPath).isDirectory()) {
		throw new Error(`Local plugin path is not a directory: ${pluginPath}`);
	}

	const format = detectPluginFormat(pluginPath);
	const manifest = readPluginManifest(pluginPath, format);

	return { spec, path: pluginPath, format, manifest, cached: false };
}

/**
 * Resolve a remote plugin — check cache, fetch if needed.
 *
 * @param spec - Parsed remote plugin spec
 * @returns Resolved plugin
 */
function resolveRemotePlugin(spec: PluginSpec): ResolvedPlugin {
	const normalizedSpec = normalizeRemotePluginSpec(spec);
	const cachePath = getCachePath(normalizedSpec);

	if (!isCacheValid(cachePath, spec)) {
		fetchPlugin(normalizedSpec, cachePath);
	}

	const format = detectPluginFormat(cachePath);
	const manifest = readPluginManifest(cachePath, format);

	return { spec, path: cachePath, format, manifest, cached: true };
}

// ─── Batch Resolution ────────────────────────────────────────────────────────

/** Result of resolving all plugins, including any errors. */
export interface PluginResolutionResult {
	/** Successfully resolved plugins */
	readonly resolved: ResolvedPlugin[];
	/** Plugins that failed to resolve (with error messages) */
	readonly errors: Array<{ spec: string; error: string }>;
}

/**
 * Resolve an array of plugin specs.
 *
 * Continues past individual failures so one bad spec doesn't block all plugins.
 *
 * @param specs - Array of raw plugin spec strings
 * @returns Resolved plugins and any errors encountered
 */
export function resolvePlugins(specs: string[]): PluginResolutionResult {
	const resolved: ResolvedPlugin[] = [];
	const errors: Array<{ spec: string; error: string }> = [];

	for (const spec of specs) {
		try {
			resolved.push(resolvePlugin(spec));
		} catch (err) {
			errors.push({
				spec,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { resolved, errors };
}

// ─── Cache Utilities ─────────────────────────────────────────────────────────

/**
 * Force-refresh a cached plugin (re-fetch from remote).
 *
 * @param spec - Raw plugin spec string
 * @returns Resolved plugin after refresh
 * @throws Error if the spec is local or fetch fails
 */
export function refreshPlugin(spec: string): ResolvedPlugin {
	const parsed = parsePluginSpec(spec);

	if (parsed.isLocal) {
		throw new Error("Cannot refresh a local plugin — local plugins are never cached.");
	}

	const normalizedSpec = normalizeRemotePluginSpec(parsed);
	const cachePath = getCachePath(normalizedSpec);

	// Force re-fetch by removing existing cache
	if (existsSync(cachePath)) {
		rmSync(cachePath, { recursive: true, force: true });
	}

	fetchPlugin(normalizedSpec, cachePath);

	const format = detectPluginFormat(cachePath);
	const manifest = readPluginManifest(cachePath, format);

	return { spec: parsed, path: cachePath, format, manifest, cached: true };
}

/**
 * List all cached plugins.
 *
 * @returns Array of cache entries with metadata
 */
export function listCachedPlugins(): Array<{
	name: string;
	path: string;
	meta: CacheMeta | null;
}> {
	if (!existsSync(CACHE_DIR)) return [];

	const entries: Array<{ name: string; path: string; meta: CacheMeta | null }> = [];

	try {
		for (const entry of readdirSync(CACHE_DIR, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

			const entryPath = join(CACHE_DIR, entry.name);
			const metaPath = join(entryPath, CACHE_META_FILE);

			let meta: CacheMeta | null = null;
			try {
				meta = JSON.parse(readFileSync(metaPath, "utf-8"));
			} catch {
				// No metadata — still list it
			}

			entries.push({ name: entry.name, path: entryPath, meta });
		}
	} catch {
		// Cache dir unreadable
	}

	return entries;
}

/**
 * Clear all cached plugins or a specific one.
 *
 * @param spec - Optional spec to clear a specific cache entry. Omit to clear all.
 */
export function clearPluginCache(spec?: string): void {
	if (spec) {
		const parsed = parsePluginSpec(spec);
		if (parsed.isLocal) return;

		const cachePath = getCachePath(parsed);
		if (existsSync(cachePath)) {
			rmSync(cachePath, { recursive: true, force: true });
		}
	} else {
		if (existsSync(CACHE_DIR)) {
			rmSync(CACHE_DIR, { recursive: true, force: true });
		}
	}
}
