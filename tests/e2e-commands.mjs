#!/usr/bin/env node

/**
 * E2E test: verify all custom slash commands register successfully.
 *
 * Loads all bundled extensions via the SDK (no LLM calls) and checks
 * that each expected command is present in the runtime.
 *
 * Usage:
 *   node tests/e2e-commands.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";

// Run from a clean temp dir to avoid project-local .tallow/ conflicts
const _originalCwd = process.cwd();
const testCwd = mkdtempSync(`${os.tmpdir()}/tallow-e2e-`);
process.chdir(testCwd);

import { join, resolve } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

// ── Expected commands ────────────────────────────────────────
// Each entry is a slash command that MUST be registered by our extensions.
// Update this list when adding or removing extension commands.

const EXPECTED_COMMANDS = [
	"bg",
	"cd",
	"cheatsheet",
	"clear",
	"context",
	"init",
	"keybindings",
	"keymap",
	"keys",
	"mcp",
	"output-style",
	"plan-mode",
	"prompt",
	"show-system-prompt",
	"tasks",
	"theme",
	"todos",
];

// Agent commands registered by agent-commands-tool extension from bundled agents/
const EXPECTED_AGENT_COMMANDS = [
	"agent:architect",
	"agent:debug",
	"agent:planner",
	"agent:refactor",
	"agent:reviewer",
	"agent:scout",
	"agent:worker",
];

// ── Helpers ──────────────────────────────────────────────────

const results = [];

function check(name, passed, detail) {
	results.push({ name, passed, detail });
	const icon = passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
	let line = `  ${icon} ${name}`;
	if (!passed && detail) line += `\n    ${detail.slice(0, 300)}`;
	console.log(line);
}

function discoverExtensionDirs(baseDir) {
	const paths = [];
	for (const entry of readdirSync(baseDir)) {
		if (entry.startsWith(".")) continue;
		const full = join(baseDir, entry);
		const stat = statSync(full);
		if (stat.isDirectory() && existsSync(join(full, "index.ts"))) {
			paths.push(full);
		}
	}
	return paths;
}

// ── Setup ────────────────────────────────────────────────────

console.log("\n\x1b[1m══ Slash Command Registration E2E Test ══\x1b[0m\n");

const projectRoot = resolve(import.meta.dirname, "..");
const extDir = join(projectRoot, "extensions");
const themesDir = join(projectRoot, "themes");
const extensionPaths = discoverExtensionDirs(extDir);

console.log(`Discovered ${extensionPaths.length} extensions`);

const agentDir = join(os.tmpdir(), `tallow-cmd-test-${Date.now()}`);
mkdirSync(join(agentDir, "extensions"), { recursive: true });

const authStorage = new AuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const settingsManager = SettingsManager.inMemory();
const eventBus = createEventBus();

const loader = new DefaultResourceLoader({
	cwd: os.tmpdir(),
	agentDir,
	settingsManager,
	eventBus,
	additionalExtensionPaths: extensionPaths,
	additionalThemePaths: existsSync(themesDir) ? [themesDir] : [],
	skillsOverride: () => ({ skills: [], diagnostics: [] }),
	promptsOverride: () => ({ prompts: [], diagnostics: [] }),
	agentsFilesOverride: () => ({ agentsFiles: [] }),
});

await loader.reload();
const exts = loader.getExtensions();

console.log(`Extensions loaded: ${exts.extensions.length}`);
console.log(`Extension errors: ${exts.errors.length}\n`);

// ── Test: No extension load errors ───────────────────────────

console.log("\x1b[1mExtension Loading\x1b[0m");
check(
	"no extension load errors",
	exts.errors.length === 0,
	exts.errors.map((e) => `${e.path}: ${e.error}`).join("\n")
);

for (const err of exts.errors) {
	check(`load ${err.path.split("/").pop()}`, false, err.error);
}

// ── Initialize runtime (need a session) ──────────────────────

const model = getModel("anthropic", "claude-haiku-4-5");
if (!model) {
	console.error("✗ Model claude-haiku-4-5 not found — set ANTHROPIC_API_KEY");
	process.exit(1);
}

const { session } = await createAgentSession({
	model,
	thinkingLevel: "off",
	authStorage,
	modelRegistry,
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
	settingsManager,
});

// ── Test: Expected commands registered ───────────────────────

console.log("\n\x1b[1mSlash Command Registration\x1b[0m");

const commands = exts.runtime.getCommands();
const commandNames = new Set(commands.map((c) => c.name));

for (const expected of EXPECTED_COMMANDS) {
	check(`/${expected} registered`, commandNames.has(expected));
}

// ── Test: Agent commands registered ──────────────────────────

console.log("\n\x1b[1mAgent Command Registration\x1b[0m");

for (const expected of EXPECTED_AGENT_COMMANDS) {
	check(`/${expected} (agent) registered`, commandNames.has(expected));
}

// ── Test: No unexpected missing commands ─────────────────────

console.log("\n\x1b[1mSummary\x1b[0m");

const allExpected = [...EXPECTED_COMMANDS, ...EXPECTED_AGENT_COMMANDS];
const registered = allExpected.filter((c) => commandNames.has(c));
const missing = allExpected.filter((c) => !commandNames.has(c));

check(
	`${registered.length}/${allExpected.length} expected commands registered`,
	missing.length === 0,
	missing.length > 0 ? `Missing: ${missing.map((c) => `/${c}`).join(", ")}` : undefined
);

// Log any extra extension commands (informational, not a failure)
const extCommands = commands.filter((c) => c.source === "extension").map((c) => c.name);
const extras = extCommands.filter((c) => !allExpected.includes(c));
if (extras.length > 0) {
	console.log(
		`\n  \x1b[2mAdditional commands found: ${extras.map((c) => `/${c}`).join(", ")}\x1b[0m`
	);
}

// ── Cleanup ──────────────────────────────────────────────────

session.dispose();
rmSync(agentDir, { recursive: true, force: true });

const passed = results.filter((r) => r.passed).length;
const total = results.length;

console.log(`\n\x1b[1m══ Results: ${passed}/${total} passed ══\x1b[0m\n`);

if (passed < total) {
	for (const r of results.filter((r) => !r.passed)) {
		console.log(`  \x1b[31m✗ ${r.name}\x1b[0m`);
		if (r.detail) console.log(`    ${r.detail.slice(0, 300)}`);
	}
	console.log();
}

process.exit(passed === total ? 0 : 1);
