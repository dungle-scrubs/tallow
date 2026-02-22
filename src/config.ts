import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimePathProvider, type RuntimePathProvider } from "./runtime-path-provider.js";

// ─── Identity ────────────────────────────────────────────────────────────────

export const APP_NAME = "tallow";
export const TALLOW_VERSION = "0.8.7"; // x-release-please-version
export const CONFIG_DIR = ".tallow";

// ─── Paths ───────────────────────────────────────────────────────────────────

/** ~/.tallow (or override from ~/.config/tallow-work-dirs) — all user config, sessions, auth, extensions */
export const TALLOW_HOME = resolveTallowHome();

/**
 * Resolve tallow home dynamically for runtime-sensitive consumers.
 *
 * Some modules are imported before tests/embedded callers set env overrides.
 * This accessor lets call sites re-read the current `TALLOW_HOME` env var
 * without discarding the default module-level resolution behavior.
 *
 * @returns Current tallow home path
 */
export function getRuntimeTallowHome(): string {
	return process.env.TALLOW_HOME || TALLOW_HOME;
}

/** Default runtime path provider bound to runtime home lookups. */
const defaultRuntimePathProvider = createRuntimePathProvider(() => getRuntimeTallowHome());

/** Optional runtime path provider override for tests and embedded SDK hosts. */
let runtimePathProviderOverride: RuntimePathProvider | null = null;

/**
 * Resolve the active runtime path provider.
 *
 * @returns Runtime path provider for home-scoped directories/files
 */
export function getRuntimePathProvider(): RuntimePathProvider {
	return runtimePathProviderOverride ?? defaultRuntimePathProvider;
}

/**
 * Override the runtime path provider for tests.
 *
 * @param provider - Optional provider override (reset when omitted)
 * @returns Nothing
 */
export function setRuntimePathProviderForTests(provider?: RuntimePathProvider): void {
	runtimePathProviderOverride = provider ?? null;
}

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

/** Directory for trust metadata (per-project trust entries). */
export const TRUST_DIR = join(TALLOW_HOME, "trust");

/** Path to the project trust store (~/.tallow/trust/projects.json). */
export const PROJECT_TRUST_STORE_PATH = join(TRUST_DIR, "projects.json");

// ─── Demo Mode ───────────────────────────────────────────────────────────────

/**
 * Check if demo mode is enabled via IS_DEMO or TALLOW_DEMO env var.
 * Demo mode sanitizes sensitive data (paths, session IDs) in UI output
 * for screen recordings, live demos, and streaming.
 *
 * @returns True if demo mode is active
 */
export function isDemoMode(): boolean {
	return process.env.IS_DEMO === "1" || process.env.TALLOW_DEMO === "1";
}

/**
 * Sanitize a file path by replacing the current user's OS username with "demo".
 * Returns the path unchanged when demo mode is off or the username can't be detected.
 *
 * @param path - File path to sanitize
 * @returns Sanitized path with username replaced, or original if not in demo mode
 */
export function sanitizePath(path: string): string {
	if (!isDemoMode()) return path;
	const user = process.env.USER || process.env.USERNAME;
	if (!user) return path;
	// Replace /username/ segments and trailing /username
	return path.replaceAll(`/${user}/`, "/demo/").replaceAll(`/${user}`, "/demo");
}

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
 * Load plain env vars from .env (sync).
 *
 * Plain values are set immediately. Op:// references are left unresolved
 * for {@link resolveOpSecrets} to handle asynchronously at session start.
 */
function loadSecrets(): void {
	const envPath = join(TALLOW_HOME, ".env");
	let content: string;
	try {
		content = readFileSync(envPath, "utf-8");
	} catch {
		return;
	}

	const { plain } = parseEnvEntries(content);

	for (const { key, value } of plain) {
		if (!process.env[key]) process.env[key] = value;
	}
}

/**
 * Resolve any unresolved op:// references from .env in parallel.
 *
 * Call from an async context (e.g., createTallowSession) after bootstrap().
 * Skips secrets already in process.env (from inherited environment).
 * Resolved values are kept in process.env only — never written to disk.
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

	// Resolve all pending secrets in parallel
	await Promise.allSettled(
		unresolved.map(async ({ key, ref }) => {
			const value = await resolveSecret(ref);
			if (value) process.env[key] = value;
		})
	);
}
