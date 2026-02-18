import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file, which will be given to future AI coding agent sessions operating in this repository.

What to add:
1. Commands that will be commonly used, such as how to build, lint, and run tests. Include the necessary commands to develop in this codebase, such as how to run a single test.
2. High-level code architecture and structure so that future sessions can be productive more quickly. Focus on the "big picture" architecture that requires reading multiple files to understand.

Usage notes:
- If there's already an AGENTS.md (or CLAUDE.md), suggest improvements to it.
- When you make the initial AGENTS.md, do not repeat yourself and do not include obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilities", "Never include sensitive information (API keys, tokens) in code or commits".
- Avoid listing every component or file structure that can be easily discovered.
- Don't include generic development practices.
- If there are Cursor rules (in .cursor/rules/ or .cursorrules) or Copilot rules (in .github/copilot-instructions.md), make sure to include the important parts.
- If there is a README.md, make sure to include the important parts.
- Do not make up information such as "Common Development Tasks", "Tips for Development", "Support and Documentation" unless this is expressly included in other files that you read.
- Be sure to prefix the file with the following text:

# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.`;

const MIGRATE_PROMPT = `There is an existing CLAUDE.md in this project that can be migrated to AGENTS.md. Please:

1. Read the existing CLAUDE.md file.
2. Create a new AGENTS.md based on its content, replacing any agent-specific references with generic agent-neutral language.
3. Update the header to use "# AGENTS.md" and the description line to: "This file provides guidance to AI coding agents when working with code in this repository."
4. Keep the CLAUDE.md file in place for backward compatibility, but note in it that AGENTS.md is the canonical source.

After creating AGENTS.md, also analyze the codebase and suggest any improvements to the migrated content.`;

/** Directories to skip during subdirectory walks. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"__pycache__",
	".venv",
	"venv",
	"vendor",
	".tox",
	".mypy_cache",
	".pytest_cache",
	"coverage",
	".turbo",
	".cache",
	".output",
]);

/**
 * Renames .claude/ to .tallow/ in the project directory.
 * Moves all contents; tallow's claude-bridge extension still reads .claude/ if present,
 * but .tallow/ is the canonical location.
 *
 * Uses try-catch to handle TOCTOU races where the filesystem may change
 * between the caller's existence checks and this rename.
 *
 * @param cwd - Project root directory
 * @returns true if renamed, false if the rename failed (e.g., source gone or target exists)
 */
function renameClaudeDir(cwd: string): boolean {
	const claudeDir = path.join(cwd, ".claude");
	const tallowDir = path.join(cwd, ".tallow");
	try {
		fs.renameSync(claudeDir, tallowDir);
		return true;
	} catch {
		// Source deleted or target created between check and rename
		return false;
	}
}

/**
 * Find subdirectories containing a .claude/ directory.
 * Walks up to maxDepth levels, skipping SKIP_DIRS and dot-prefixed dirs.
 *
 * @param cwd - Root directory to search from
 * @param maxDepth - Maximum walk depth (default: 5)
 * @returns Array of subdirectory paths that contain a .claude/ directory
 */
function findNestedClaudeDirs(cwd: string, maxDepth: number = 5): string[] {
	const results: string[] = [];

	function walk(dir: string, depth: number): void {
		if (depth > maxDepth) return;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const name = entry.name;
			if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;

			const subdir = path.join(dir, name);
			const claudePath = path.join(subdir, ".claude");

			try {
				if (fs.existsSync(claudePath) && fs.statSync(claudePath).isDirectory()) {
					results.push(subdir);
				}
			} catch {
				// Ignore filesystem errors for this path
			}

			walk(subdir, depth + 1);
		}
	}

	walk(cwd, 0);
	return results;
}

/**
 * Find CLAUDE.md files in subdirectories.
 * Walks up to maxDepth levels, skipping SKIP_DIRS and dot-prefixed dirs.
 *
 * @param cwd - Root directory to search from
 * @param maxDepth - Maximum walk depth (default: 5)
 * @returns Array of absolute paths to CLAUDE.md files in subdirectories
 */
function findNestedClaudeMdFiles(cwd: string, maxDepth: number = 5): string[] {
	const results: string[] = [];

	function walk(dir: string, depth: number): void {
		if (depth > maxDepth) return;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const name = entry.name;
			if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;

			const subdir = path.join(dir, name);
			const claudeMdPath = path.join(subdir, "CLAUDE.md");

			try {
				if (fs.existsSync(claudeMdPath) && fs.statSync(claudeMdPath).isFile()) {
					results.push(claudeMdPath);
				}
			} catch {
				// Ignore filesystem errors for this path
			}

			walk(subdir, depth + 1);
		}
	}

	walk(cwd, 0);
	return results;
}

/**
 * Build the migration prompt with optional file removal and nested file handling.
 *
 * @param options - Migration options
 * @param options.filesToRemove - CLAUDE.md files to remove after migration
 * @param options.nestedFiles - Nested CLAUDE.md files to also migrate
 * @returns Prompt string for the model
 */
function buildMigratePrompt(options: { filesToRemove: string[]; nestedFiles: string[] }): string {
	const { filesToRemove, nestedFiles } = options;

	if (filesToRemove.length === 0 && nestedFiles.length === 0) {
		return MIGRATE_PROMPT;
	}

	const lines: string[] = [MIGRATE_PROMPT];

	if (nestedFiles.length > 0) {
		lines.push(
			"",
			"In addition, there are CLAUDE.md files in subdirectories that should be migrated:",
			"",
			...nestedFiles.map((file) => `- ${file}`),
			"",
			"For each of these files, create a sibling AGENTS.md file in the same directory,",
			"following the same migration rules as for the root CLAUDE.md."
		);
	}

	if (filesToRemove.length > 0) {
		lines.push(
			"",
			"After you have created and reviewed all AGENTS.md files, delete the following",
			"obsolete CLAUDE.md files from the repository:",
			"",
			...filesToRemove.map((file) => `- ${file}`)
		);
	}

	return lines.join("\n");
}

