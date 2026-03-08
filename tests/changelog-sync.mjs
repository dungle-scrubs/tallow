#!/usr/bin/env node

/**
 * Changelog sync checker — verifies docs changelog sync wiring and generated output.
 *
 * Checks:
 * 1. docs/package.json runs sync-changelog.mjs in predev and prebuild
 * 2. docs/src/content/docs/changelog.md matches the generated output when present
 *
 * Usage:
 *   node tests/changelog-sync.mjs
 *
 * Exit codes:
 *   0 — sync wiring/output is valid
 *   1 — sync drift detected
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS_PACKAGE_PATH = join(ROOT, "docs", "package.json");
const ROOT_CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");
const DOCS_CHANGELOG_PATH = join(ROOT, "docs", "src", "content", "docs", "changelog.md");
const SYNC_COMMAND = "node scripts/sync-changelog.mjs";

/**
 * Report a check result and return the pass state for aggregation.
 *
 * @param {string} label - Check description
 * @param {boolean} pass - Whether the check passed
 * @param {string} [detail] - Optional failure detail
 * @returns {boolean} The original pass state
 */
function check(label, pass, detail) {
	if (pass) {
		console.log(`  \x1b[32m✓\x1b[0m ${label}`);
		return true;
	}
	console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
	return false;
}

/**
 * Build the exact docs changelog content that sync-changelog.mjs should emit.
 *
 * @returns {string} Expected docs changelog content
 */
function buildExpectedDocsChangelog() {
	const source = readFileSync(ROOT_CHANGELOG_PATH, "utf-8");
	const content = source.replace(/^# Changelog\n*/m, "");
	const frontmatter = `---
title: Changelog
description: All notable changes to tallow, following Keep a Changelog.
---

`;
	return frontmatter + content;
}

console.log("\n\x1b[1mChangelog Sync Check\x1b[0m\n");

const docsPackage = JSON.parse(readFileSync(DOCS_PACKAGE_PATH, "utf-8"));
const predev = docsPackage.scripts?.predev;
const prebuild = docsPackage.scripts?.prebuild;
const hooksWired =
	typeof predev === "string" &&
	predev.includes(SYNC_COMMAND) &&
	typeof prebuild === "string" &&
	prebuild.includes(SYNC_COMMAND);

const hooksOk = check(
	"docs/package.json wires changelog sync into predev and prebuild",
	hooksWired,
	`predev=${JSON.stringify(predev)}, prebuild=${JSON.stringify(prebuild)}`
);

let generatedOk = true;
if (existsSync(DOCS_CHANGELOG_PATH)) {
	const expected = buildExpectedDocsChangelog();
	const actual = readFileSync(DOCS_CHANGELOG_PATH, "utf-8");
	generatedOk = check(
		"generated docs changelog matches root CHANGELOG.md",
		actual === expected,
		"run `node docs/scripts/sync-changelog.mjs` to refresh docs/src/content/docs/changelog.md"
	);
} else {
	console.log(
		"  \x1b[33m!\x1b[0m generated docs changelog not present — run `node docs/scripts/sync-changelog.mjs` before local docs inspection"
	);
}

console.log("");
if (!hooksOk || !generatedOk) {
	console.log("\x1b[31mChangelog sync drift detected.\x1b[0m\n");
	process.exit(1);
}
console.log("\x1b[32mChangelog sync is valid.\x1b[0m\n");
