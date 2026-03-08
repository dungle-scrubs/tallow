#!/usr/bin/env node

/**
 * CHANGELOG structure checker — verifies repo-specific changelog invariants.
 *
 * Checks:
 * 1. CHANGELOG.md contains exactly one Unreleased section
 * 2. The Unreleased section is the first changelog section
 *
 * Usage:
 *   node tests/changelog-structure.mjs
 *
 * Exit codes:
 *   0 — structure is valid
 *   1 — structure drift detected
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");
const lines = readFileSync(CHANGELOG_PATH, "utf-8").split("\n");

/**
 * Report a check result and return whether it passed.
 *
 * @param {string} label - Check description
 * @param {boolean} pass - Whether the check passed
 * @param {string} [detail] - Additional failure detail
 * @returns {boolean} The pass value for aggregation
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
 * Find all 1-indexed line numbers that match a section heading.
 *
 * @param {string} heading - Exact heading prefix to match
 * @returns {number[]} Matching line numbers
 */
function findHeadingLines(heading) {
	return lines
		.map((line, index) => ({ index, line }))
		.filter(({ line }) => line.startsWith(heading))
		.map(({ index }) => index + 1);
}

console.log("\n\x1b[1mChangelog Structure Check\x1b[0m\n");

const unreleasedLines = findHeadingLines("## [Unreleased]");
const sectionLines = findHeadingLines("## [");
const firstSectionLine = sectionLines[0];

const singleUnreleased = check(
	"CHANGELOG.md has exactly one Unreleased section",
	unreleasedLines.length === 1,
	`found at lines: ${unreleasedLines.join(", ") || "none"}`
);
const unreleasedFirst = check(
	"CHANGELOG.md keeps Unreleased at the top",
	unreleasedLines.length === 1 && unreleasedLines[0] === firstSectionLine,
	`expected line ${firstSectionLine ?? "none"}, found ${unreleasedLines[0] ?? "none"}`
);

console.log("");
if (!singleUnreleased || !unreleasedFirst) {
	console.log("\x1b[31mChangelog structure drift detected.\x1b[0m\n");
	process.exit(1);
}
console.log("\x1b[32mChangelog structure is valid.\x1b[0m\n");
