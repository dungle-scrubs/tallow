#!/usr/bin/env node

/**
 * E2E test for the plan-mode extension.
 *
 * Proves:
 *   1. plan_mode tool remains available after toggling modes
 *   2. Extension tools survive setActiveTools transitions
 *   3. Base tools are correctly restricted in plan mode
 *
 * Uses the SDK to load ONLY the plan-mode extension (isolated).
 * Costs ~$0.01 per run.
 *
 * Usage:
 *   node extensions/plan-mode-tool/__tests__/e2e.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────

const results = [];

/**
 * Record a test result.
 * @param {string} name - Test name
 * @param {boolean} passed - Pass/fail
 * @param {string} [detail] - Extra detail on failure
 */
function check(name, passed, detail) {
	results.push({ name, passed, detail });
	const icon = passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
	let line = `  ${icon} ${name}`;
	if (!passed && detail) line += `\n    ${detail.slice(0, 300)}`;
	console.log(line);
}

/**
 * Get the text content of the most recent tool result for a given tool name.
 * @param {import("@mariozechner/pi-coding-agent").AgentSession} session
 * @param {string} toolName
 * @returns {string}
 */
function lastToolResultText(session, toolName) {
	const msgs = session.messages;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role === "toolResult" && m.toolName === toolName) {
			for (const part of m.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Check if any tool result in the session contains "not found" error.
 * @param {import("@mariozechner/pi-coding-agent").AgentSession} session
 * @param {string} toolName
 * @returns {boolean}
 */
function hasToolNotFoundError(session, toolName) {
	const msgs = session.messages;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role === "toolResult") {
			for (const part of m.content) {
				if (part.type === "text" && part.text.includes(`Tool ${toolName} not found`)) {
					return true;
				}
			}
		}
	}
	return false;
}

// ── Isolated extension loading ───────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionSrcDir = path.resolve(__dirname, "..");

const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-e2e-plan-"));
const extDst = path.join(testAgentDir, "extensions/plan-mode-tool");
fs.mkdirSync(extDst, { recursive: true });
for (const file of ["index.ts", "utils.ts"]) {
	fs.copyFileSync(path.join(extensionSrcDir, file), path.join(extDst, file));
}

// ── Setup ────────────────────────────────────────────────────

console.log("\n\x1b[1m══ Plan Mode Extension E2E Test ══\x1b[0m\n");

const authStorage = new AuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const model = getModel("anthropic", "claude-haiku-4-5");
if (!model) {
	console.error("✗ Model claude-haiku-4-5 not found");
	process.exit(1);
}

const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

console.log("Loading extension (isolated)...");
const loader = new DefaultResourceLoader({
	cwd: os.tmpdir(),
	agentDir: testAgentDir,
	settingsManager,
	skillsOverride: () => ({ skills: [], diagnostics: [] }),
	promptsOverride: () => ({ prompts: [], diagnostics: [] }),
	agentsFilesOverride: () => ({ agentsFiles: [] }),
});
await loader.reload();

const exts = loader.getExtensions();
console.log(`  Extensions loaded: ${exts.extensions.length}, errors: ${exts.errors.length}`);
if (exts.errors.length > 0) {
	console.error("  Extension errors:", exts.errors);
}

console.log("Creating session (haiku)...\n");
const { session } = await createAgentSession({
	model,
	thinkingLevel: "off",
	authStorage,
	modelRegistry,
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
	settingsManager,
});

// Log tool calls
session.subscribe((event) => {
	if (event.type === "tool_execution_start") {
		process.stdout.write(`    \x1b[2m→ ${event.toolName}\x1b[0m\n`);
	}
});

// ── Test 1: plan_mode tool exists at startup ─────────────────

console.log("\x1b[1mTest 1: plan_mode tool available at startup\x1b[0m");
await session.prompt(
	'Call the plan_mode tool with action "status". Only call this one tool, nothing else.'
);
const statusText = lastToolResultText(session, "plan_mode");
const noStartupError = !hasToolNotFoundError(session, "plan_mode");
check("plan_mode tool callable at startup", noStartupError, statusText);
check("reports normal mode", statusText.includes("normal"), statusText);

