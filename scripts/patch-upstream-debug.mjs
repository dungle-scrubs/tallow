/**
 * Patch out debug console.error/trace calls left in pi-coding-agent dist.
 *
 * These COMPACTION_DEBUG lines print to stderr on every prompt, bleeding
 * into the TUI as red text. They are debug statements that should have
 * been removed before publishing.
 *
 * Runs as a postinstall hook so the patch survives `bun install`.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TARGETS = [
	"node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js",
	"node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js",
];

/** Match unpatched debug lines (not already commented out). */
const PATTERNS = [
	/(?<!\/\/ )console\.error\('\[COMPACTION_DEBUG\]/g,
	/(?<!\/\/ )console\.trace\('\[COMPACTION_DEBUG\]/g,
];

let totalPatched = 0;

for (const target of TARGETS) {
	if (!existsSync(target)) continue;

	let content = readFileSync(target, "utf-8");
	let patched = false;

	for (const pattern of PATTERNS) {
		const replacement = content.replace(pattern, (match) => `// ${match}`);
		if (replacement !== content) {
			content = replacement;
			patched = true;
		}
	}

	if (patched) {
		writeFileSync(target, content);
		totalPatched++;
	}
}

if (totalPatched > 0) {
	console.log(`Patched COMPACTION_DEBUG in ${totalPatched} file(s)`);
}