/**
 * Registers /init command to create or improve AGENTS.md for a project.
 * Handles migration from CLAUDE.md to AGENTS.md and .claude/ to .tallow/.
 * @param pi - Extension API for registering commands
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Initialize AGENTS.md for the current project",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;

			// ── Offer .claude/ → .tallow/ rename ──────────────────────────
			const claudeDirPath = path.join(cwd, ".claude");
			const tallowDirPath = path.join(cwd, ".tallow");

			if (fs.existsSync(claudeDirPath) && !fs.existsSync(tallowDirPath)) {
				const ok = await ctx.ui.confirm(
					"Rename .claude/ to .tallow/?",
					"Found a .claude/ directory. Renaming to .tallow/ makes this a tallow-native project. All contents will be preserved."
				);
				if (ok) {
					if (renameClaudeDir(cwd)) {
						ctx.ui.notify("Renamed .claude/ → .tallow/", "info");
					} else {
						ctx.ui.notify(
							"Could not rename .claude/ — it may have been moved or .tallow/ already exists",
							"warning"
						);
					}
				}
			}

			// ── Offer nested .claude/ → .tallow/ renames ────────────────
			const nestedClaudeDirs = findNestedClaudeDirs(cwd);
			if (nestedClaudeDirs.length > 0) {
				const dirList = nestedClaudeDirs
					.map((d) => `  ${path.relative(cwd, path.join(d, ".claude"))}/`)
					.join("\n");
				const ok = await ctx.ui.confirm(
					`Rename ${nestedClaudeDirs.length} nested .claude/ directories to .tallow/?`,
					`Found .claude/ in subdirectories:\n${dirList}`
				);
				if (ok) {
					let renamed = 0;
					let failed = 0;
					for (const dir of nestedClaudeDirs) {
						const claudePath = path.join(dir, ".claude");
						const tallowPath = path.join(dir, ".tallow");
						if (!fs.existsSync(tallowPath)) {
							try {
								fs.renameSync(claudePath, tallowPath);
								renamed++;
							} catch {
								failed++;
							}
						} else {
							failed++;
						}
					}
					if (renamed > 0) {
						ctx.ui.notify(`Renamed ${renamed} nested .claude/ → .tallow/`, "info");
					}
					if (failed > 0) {
						ctx.ui.notify(
							`${failed} nested renames skipped (.tallow/ already exists or error)`,
							"warning"
						);
					}
				}
			}

			// ── AGENTS.md creation / migration ────────────────────────────
			const claudeMdPath = path.join(cwd, "CLAUDE.md");
			const agentsMdPath = path.join(cwd, "AGENTS.md");

			const claudeExists = fs.existsSync(claudeMdPath);
			const agentsExists = fs.existsSync(agentsMdPath);

			// ── Discover nested CLAUDE.md files ─────────────────────────
			const nestedClaudeMdFiles = findNestedClaudeMdFiles(cwd);
			const allClaudeMdFiles: string[] = [];
			if (claudeExists) allClaudeMdFiles.push(claudeMdPath);
			allClaudeMdFiles.push(...nestedClaudeMdFiles);

			let removeClaudeMd = false;
			if (allClaudeMdFiles.length > 0 && !agentsExists) {
				const fileList = allClaudeMdFiles.map((f) => `  ${path.relative(cwd, f)}`).join("\n");
				removeClaudeMd = await ctx.ui.confirm(
					"Remove CLAUDE.md files after migration to AGENTS.md?",
					`Found CLAUDE.md files:\n${fileList}\n\nThey will be migrated to AGENTS.md equivalents first.`
				);
			}

			if (agentsExists) {
				ctx.ui.notify("Found existing AGENTS.md — will suggest improvements", "info");
				pi.sendUserMessage(INIT_PROMPT);
			} else if (claudeExists) {
				ctx.ui.notify("Found CLAUDE.md without AGENTS.md — will migrate to AGENTS.md", "info");
				const prompt = buildMigratePrompt({
					filesToRemove: removeClaudeMd
						? allClaudeMdFiles.map((filepath) => path.relative(cwd, filepath))
						: [],
					nestedFiles: nestedClaudeMdFiles.map((filepath) => path.relative(cwd, filepath)),
				});
				pi.sendUserMessage(prompt);
			} else {
				ctx.ui.notify("Analyzing codebase to create AGENTS.md...", "info");
				pi.sendUserMessage(INIT_PROMPT);
			}

			// ── Scaffold .tallow/rules/ if missing ──────────────────────
			const tallowRulesDir = path.join(cwd, ".tallow", "rules");
			if (!fs.existsSync(tallowRulesDir)) {
				const ok = await ctx.ui.confirm(
					"Create .tallow/rules/ for project-specific rules?",
					"Place .md or .txt files in this directory. They'll be included in every tallow session's context."
				);
				if (ok) {
					fs.mkdirSync(tallowRulesDir, { recursive: true });
					fs.writeFileSync(
						path.join(tallowRulesDir, "README.md"),
						`# Rules\n\nPlace \`.md\` or \`.txt\` files in this directory.\nThey'll be included in every tallow session's context.\n\nFiles are loaded alphabetically. Use numeric prefixes\nfor ordering: \`01-style.md\`, \`02-testing.md\`.\n`
					);
					ctx.ui.notify("Created .tallow/rules/ with starter README.md", "info");
				}
			}
		},
	});
}
