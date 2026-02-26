#!/usr/bin/env node

/**
 * Copy pi-coding-agent's built-in theme files into tallow's tree.
 *
 * Tallow sets PI_PACKAGE_DIR to its own project root so pi reads
 * piConfig.name from tallow's package.json.  As a side-effect, pi's
 * getThemesDir() looks for built-in themes (dark.json, light.json)
 * inside the tallow tree instead of inside node_modules.
 *
 * Pi picks src/ over dist/ when src/ exists (true for cloned repos).
 * We copy to both paths so it works in dev clones and npm installs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const THEME_FILES = ["dark.json", "light.json", "theme-schema.json"];
const PI_THEMES = join(
	"node_modules",
	"@mariozechner",
	"pi-coding-agent",
	"dist",
	"modes",
	"interactive",
	"theme"
);
const RELATIVE_PATH = join("modes", "interactive", "theme");

/**
 * Copy theme files to a destination directory.
 * Uses read+write instead of cpSync to avoid EINVAL when Bun's
 * node_modules hardlinks share the same inode as a previous copy.
 *
 * @param {string} dest - Destination directory path
 */
function copyThemes(dest) {
	mkdirSync(dest, { recursive: true });
	for (const file of THEME_FILES) {
		writeFileSync(join(dest, file), readFileSync(join(PI_THEMES, file)));
	}
}

// Always copy to dist/ (npm installs, no src/ present)
copyThemes(join("dist", RELATIVE_PATH));

// Also copy to src/ when it exists (cloned repos — pi picks src/ over dist/)
const hasSrc = existsSync("src");
if (hasSrc) copyThemes(join("src", RELATIVE_PATH));

console.log(`Copied pi built-in themes → dist/ ${hasSrc ? "+ src/" : ""}`);
