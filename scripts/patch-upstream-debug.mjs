/**
 * Patch upstream pi-coding-agent dist files after install.
 *
 * 1. Remove debug console.error/trace calls left in pi-coding-agent dist.
 *    These COMPACTION_DEBUG lines print to stderr on every prompt, bleeding
 *    into the TUI as red text.
 *
 * 2. Fix generateTurnPrefixSummary() to pass reasoning:"high" when
 *    model.reasoning is true — mirroring what generateSummary() does.
 *    Without this, pi-ai's OpenRouter handler sends
 *    `reasoning: { effort: "none" }` which MiniMax rejects:
 *    "Reasoning is mandatory for this endpoint and cannot be disabled."
 *
 * Runs as a postinstall hook so patches survive `bun install`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ── Part 1: Debug console removal ────────────────────────────────────────────

const DEBUG_TARGETS = [
	"node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js",
	"node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js",
];

const DEBUG_PATTERNS = [
	/(?<!\/\/ )console\.error\('\[COMPACTION_DEBUG]/g,
	/(?<!\/\/ )console\.trace\('\[COMPACTION_DEBUG]/g,
];

// ── Part 2: MiniMax reasoning fix ─────────────────────────────────────────────

/**
 * The buggy pattern in generateTurnPrefixSummary:
 * passes no reasoning param, causing pi-ai OpenRouter handler to send
 * reasoning: { effort: "none" } which MiniMax rejects.
 *
 * The fixed pattern mirrors generateSummary()'s approach.
 */
const MINIMAX_COMPACTION_PATH =
	"node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js";

const MINIMAX_BUGGY = `const response = await completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, { maxTokens, signal, apiKey });`;

const MINIMAX_FIXED = `const completionOptions = model.reasoning
        ? { maxTokens, signal, apiKey, reasoning: "high" }
        : { maxTokens, signal, apiKey };
    const response = await completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, completionOptions);`;

// ── Patch helpers ─────────────────────────────────────────────────────────────

function patchDebug(target) {
	if (!existsSync(target)) return false;

	let content = readFileSync(target, "utf-8");
	let patched = false;

	for (const pattern of DEBUG_PATTERNS) {
		const replacement = content.replace(pattern, (match) => `// ${match}`);
		if (replacement !== content) {
			content = replacement;
			patched = true;
		}
	}

	if (patched) {
		writeFileSync(target, content);
	}
	return patched;
}

function patchMiniMax(target) {
	if (!existsSync(target)) return false;

	const content = readFileSync(target, "utf-8");
	// Only patch if not already fixed (avoid double-patching)
	if (content.includes("MINIMAX_ALREADY_PATCHED")) return false;
	if (!content.includes(MINIMAX_BUGGY)) return false;

	const patched = content.replace(MINIMAX_BUGGY, `${MINIMAX_FIXED}\n    // MINIMAX_ALREADY_PATCHED`);
	writeFileSync(target, patched);
	return true;
}

// ── Run ───────────────────────────────────────────────────────────────────────

let totalPatched = 0;

for (const target of DEBUG_TARGETS) {
	if (patchDebug(target)) {
		console.log(`Patched COMPACTION_DEBUG in ${target}`);
		totalPatched++;
	}
}

if (patchMiniMax(MINIMAX_COMPACTION_PATH)) {
	console.log(`Patched MiniMax reasoning fix in ${MINIMAX_COMPACTION_PATH}`);
	totalPatched++;
}

if (totalPatched > 0) {
	console.log(`postinstall: ${totalPatched} file(s) patched`);
}
