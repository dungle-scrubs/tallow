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
	readonly source: "global" | "ancestor" | "cwd" | "subdirectory" | "additional";
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

	// --- Rules directories (.tallow/rules/, .claude/rules/) ---
	const rulesDirs = [
		path.join(cwd, ".tallow", "rules"),
		path.join(cwd, ".claude", "rules"),
		path.join(globalDir, "rules"),
	];
	for (const rulesDir of rulesDirs) {
		for (const filepath of findRuleFiles(rulesDir)) {
			const content = readFileSafe(filepath);
			if (content) {
				files.push({ filepath, content, source: "cwd", depth: 0 });
			}
		}
	}

	return files;
}

/**
 * Find markdown/text rule files in a rules directory (non-recursive).
 *
 * @param dir - Rules directory to scan
 * @returns Array of file paths (sorted alphabetically for deterministic order)
 */
function findRuleFiles(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter((name) => /\.(md|txt)$/i.test(name))
			.sort()
			.map((name) => path.join(dir, name));
	} catch {
		return []; // Directory doesn't exist
	}
}

function readFileSafe(filepath: string): string | null {
	try {
		const content = fs.readFileSync(filepath, "utf-8").trim();
		return content.length > 0 ? content : null;
	} catch {
		return null;
	}
}

// ─── @import directive support ───────────────────────────────────────────────

/** File extensions that are never inlined (binary or large). */
const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".svg",
	".woff",
	".woff2",
	".ttf",
	".eot",
	".zip",
	".tar",
	".gz",
	".bz2",
	".7z",
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".exe",
	".dll",
	".so",
	".dylib",
	".mp3",
	".mp4",
	".wav",
	".avi",
	".mov",
	".db",
	".sqlite",
	".sqlite3",
]);

/**
 * Regex matching an `@import` directive on its own line.
 * Captures the path after `@`. Supports:
 *   - `@./relative/path.md`
 *   - `@path/to/file.md`
 *   - `@~/home-relative.md`
 *   - `@/absolute/path.md`
 */
const IMPORT_DIRECTIVE_RE = /^@((?:~\/|\.\/|\.\.\/|\/)\S+|\S+\.\w+)$/;

/** Maximum import depth to prevent infinite recursion. */
const MAX_IMPORT_DEPTH = 10;

/**
 * Process `@path/to/file.md` import directives in context file content.
 *
 * Replaces directive lines with the referenced file's content, resolving
 * relative paths from the source file's directory and `@~/` from home.
 * Circular imports and binary files are skipped with inline comments.
 *
 * @param content - File content to process
 * @param baseDir - Directory to resolve relative paths from
 * @param seen - Set of already-visited absolute paths (circular guard)
 * @param depth - Current recursion depth
 * @returns Content with imports inlined
 */
export function resolveImports(
	content: string,
	baseDir: string,
	seen: Set<string> = new Set(),
	depth = 0
): string {
	if (depth > MAX_IMPORT_DEPTH) return content;

	const lines = content.split("\n");
	const result: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		const match = trimmed.match(IMPORT_DIRECTIVE_RE);

		if (!match) {
			result.push(line);
			continue;
		}

		let importPath = match[1];
		if (importPath.startsWith("~/")) {
			importPath = path.join(os.homedir(), importPath.slice(2));
		} else if (!path.isAbsolute(importPath)) {
			importPath = path.resolve(baseDir, importPath);
		}

		const resolved = path.resolve(importPath);

		// Guard: circular import
		if (seen.has(resolved)) {
			result.push(`<!-- Circular import skipped: ${importPath} -->`);
			continue;
		}

		// Guard: binary file
		const ext = path.extname(resolved).toLowerCase();
		if (BINARY_EXTENSIONS.has(ext)) {
			result.push(`<!-- Binary file skipped: ${importPath} -->`);
			continue;
		}

		const imported = readFileSafe(resolved);
		if (imported === null) {
			result.push(`<!-- Import not found: ${importPath} -->`);
			continue;
		}

		seen.add(resolved);
		const processed = resolveImports(imported, path.dirname(resolved), seen, depth + 1);
		result.push(processed);
	}

	return result.join("\n");
}

function shortenPath(filepath: string): string {
	const home = os.homedir();
	return filepath.startsWith(home) ? filepath.replace(home, "~") : filepath;
}

/**
 * Resolve a user-provided directory path, expanding `~` and resolving relative paths.
 *
 * @param input - Raw path string from user input
 * @returns Resolved absolute path
 */
function resolveDirPath(input: string): string {
	if (input.startsWith("~/")) {
		return path.resolve(os.homedir(), input.slice(2));
	}
	return path.resolve(input);
}

/**
 * Discover context files from an additional directory using the same
 * subdirectory walk rules as the primary cwd scan.
 *
 * @param dir - Absolute path to the additional directory
 * @returns Context files found in the directory and its subdirectories
 */
