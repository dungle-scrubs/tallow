import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Identity ────────────────────────────────────────────────────────────────

export const APP_NAME = "tallow";
export const TALLOW_VERSION = "0.1.0";
export const CONFIG_DIR = ".tallow";

// ─── Paths ───────────────────────────────────────────────────────────────────

/** ~/.tallow — all user config, sessions, auth, extensions */
export const TALLOW_HOME = join(homedir(), CONFIG_DIR);

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
}
