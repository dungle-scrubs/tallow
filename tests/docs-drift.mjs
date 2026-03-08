#!/usr/bin/env node

/**
 * Docs drift checker — verifies documentation surfaces match the codebase.
 *
 * Checks:
 * 1. Extension count in README/docs matches filesystem
 * 2. Every extension has a docs page
 * 3. Theme count in docs matches filesystem
 * 4. Agent-template count in README/docs matches shipped templates
 * 5. No npm/yarn/pnpm references in docs (bun-only project)
 * 6. Public package references point at @dungle-scrubs/tallow
 * 7. Key doc metadata and CLI-flag references match the codebase
 *
 * Usage:
 *   node tests/docs-drift.mjs
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — drift detected
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let failures = 0;

/**
 * Report a check result and increment failure count if needed.
 *
 * @param {string} label - Check description
 * @param {boolean} pass - Whether the check passed
 * @param {string} [detail] - Additional info on failure
 */
function check(label, pass, detail) {
	if (pass) {
		console.log(`  \x1b[32m✓\x1b[0m ${label}`);
	} else {
		console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
		failures++;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * List extension directories (excluding internal dirs).
 *
 * @returns {string[]} Extension directory names
 */
function getExtensionDirs() {
	const extDir = join(ROOT, "extensions");
	return readdirSync(extDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith("__") && !d.name.startsWith("_"))
		.map((d) => d.name);
}

/**
 * List docs extension pages (minus non-extension pages).
 *
 * @returns {string[]} Docs page names (without .mdx extension)
 */
function getDocsExtensionPages() {
	const docsDir = join(ROOT, "docs/src/content/docs/extensions");
	if (!existsSync(docsDir)) return [];
	return readdirSync(docsDir)
		.filter((f) => f.endsWith(".mdx"))
		.map((f) => f.replace(".mdx", ""))
		.filter((name) => name !== "overview" && name !== "aliases");
}

/**
 * Count files matching a pattern in a directory.
 *
 * @param {string} dir - Directory path
 * @param {string} ext - File extension to match
 * @returns {number} File count
 */
function countFiles(dir, ext) {
	if (!existsSync(dir)) return 0;
	return readdirSync(dir).filter((f) => f.endsWith(ext)).length;
}

/**
 * Count bundled agent templates, excluding helper files like _defaults.md.
 *
 * @returns {number} Bundled agent template count
 */
function countAgentTemplates() {
	const agentsDir = join(ROOT, "templates/agents");
	if (!existsSync(agentsDir)) return 0;
	return readdirSync(agentsDir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).length;
}

/**
 * Extract all numbers adjacent to "extension" in a file.
 *
 * @param {string} filePath - File to scan
 * @returns {number[]} Extracted counts
 */
function extractExtensionCounts(filePath) {
	if (!existsSync(filePath)) return [];
	const content = readFileSync(filePath, "utf-8");
	const matches = [...content.matchAll(/(\d+)\s+(?:bundled\s+)?extensions?\b/gi)];
	return matches.map((m) => Number(m[1]));
}

/**
 * Extract all numbers adjacent to "agent template" in a file.
 *
 * @param {string} filePath - File to scan
 * @returns {number[]} Extracted counts
 */
function extractAgentTemplateCounts(filePath) {
	if (!existsSync(filePath)) return [];
	const content = readFileSync(filePath, "utf-8");
	const matches = [...content.matchAll(/(\d+)\s+(?:bundled\s+)?agent\s+templates?\b/gi)];
	return matches.map((m) => Number(m[1]));
}

// ── Checks ───────────────────────────────────────────────────────────────────

console.log("\n\x1b[1mDocs Drift Check\x1b[0m\n");

// 1. Extension count
const extensions = getExtensionDirs();
const extCount = extensions.length;

console.log(`Filesystem: ${extCount} extensions\n`);

const readmeCounts = extractExtensionCounts(join(ROOT, "README.md"));
for (const count of readmeCounts) {
	check(`README.md says ${count} extensions`, count === extCount, `expected ${extCount}`);
}

const introPath = join(ROOT, "docs/src/content/docs/getting-started/introduction.md");
const introCounts = extractExtensionCounts(introPath);
for (const count of introCounts) {
	check(`introduction.md says ${count} extensions`, count === extCount, `expected ${extCount}`);
}

const indexPath = join(ROOT, "docs/src/content/docs/index.mdx");
const indexCounts = extractExtensionCounts(indexPath);
for (const count of indexCounts) {
	check(`index.mdx says ${count} extensions`, count === extCount, `expected ${extCount}`);
}

const overviewPath = join(ROOT, "docs/src/content/docs/extensions/overview.mdx");
const overviewCounts = extractExtensionCounts(overviewPath);
for (const count of overviewCounts) {
	check(`overview.mdx says ${count} extensions`, count === extCount, `expected ${extCount}`);
}

// 2. Every extension has a docs page
const docsPages = new Set(getDocsExtensionPages());
const missingDocs = extensions.filter((ext) => !docsPages.has(ext));
check(
	`All ${extCount} extensions have docs pages`,
	missingDocs.length === 0,
	missingDocs.length > 0 ? `missing: ${missingDocs.join(", ")}` : undefined
);

// 3. Theme count
const themeCount = countFiles(join(ROOT, "themes"), ".json");
const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
const themeMatch = readme.match(/(\d+)\s+themes?\b/i);
if (themeMatch) {
	check(
		`README.md theme count (${themeMatch[1]})`,
		Number(themeMatch[1]) === themeCount,
		`expected ${themeCount}`
	);
}

// 4. Agent-template count
const agentTemplateCount = countAgentTemplates();
const readmeAgentCounts = extractAgentTemplateCounts(join(ROOT, "README.md"));
for (const count of readmeAgentCounts) {
	check(
		`README.md says ${count} agent templates`,
		count === agentTemplateCount,
		`expected ${agentTemplateCount}`
	);
}

const introAgentCounts = extractAgentTemplateCounts(introPath);
for (const count of introAgentCounts) {
	check(
		`introduction.md says ${count} agent templates`,
		count === agentTemplateCount,
		`expected ${agentTemplateCount}`
	);
}

const indexAgentCounts = extractAgentTemplateCounts(indexPath);
for (const count of indexAgentCounts) {
	check(
		`index.mdx says ${count} agent templates`,
		count === agentTemplateCount,
		`expected ${agentTemplateCount}`
	);
}

// 5. No stale package manager references in user-facing docs
const docsToCheck = [
	"docs/src/content/docs/getting-started/installation.md",
	"docs/src/content/docs/getting-started/introduction.md",
	"docs/src/content/docs/development/creating-extensions.md",
];
for (const relPath of docsToCheck) {
	const fullPath = join(ROOT, relPath);
	if (!existsSync(fullPath)) continue;
	const content = readFileSync(fullPath, "utf-8");
	// Match "npm install", "npm run", "npm link", "npm test" but not "npmDependencies" or "npm registry" or "npm:"
	const npmRefs = [...content.matchAll(/\bnpm\s+(install|run|link|test|init|start)\b/gi)];
	check(
		`${relPath} uses bun (not npm)`,
		npmRefs.length === 0,
		npmRefs.length > 0 ? `found: ${npmRefs.map((m) => m[0]).join(", ")}` : undefined
	);
}

// 6. Public package references point at the scoped package
check(
	"README.md links to the scoped npm package",
	readme.includes("https://www.npmjs.com/package/@dungle-scrubs/tallow"),
	"expected npm badge link to point at @dungle-scrubs/tallow"
);

// 7. Key doc metadata and CLI-flag references match the codebase
const astroConfig = readFileSync(join(ROOT, "docs/astro.config.mjs"), "utf-8");
check(
	"docs/astro.config.mjs extension metadata matches filesystem",
	astroConfig.includes(`${extCount} extensions`),
	`expected docs metadata to mention ${extCount} extensions`
);

const contextForkDocs = readFileSync(
	join(ROOT, "docs/src/content/docs/extensions/context-fork.mdx"),
	"utf-8"
);
check(
	"context-fork docs use --model (not --models)",
	contextForkDocs.includes("--model <model>") && !contextForkDocs.includes("--models <model>"),
	"expected docs to describe the singular --model flag"
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("");
if (failures > 0) {
	console.log(`\x1b[31m${failures} drift issue(s) found.\x1b[0m`);
	console.log("Fix the documentation to match the codebase (codebase is authoritative).\n");
	process.exit(1);
} else {
	console.log("\x1b[32mNo drift detected.\x1b[0m\n");
}
