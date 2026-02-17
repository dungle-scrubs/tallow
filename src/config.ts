import { execFile } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Identity ────────────────────────────────────────────────────────────────

export const APP_NAME = "tallow";
export const TALLOW_VERSION = "0.7.5"; // x-release-please-version
export const CONFIG_DIR = ".tallow";

// ─── Paths ───────────────────────────────────────────────────────────────────

/** ~/.tallow (or override from ~/.config/tallow-work-dirs) — all user config, sessions, auth, extensions */
export const TALLOW_HOME = resolveTallowHome();

/**
 * Resolve TALLOW_HOME from ~/.config/tallow-work-dirs.
 *
 * File format (one mapping per line, comments start with #):
 *   /path/to/project:/path/to/config-dir
 *
 * When cwd is inside a mapped directory, that config dir is used.
 * Falls back to ~/.tallow if no match or the file doesn't exist.
 *
 * @returns Resolved tallow home directory path
 */
function resolveTallowHome(): string {
	// Env override for CI, containers, and test isolation
	if (process.env.TALLOW_HOME) return process.env.TALLOW_HOME;

	const defaultHome = join(homedir(), CONFIG_DIR);
	const workDirsPath = join(homedir(), ".config", "tallow-work-dirs");
	const cwd = process.cwd();

	try {
		const content = readFileSync(workDirsPath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const colonIdx = trimmed.indexOf(":");
			if (colonIdx === -1) continue;
			const dir = trimmed.slice(0, colonIdx);
			const configDir = trimmed.slice(colonIdx + 1);
			if (dir && configDir && (cwd === dir || cwd.startsWith(`${dir}/`))) {
				return configDir;
			}
		}
	} catch {
		// File doesn't exist or isn't readable — use default
	}

	return defaultHome;
}

/** Where bundled resources live (the package root) */
const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = dirname(__filename_);
export const PACKAGE_DIR = resolve(__dirname_, "..");

/** Bundled resource paths (shipped with the npm package) */
export const BUNDLED = {
	extensions: join(PACKAGE_DIR, "extensions"),
	skills: join(PACKAGE_DIR, "skills"),
	themes: join(PACKAGE_DIR, "themes"),
} as const;

/** Templates copied to ~/.tallow/ on install — user owns these files */
export const TEMPLATES = {
	agents: join(PACKAGE_DIR, "templates", "agents"),
	commands: join(PACKAGE_DIR, "templates", "commands"),
} as const;

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Env vars must be set at module scope — NOT inside a function.
 *
 * ESM hoists all `import` statements: every imported module is evaluated
 * before the importing module's body runs.  In cli.ts the layout is:
 *
 *   import { bootstrap } from "./config.js";   // ① evaluated first
 *   bootstrap();                                // ③ runs AFTER all imports
 *   import { … } from "pi-coding-agent";       // ② evaluated second
 *
 * Pi's config.js is evaluated at step ②.  It reads PI_PACKAGE_DIR to
 * locate its package.json and derives APP_NAME / ENV_AGENT_DIR from it.
 * If these env vars are only set inside bootstrap() (step ③), Pi has
 * already resolved to APP_NAME="pi" and reads ~/.pi/agent/ instead of
 * ~/.tallow/.  Setting them here — at the module's top level — ensures
 * they exist before any Pi code runs.
 */
process.env.TALLOW_CODING_AGENT_DIR = TALLOW_HOME;
process.env.PI_PACKAGE_DIR = PACKAGE_DIR;
process.env.TALLOW_PACKAGE_DIR = PACKAGE_DIR;
process.env.PI_SKIP_VERSION_CHECK = "1";

/**
 * Non-env bootstrap tasks that are safe to run after imports.
 */
export function bootstrap(): void {
	process.title = APP_NAME;
	loadSecrets();
}

// ─── Secret Loading ──────────────────────────────────────────────────────────

/** Cache TTL for resolved op:// secrets. */
const SECRETS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Parsed op:// reference from .env. */
interface OpRef {
	key: string;
	ref: string;
}

/**
 * Parse .env content into plain key=value pairs and op:// references.
 *
 * @param content - Raw .env file content
 * @returns Separated plain values and op:// references
 */