function collectFromAdditionalDir(dir: string): ContextFile[] {
	const files: ContextFile[] = [];

	// Direct context files in the directory root
	for (const filepath of findContextFiles(dir)) {
		const content = readFileSafe(filepath);
		if (content) {
			files.push({
				filepath,
				content,
				source: "additional",
				depth: filepath.split(path.sep).length,
			});
		}
	}

	// Subdirectory walk (same rules as cwd subdirectories)
	for (const filepath of findSubdirContextFiles(dir)) {
		const content = readFileSafe(filepath);
		if (content) {
			files.push({
				filepath,
				content,
				source: "additional",
				depth: filepath.split(path.sep).length,
			});
		}
	}

	return files;
}

export default function contextFilesExtension(pi: ExtensionAPI) {
	let contextFiles: ContextFile[] = [];
	const additionalDirs: Set<string> = new Set();

	/**
	 * Re-scan all additional directories and merge results into contextFiles.
	 * Preserves original cwd-based files and appends additional dir files
	 * sorted alphabetically by directory path for deterministic order.
	 *
	 * @param cwdFiles - Context files from the primary cwd scan
	 * @returns Merged array with additional directory files appended
	 */
	function mergeAdditionalDirFiles(cwdFiles: ContextFile[]): ContextFile[] {
		if (additionalDirs.size === 0) return cwdFiles;

		const additionalFiles: ContextFile[] = [];
		const seen = new Set(cwdFiles.map((f) => path.resolve(f.filepath)));

		for (const dir of [...additionalDirs].sort()) {
			for (const file of collectFromAdditionalDir(dir)) {
				const resolved = path.resolve(file.filepath);
				if (!seen.has(resolved)) {
					seen.add(resolved);
					additionalFiles.push(file);
				}
			}
		}

		return [...cwdFiles, ...additionalFiles];
	}

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
			const processed = resolveImports(f.content, path.dirname(f.filepath));
			return `## ${rel}\n\n${processed}`;
		});

		return {
			systemPrompt: `${event.systemPrompt}\n\n# Additional Project Context\n\n${sections.join("\n\n---\n\n")}`,
		};
	});

	pi.registerCommand("add-dir", {
		description: "Add an additional directory for context file discovery",
		handler: async (args, ctx) => {
			const input = args.trim();

			// No args → list current additional directories
			if (!input) {
				if (additionalDirs.size === 0) {
					ctx.ui.notify("No additional directories registered.", "info");
					return;
				}

				const lines = [...additionalDirs].sort().map((dir) => {
					const files = collectFromAdditionalDir(dir);
					const count = files.length;
					const label = count === 1 ? "file" : "files";
					return `  ${shortenPath(dir)} (${count} ${label})`;
				});
				ctx.ui.notify(`Additional directories:\n${lines.join("\n")}`, "info");
				return;
			}

			const resolved = resolveDirPath(input);

			// Validate: exists and is a directory
			if (!fs.existsSync(resolved)) {
				ctx.ui.notify(`Directory not found: ${shortenPath(resolved)}`, "error");
				return;
			}
			if (!fs.statSync(resolved).isDirectory()) {
				ctx.ui.notify(`Not a directory: ${shortenPath(resolved)}`, "error");
				return;
			}

			// Deduplicate
			if (additionalDirs.has(resolved)) {
				ctx.ui.notify(`Already added: ${shortenPath(resolved)}`, "warning");
				return;
			}

			additionalDirs.add(resolved);

			// Re-scan: rebuild contextFiles with the new additional dir included
			const cwdBaseFiles = collectMissingFiles(ctx.cwd);
			const newFiles = collectFromAdditionalDir(resolved);
			contextFiles = mergeAdditionalDirFiles(cwdBaseFiles);

			if (newFiles.length > 0) {
				const label = newFiles.length === 1 ? "file" : "files";
				const paths = newFiles.map((f) => shortenPath(f.filepath)).join(", ");
				ctx.ui.notify(
					`context-files: +${newFiles.length} ${label} from ${shortenPath(resolved)}: ${paths}`,
					"info"
				);
			} else {
				ctx.ui.notify(`Added ${shortenPath(resolved)} (no context files found)`, "info");
			}
		},
	});

	pi.registerCommand("clear-dirs", {
		description: "Remove all additional context directories",
		handler: async (_args, ctx) => {
			if (additionalDirs.size === 0) {
				ctx.ui.notify("No additional directories to clear.", "info");
				return;
			}

			const count = additionalDirs.size;
			additionalDirs.clear();

			// Rebuild contextFiles without additional dirs
			contextFiles = collectMissingFiles(ctx.cwd);

			const label = count === 1 ? "directory" : "directories";
			ctx.ui.notify(`Cleared ${count} additional ${label}.`, "info");
		},
	});
}
