/**
 * Context Files Extension
 *
 * Supplements pi's native AGENTS.md/CLAUDE.md loading by:
 * 1. Loading CLAUDE.md files that pi skipped (when AGENTS.md took precedence)
 * 2. Loading both CLAUDE.md and AGENTS.md from subdirectories (pi only walks up)
 *
 * Priority order (appended to system prompt, most specific last):
 *   1. ~/.tallow/CLAUDE.md (global, if pi loaded AGENTS.md instead)
 *   2. Ancestor dirs → cwd (skipped CLAUDE.md files, farthest first)
 *   3. Subdirectory files (sorted by depth, then alphabetically)
 *
 * Skips: node_modules, .git, dist, build, .next, __pycache__, .venv, vendor
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CONTEXT_FILENAMES = ["CLAUDE.md", "AGENTS.md"] as const;

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

interface ContextFile {
	readonly filepath: string;
	readonly content: string;
	readonly source: "global" | "ancestor" | "cwd" | "subdirectory";
	readonly depth: number;
}

/** Check which context filenames exist in a directory */
function findContextFiles(dir: string): string[] {
	const found: string[] = [];
	for (const name of CONTEXT_FILENAMES) {
		const filepath = path.join(dir, name);
		if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
			found.push(filepath);
		}
	}
	return found;
}

/** Walk up from cwd to root, collecting directories */
function getAncestorDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let current = path.dirname(cwd);
	const root = path.parse(cwd).root;

	while (current !== root && current !== path.dirname(current)) {
		dirs.push(current);
		current = path.dirname(current);
	}

	return dirs.reverse(); // farthest first
}

/** Recursively find context files in subdirectories */
function findSubdirContextFiles(baseDir: string, maxDepth: number = 5): string[] {
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
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				const subdir = path.join(dir, entry.name);

				// Check for context files in this subdirectory
				for (const name of CONTEXT_FILENAMES) {
					const filepath = path.join(subdir, name);
					if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
						results.push(filepath);
					}
				}

				walk(subdir, depth + 1);
			}
		}
	}

	walk(baseDir, 0);
	return results;
}

/**
 * Determine which files pi natively loaded.
 *
 * Pi loads AGENTS.md OR CLAUDE.md (preferring AGENTS.md) from:
 *   - ~/.tallow/
 *   - parent directories (walking up)
 *   - cwd
 *
 * We load everything pi missed.
 */
function collectMissingFiles(cwd: string): ContextFile[] {
	const files: ContextFile[] = [];
	const globalDir = path.join(os.homedir(), ".tallow");

	// --- Global level ---
	// If pi loaded ~/.tallow/AGENTS.md, we pick up CLAUDE.md (and vice versa)
	const globalContextFiles = findContextFiles(globalDir);
	const piLoadedGlobalAgents = fs.existsSync(path.join(globalDir, "AGENTS.md"));
	const piLoadedGlobalClaude =
		!piLoadedGlobalAgents && fs.existsSync(path.join(globalDir, "CLAUDE.md"));

	for (const filepath of globalContextFiles) {
		const basename = path.basename(filepath);
		// Skip the one pi already loaded
		if (piLoadedGlobalAgents && basename === "AGENTS.md") continue;
		if (piLoadedGlobalClaude && basename === "CLAUDE.md") continue;

		const content = readFileSafe(filepath);
		if (content) {
			files.push({ filepath, content, source: "global", depth: 0 });
		}
	}

	// --- Ancestor directories ---
	const ancestors = getAncestorDirs(cwd);
	for (const dir of ancestors) {
		const dirFiles = findContextFiles(dir);
		const hasAgents = dirFiles.some((f) => path.basename(f) === "AGENTS.md");

		for (const filepath of dirFiles) {
			const basename = path.basename(filepath);
			// Pi loaded AGENTS.md from this dir, so pick up CLAUDE.md
			if (hasAgents && basename === "AGENTS.md") continue;
			// Pi loaded CLAUDE.md (no AGENTS.md existed), so nothing to add
			if (!hasAgents && basename === "CLAUDE.md") continue;

			const content = readFileSafe(filepath);
			if (content) {
				const depth = filepath.split(path.sep).length;
				files.push({ filepath, content, source: "ancestor", depth });
			}
		}
	}

	// --- CWD ---
	const cwdFiles = findContextFiles(cwd);
	const cwdHasAgents = cwdFiles.some((f) => path.basename(f) === "AGENTS.md");

	for (const filepath of cwdFiles) {
		const basename = path.basename(filepath);
		if (cwdHasAgents && basename === "AGENTS.md") continue;
		if (!cwdHasAgents && basename === "CLAUDE.md") continue;

		const content = readFileSafe(filepath);
		if (content) {
			files.push({ filepath, content, source: "cwd", depth: filepath.split(path.sep).length });
		}
	}

	// --- Subdirectories (pi doesn't walk down at all) ---
	const subdirFiles = findSubdirContextFiles(cwd);
	for (const filepath of subdirFiles) {
		const content = readFileSafe(filepath);
		if (content) {
			const depth = filepath.split(path.sep).length;
			files.push({ filepath, content, source: "subdirectory", depth });
		}
	}

	return files;
}

function readFileSafe(filepath: string): string | null {
	try {
		const content = fs.readFileSync(filepath, "utf-8").trim();
		return content.length > 0 ? content : null;
	} catch {
		return null;
	}
}

function shortenPath(filepath: string): string {
	const home = os.homedir();
	return filepath.startsWith(home) ? filepath.replace(home, "~") : filepath;
}

export default function contextFilesExtension(pi: ExtensionAPI) {
	let contextFiles: readonly ContextFile[] = [];

	pi.on("session_start", async (_event, ctx) => {
		contextFiles = collectMissingFiles(ctx.cwd);

		if (contextFiles.length > 0) {
			const label = contextFiles.length === 1 ? "context file" : "context files";
			const paths = contextFiles.map((f) => shortenPath(f.filepath)).join(", ");
			ctx.ui.notify(`context-files: +${contextFiles.length} ${label}: ${paths}`, "info");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (contextFiles.length === 0) return;

		const sections = contextFiles.map((f) => {
			const rel = shortenPath(f.filepath);
			return `## ${rel}\n\n${f.content}`;
		});

		return {
			systemPrompt: `${event.systemPrompt}\n\n# Additional Project Context\n\n${sections.join("\n\n---\n\n")}`,
		};
	});
}