function parseEnvEntries(content: string): {
	plain: Array<{ key: string; value: string }>;
	opRefs: OpRef[];
} {
	const plain: Array<{ key: string; value: string }> = [];
	const opRefs: OpRef[] = [];

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;

		const key = trimmed.slice(0, eqIdx).trim();
		const raw = trimmed.slice(eqIdx + 1).trim();
		if (!key || !raw) continue;

		if (raw.startsWith("op://")) {
			opRefs.push({ key, ref: raw });
		} else {
			plain.push({ key, value: raw });
		}
	}

	return { plain, opRefs };
}

/**
 * Try loading op:// secrets from the local cache file.
 * Cache is invalidated when .env is newer than the cache or TTL expires.
 *
 * @param opRefs - Op references that need values
 */
function loadSecretsFromCache(opRefs: OpRef[]): void {
	const envPath = join(TALLOW_HOME, ".env");
	const cachePath = join(TALLOW_HOME, ".env.cache");

	try {
		const cacheStat = statSync(cachePath);
		if (Date.now() - cacheStat.mtimeMs > SECRETS_CACHE_TTL_MS) return;

		const envStat = statSync(envPath);
		if (envStat.mtimeMs > cacheStat.mtimeMs) return;

		const cache: Record<string, string> = JSON.parse(readFileSync(cachePath, "utf-8"));
		for (const { key } of opRefs) {
			if (!process.env[key] && cache[key]) {
				process.env[key] = cache[key];
			}
		}
	} catch {
		// Cache missing, corrupt, or unreadable — skip
	}
}

/**
 * Resolve a single op:// reference via opchain.
 *
 * @param ref - The op:// URI to resolve
 * @returns The resolved secret value, or null on failure
 */
function resolveSecret(ref: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"opchain",
			["--read", "op", "read", ref],
			{ encoding: "utf-8", timeout: 5000 },
			(error, stdout) => {
				if (error) resolve(null);
				else resolve((stdout as string).trim() || null);
			}
		);
	});
}

/**
 * Load plain env vars and try cache for op:// references (sync).
 *
 * Plain values are set immediately. Op:// references are loaded from cache
 * if fresh; otherwise left unresolved for {@link resolveOpSecrets} to handle.
 */
function loadSecrets(): void {
	const envPath = join(TALLOW_HOME, ".env");
	let content: string;
	try {
		content = readFileSync(envPath, "utf-8");
	} catch {
		return;
	}

	const { plain, opRefs } = parseEnvEntries(content);

	for (const { key, value } of plain) {
		if (!process.env[key]) process.env[key] = value;
	}

	if (opRefs.length > 0) {
		loadSecretsFromCache(opRefs);
	}
}

/**
 * Resolve any unresolved op:// references from .env in parallel.
 *
 * Call from an async context (e.g., createTallowSession) after bootstrap().
 * Skips secrets already in process.env (from cache or inherited environment).
 * Writes results to ~/.tallow/.env.cache for instant loading on next startup.
 */
export async function resolveOpSecrets(): Promise<void> {
	const envPath = join(TALLOW_HOME, ".env");
	let content: string;
	try {
		content = readFileSync(envPath, "utf-8");
	} catch {
		return;
	}

	const { opRefs } = parseEnvEntries(content);
	if (opRefs.length === 0) return;

	const unresolved = opRefs.filter((r) => !process.env[r.key]);
	if (unresolved.length === 0) return;

	// Resolve all pending secrets in parallel (~2.4s instead of N × 2.4s)
	await Promise.allSettled(
		unresolved.map(async ({ key, ref }) => {
			const value = await resolveSecret(ref);
			if (value) process.env[key] = value;
		})
	);

	// Write cache so next startup loads instantly
	const cachePath = join(TALLOW_HOME, ".env.cache");
	const cached: Record<string, string> = {};
	for (const { key } of opRefs) {
		const val = process.env[key];
		if (val) cached[key] = val;
	}
	if (Object.keys(cached).length > 0) {
		try {
			writeFileSync(cachePath, JSON.stringify(cached), { mode: 0o600 });
		} catch {
			// Non-fatal — just means slower next startup
		}
	}
}
