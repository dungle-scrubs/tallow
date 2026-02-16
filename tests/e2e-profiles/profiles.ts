/**
 * Extension profile definitions for E2E testing.
 *
 * Profiles group extensions into meaningful tiers based on the dependency
 * graph declared in each extension's `extension.json` relationships.
 *
 * - Core: minimum viable session (tool-display + enhanced tools + basics)
 * - Standard: typical user setup (core + productivity + agents)
 * - Full: every bundled extension
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
export const EXTENSIONS_DIR = join(PROJECT_ROOT, "extensions");

// ── Profile Definitions ──────────────────────────────────────────────────────

/**
 * Core profile — bare minimum for a functional session.
 * Provides enhanced tools, shared utilities, and essential commands.
 */
export const CORE_EXTENSIONS = [
	"_icons",
	"tool-display",
	"bash-tool-enhanced",
	"read-tool-enhanced",
	"edit-tool-enhanced",
	"write-tool-enhanced",
	"cd-tool",
	"clear",
	"show-system-prompt",
] as const;

/**
 * Standard profile — what a typical user runs.
 * Adds productivity tools, agent management, and session features.
 */
export const STANDARD_EXTENSIONS = [
	...CORE_EXTENSIONS,
	"background-task-tool",
	"tasks",
	"subagent-tool",
	"ask-user-question-tool",
	"context-usage",
	"context-files",
	"git-status",
	"health",
	"init",
	"random-spinner",
	"session-memory",
	"session-namer",
	"theme-selector",
	"custom-footer",
	"output-styles-tool",
	"plan-mode-tool",
	"cheatsheet",
	"lsp",
	"debug",
	"hooks",
	"stats",
	"rewind",
] as const;

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Discover all bundled extension directory names.
 * Mirrors the logic in sdk.ts discoverExtensionDirs.
 *
 * @returns Sorted array of extension directory names
 */
export function discoverAllExtensionNames(): string[] {
	const names: string[] = [];
	for (const entry of readdirSync(EXTENSIONS_DIR)) {
		if (entry.startsWith(".") || entry === "__integration__") continue;
		const full = join(EXTENSIONS_DIR, entry);
		if (statSync(full).isDirectory() && existsSync(join(full, "index.ts"))) {
			names.push(entry);
		}
	}
	return names.sort();
}

/**
 * Resolve extension names to their absolute paths.
 *
 * @param names - Extension directory names
 * @returns Absolute paths to each extension directory
 */
export function resolveExtensionPaths(names: readonly string[]): string[] {
	return names.map((name) => join(EXTENSIONS_DIR, name));
}
