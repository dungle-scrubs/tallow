#!/usr/bin/env node

/**
 * E2E test for the plan-mode extension.
 *
 * Proves:
 *   1. plan_mode tool remains available after toggling modes
 *   2. Plan mode enforces a strict read-only allowlist
 *   3. Non-allowlisted extension tools are blocked in plan mode
 *   4. Disabling plan mode restores normal access
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
import { Type } from "@sinclair/typebox";

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

/**
 * Check if a tool call was blocked by plan-mode policy.
 * @param {import("@mariozechner/pi-coding-agent").AgentSession} session
 * @param {string} toolName
 * @returns {boolean}
 */
function hasPlanModeToolBlockedError(session, toolName) {
	const msgs = session.messages;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role !== "toolResult") continue;
		for (const part of m.content) {
			if (part.type === "text" && part.text.includes(`Plan mode: tool "${toolName}" blocked`)) {
				return true;
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

/**
 * Register mock tools used to validate strict plan-mode allowlisting.
 * @param {import("@mariozechner/pi-coding-agent").ExtensionAPI} pi
 */
function registerMockTools(pi) {
	pi.registerTool({
		name: "bg_bash",
		label: "bg_bash",
		description: "Mock background bash tool",
		parameters: Type.Object({ command: Type.String() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `mock-bg-bash-ok:${params.command}` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "subagent",
		description: "Mock subagent tool",
		parameters: Type.Object({ task: Type.String() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `mock-subagent-ok:${params.task}` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "mcp__mock__ping",
		label: "mcp__mock__ping",
		description: "Mock MCP-style tool",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "mock-mcp-ok" }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "questionnaire",
		label: "questionnaire",
		description: "Mock read-only questionnaire tool",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "mock-questionnaire-ok" }],
				details: {},
			};
		},
	});
}

console.log("Loading extension (isolated)...");
const loader = new DefaultResourceLoader({
	cwd: os.tmpdir(),
	agentDir: testAgentDir,
	settingsManager,
	extensionFactories: [registerMockTools],
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

// ── Test 4: Strict allowlist enforcement in plan mode ────────

console.log("\n\x1b[1mTest 4: Strict allowlist blocks non-read-only tools\x1b[0m");
await session.prompt(
	'Call the plan_mode tool with action "enable". Only call this one tool, nothing else.'
);

await session.prompt(
	'Call the edit tool to edit file "/tmp/test.txt" replacing "a" with "b". Only call edit, nothing else.'
);
const editBlocked =
	hasToolNotFoundError(session, "edit") || hasPlanModeToolBlockedError(session, "edit");
check("edit tool blocked in plan mode", editBlocked, "edit should not be available in plan mode");

await session.prompt(
	'Call the bg_bash tool with command "echo blocked". Only call bg_bash, nothing else.'
);
const bgBashBlocked =
	hasToolNotFoundError(session, "bg_bash") || hasPlanModeToolBlockedError(session, "bg_bash");
check("bg_bash blocked in plan mode", bgBashBlocked, "bg_bash should be blocked in plan mode");

await session.prompt('Call the subagent tool with task "ping". Only call subagent, nothing else.');
const subagentBlocked =
	hasToolNotFoundError(session, "subagent") || hasPlanModeToolBlockedError(session, "subagent");
check("subagent blocked in plan mode", subagentBlocked, "subagent should be blocked in plan mode");

await session.prompt("Call the mcp__mock__ping tool. Only call this one tool, nothing else.");
const mcpBlocked =
	hasToolNotFoundError(session, "mcp__mock__ping") ||
	hasPlanModeToolBlockedError(session, "mcp__mock__ping");
check("mcp__* tools blocked in plan mode", mcpBlocked, "MCP tools should be blocked in plan mode");

await session.prompt("Call the questionnaire tool. Only call this one tool, nothing else.");
const questionnaireText = lastToolResultText(session, "questionnaire");
const questionnaireAllowed = questionnaireText.includes("mock-questionnaire-ok");
check("allowlisted questionnaire tool still works", questionnaireAllowed, questionnaireText);

// ── Test 5: Disabling plan mode restores normal access ───────

console.log("\n\x1b[1mTest 5: Disable restores normal tool access\x1b[0m");
await session.prompt(
	'Call the plan_mode tool with action "disable". Only call this one tool, nothing else.'
);
await session.prompt(
	'Call the subagent tool with task "after-disable". Only call subagent, nothing else.'
);
const subagentAfterDisableText = lastToolResultText(session, "subagent");
const subagentRestored = subagentAfterDisableText.includes("mock-subagent-ok:after-disable");
check("subagent restored after disabling plan mode", subagentRestored, subagentAfterDisableText);

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