// ── Test 2: Enable plan mode, verify plan_mode survives ──────

console.log("\n\x1b[1mTest 2: Enable plan mode → plan_mode tool still available\x1b[0m");
await session.prompt(
	'Call the plan_mode tool with action "enable". Only call this one tool, nothing else.'
);
const enableText = lastToolResultText(session, "plan_mode");
const noEnableError = !hasToolNotFoundError(session, "plan_mode");
check("plan_mode callable during enable", noEnableError, enableText);
check("reports plan mode enabled", enableText.includes("enabled"), enableText);

// Now check status — plan_mode should still work IN plan mode
await session.prompt(
	'Call the plan_mode tool with action "status". Only call this one tool, nothing else.'
);
const planStatusText = lastToolResultText(session, "plan_mode");
const noPlanStatusError = !hasToolNotFoundError(session, "plan_mode");
check("plan_mode callable while in plan mode", noPlanStatusError, planStatusText);
check("reports planning mode", planStatusText.includes("planning"), planStatusText);

// ── Test 3: Disable plan mode, verify plan_mode survives ─────

console.log("\n\x1b[1mTest 3: Disable plan mode → plan_mode tool still available\x1b[0m");
await session.prompt(
	'Call the plan_mode tool with action "disable". Only call this one tool, nothing else.'
);
const disableText = lastToolResultText(session, "plan_mode");
const noDisableError = !hasToolNotFoundError(session, "plan_mode");
check("plan_mode callable during disable", noDisableError, disableText);
check("reports disabled", disableText.includes("disabled"), disableText);

// Final status check — should be back to normal
await session.prompt(
	'Call the plan_mode tool with action "status". Only call this one tool, nothing else.'
);
const finalStatusText = lastToolResultText(session, "plan_mode");
const noFinalError = !hasToolNotFoundError(session, "plan_mode");
check("plan_mode callable after round-trip", noFinalError, finalStatusText);
check("back to normal mode", finalStatusText.includes("normal"), finalStatusText);

// ── Test 4: Base tools restricted in plan mode ───────────────

console.log("\n\x1b[1mTest 4: Write tools blocked in plan mode\x1b[0m");
await session.prompt(
	'Call the plan_mode tool with action "enable". Only call this one tool, nothing else.'
);

// Try to use edit tool — should fail since it's not in the active set
await session.prompt(
	'Call the edit tool to edit file "/tmp/test.txt" replacing "a" with "b". Only call edit, nothing else. If the edit tool is not available, say "EDIT_UNAVAILABLE" in your response.'
);

// Check if edit was blocked (tool not found or model reported unavailable)
const lastMsgs = session.messages;
let editBlocked = false;
for (let i = lastMsgs.length - 1; i >= 0; i--) {
	const m = lastMsgs[i];
	if (m.role === "toolResult") {
		for (const part of m.content) {
			if (part.type === "text" && part.text.includes("Tool edit not found")) {
				editBlocked = true;
			}
		}
	}
	if (m.role === "assistant") {
		for (const part of m.content) {
			if (part.type === "text" && part.text.includes("EDIT_UNAVAILABLE")) {
				editBlocked = true;
			}
		}
	}
}
check("edit tool blocked in plan mode", editBlocked, "edit should not be available in plan mode");

// Clean up — disable plan mode
await session.prompt(
	'Call the plan_mode tool with action "disable". Only call this one tool, nothing else.'
);

// ── Cleanup & Summary ────────────────────────────────────────

session.dispose();
fs.rmSync(testAgentDir, { recursive: true, force: true });

const passed = results.filter((r) => r.passed).length;
const total = results.length;

console.log(`\n\x1b[1m══ Results: ${passed}/${total} passed ══\x1b[0m`);
if (passed < total) {
	console.log("\n\x1b[31mFailed:\x1b[0m");
	for (const r of results.filter((r) => !r.passed)) {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) console.log(`    ${r.detail.slice(0, 300)}`);
	}
}
console.log();
process.exit(passed === total ? 0 : 1);
