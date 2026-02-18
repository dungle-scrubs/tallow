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
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** Detected plugin format after inspecting a directory. */
export type PluginFormat = "claude-code" | "tallow-extension" | "unknown";

/** Metadata from a Claude Code plugin.json */
export interface ClaudePluginManifest {
	readonly name: string;
	readonly description?: string;
	readonly version?: string;
	readonly author?: { name?: string; email?: string };
}

/** Metadata from a tallow extension.json */
export interface TallowExtensionManifest {
	readonly name: string;
	readonly description?: string;
	readonly version?: string;
	readonly category?: string;
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
	const ghMatch = trimmed.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?(?:\/tree\/([^/]+)\/?(.*))?$/
	);
	if (ghMatch) {
		const [, owner, repo, ref, subpath] = ghMatch;
		return {
			raw: spec,
			isLocal: false,
			owner,
			repo,
			subpath: subpath || "",
			ref: ref || undefined,
		};
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
		subpath: subpathParts.join("/"),
		ref,
	};
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
 * @param spec - Parsed plugin spec
 * @returns Absolute path to the cache directory
 */
export function getCachePath(spec: PluginSpec): string {
	if (spec.isLocal) {
		throw new Error("Local plugins are not cached");
	}

	const repoSlug = `${spec.owner}--${spec.repo}`;
	const subSlug = spec.subpath ? `--${spec.subpath.replace(/\//g, "--")}` : "";
	const refSlug = spec.ref ? `@${spec.ref}` : "@default";

	return join(CACHE_DIR, `${repoSlug}${subSlug}${refSlug}`);
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
 * @param spec - Parsed plugin spec (must be remote)
 * @param cachePath - Target cache directory
 * @throws Error if git clone fails
 */
export function fetchPlugin(spec: PluginSpec, cachePath: string): void {
	if (spec.isLocal) {
		throw new Error("Cannot fetch a local plugin");
	}

	const repoUrl = `https://github.com/${spec.owner}/${spec.repo}.git`;

	// Clean up any partial previous fetch
	if (existsSync(cachePath)) {
		rmSync(cachePath, { recursive: true, force: true });
	}

	mkdirSync(cachePath, { recursive: true });

	// Clone into a temp dir, then extract the subpath
	const tmpClone = join(dirname(cachePath), `.tmp-clone-${Date.now()}`);

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
			const subDir = join(tmpClone, spec.subpath);
			if (!existsSync(subDir)) {
				throw new Error(
					`Subpath "${spec.subpath}" not found in ${spec.owner}/${spec.repo}. ` +
						`Available top-level entries: ${readdirSync(tmpClone)
							.filter((e) => !e.startsWith("."))
							.join(", ")}`
				);
			}

			// Remove the target and rename the subdir into place
			rmSync(cachePath, { recursive: true, force: true });
			execFileSync("mv", [subDir, cachePath], { stdio: "pipe" });
		} else {
			// No subpath — move entire clone (minus .git) to cache
			rmSync(join(tmpClone, ".git"), { recursive: true, force: true });
			rmSync(cachePath, { recursive: true, force: true });
			execFileSync("mv", [tmpClone, cachePath], { stdio: "pipe" });
		}

		writeCacheMeta(cachePath, spec, commitSha);
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
				return JSON.parse(content) as ClaudePluginManifest;
			}
			case "tallow-extension": {
				const content = readFileSync(join(pluginPath, "extension.json"), "utf-8");
				return JSON.parse(content) as TallowExtensionManifest;
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
	const cachePath = getCachePath(spec);

	if (!isCacheValid(cachePath, spec)) {
		fetchPlugin(spec, cachePath);
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

	const cachePath = getCachePath(parsed);

	// Force re-fetch by removing existing cache
	if (existsSync(cachePath)) {
		rmSync(cachePath, { recursive: true, force: true });
	}

	fetchPlugin(parsed, cachePath);

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
