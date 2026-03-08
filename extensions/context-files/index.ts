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
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { createLazyInitializer } from "../_shared/lazy-init.js";
import { isProjectTrusted } from "../_shared/project-trust.js";
import { getTallowHomeDir } from "../_shared/tallow-paths.js";

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

interface ScopedRuleFile extends ContextFile {
	readonly patterns: readonly string[];
}

interface DiscoveryResult {
	readonly contextFiles: ContextFile[];
	readonly scopedRuleFiles: ScopedRuleFile[];
	readonly warnings: string[];
}

interface RuleFrontmatter {
	readonly path?: unknown;
	readonly paths?: unknown;
	readonly [key: string]: unknown;
}

interface ParsedRuleMetadata {
	readonly content: string;
	readonly patterns?: readonly string[];
	readonly warning?: string;
}

const RULE_TRIGGER_TOOLS = new Set(["read", "edit", "write"]);

/**
 * Read and alphabetically sort a directory's entries for deterministic traversal.
 *
 * @param dir - Directory path to scan
 * @returns Sorted directory entries, or an empty array when unreadable
 */
function getSortedDirEntries(dir: string): fs.Dirent[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
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

		for (const entry of getSortedDirEntries(dir)) {
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
 * Recursively find rule files in subdirectory .tallow/rules/ and .claude/rules/ dirs.
 *
 * Walks subdirectories using the same skip-list and depth limits as
 * findSubdirContextFiles. For each non-skipped subdirectory, peeks into
 * .tallow/rules/ and .claude/rules/ within it.
 *
 * @param baseDir - Root directory to start walking from
 * @param maxDepth - Maximum directory depth to traverse (default: 5)
 * @returns Array of absolute file paths to rule files found
 */
function findSubdirRuleFiles(baseDir: string, maxDepth: number = 5): string[] {
	const results: string[] = [];

	function walk(dir: string, depth: number): void {
		if (depth > maxDepth) return;

		for (const entry of getSortedDirEntries(dir)) {
			if (!entry.isDirectory()) continue;
			if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;

			const subdir = path.join(dir, entry.name);

			for (const filepath of findRuleFiles(path.join(subdir, ".tallow", "rules"))) {
				results.push(filepath);
			}
			for (const filepath of findRuleFiles(path.join(subdir, ".claude", "rules"))) {
				results.push(filepath);
			}

			walk(subdir, depth + 1);
		}
	}

	walk(baseDir, 0);
	return results;
}

/**
 * Normalize a path string to POSIX separators.
 *
 * @param value - Path to normalize
 * @returns Path using `/` separators
 */
function toPosixPath(value: string): string {
	return value.replace(/\\/g, "/");
}

/**
 * Determine whether a file is a modular rule file from .tallow/.claude rules dirs.
 *
 * @param filepath - Absolute or relative file path
 * @returns True when the path points into `.tallow/rules` or `.claude/rules`
 */
function isRuleFile(filepath: string): boolean {
	const normalized = toPosixPath(path.resolve(filepath));
	return normalized.includes("/.tallow/rules/") || normalized.includes("/.claude/rules/");
}

/**
 * Normalize a single rule glob pattern.
 *
 * @param pattern - Raw glob pattern from frontmatter
 * @returns Normalized pattern with POSIX separators and no `./` prefix
 */
function normalizeRulePattern(pattern: string): string {
	const trimmed = pattern.trim();
	const withoutDotPrefix = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
	return toPosixPath(withoutDotPrefix);
}

/**
 * Parse and normalize `path`/`paths` frontmatter into a deterministic pattern list.
 *
 * @param value - Raw frontmatter value for `path` or `paths`
 * @returns Normalized pattern array, or null when invalid
 */
function normalizeRulePatterns(value: unknown): readonly string[] | null {
	const rawPatterns: unknown[] =
		typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	if (rawPatterns.length === 0) return null;

	const patterns: string[] = [];
	for (const rawPattern of rawPatterns) {
		if (typeof rawPattern !== "string") {
			return null;
		}
		const normalized = normalizeRulePattern(rawPattern);
		if (normalized.length === 0) {
			return null;
		}
		patterns.push(normalized);
	}

	return [...new Set(patterns)];
}

/**
 * Parse rule frontmatter and derive optional path-scoping metadata.
 *
 * Invalid frontmatter does not fail discovery. Rules fall back to unconditional
 * behavior and emit a warning for deterministic compatibility.
 *
 * @param content - Raw rule file content
 * @param filepath - Rule file path for warning context
 * @returns Parsed rule body, optional patterns, and optional warning
 */
function parseRuleMetadata(content: string, filepath: string): ParsedRuleMetadata {
	try {
		const { frontmatter, body } = parseFrontmatter<RuleFrontmatter>(content);
		const rawPatterns = frontmatter.paths ?? frontmatter.path;
		if (rawPatterns === undefined) {
			return { content: body };
		}

		const patterns = normalizeRulePatterns(rawPatterns);
		if (!patterns) {
			return {
				content: body,
				warning:
					`context-files: invalid path frontmatter in ${shortenPath(filepath)}; ` +
					"expected `path` (string) or `paths` (string|string[]). " +
					"Falling back to unconditional rule.",
			};
		}

		return {
			content: body,
			patterns,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content,
			warning:
				`context-files: failed to parse frontmatter in ${shortenPath(filepath)}: ${message}. ` +
				"Falling back to unconditional rule.",
		};
	}
}

/**
 * Add a discovered file to unconditional context or scoped rules, depending on metadata.
 *
 * @param contextFiles - Mutable unconditional context file accumulator
 * @param scopedRuleFiles - Mutable scoped rule accumulator
 * @param warnings - Mutable warning accumulator
 * @param file - Discovered file candidate
 * @returns Nothing
 */
function addDiscoveredFile(
	contextFiles: ContextFile[],
	scopedRuleFiles: ScopedRuleFile[],
	warnings: string[],
	file: ContextFile
): void {
	if (!isRuleFile(file.filepath)) {
		contextFiles.push(file);
		return;
	}

	const parsed = parseRuleMetadata(file.content, file.filepath);
	if (parsed.warning) {
		warnings.push(parsed.warning);
	}

	if (parsed.patterns) {
		scopedRuleFiles.push({ ...file, content: parsed.content, patterns: parsed.patterns });
		return;
	}

	contextFiles.push({ ...file, content: parsed.content });
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
 *
 * @param cwd - Current working directory
 * @returns Discovered unconditional context files, scoped rules, and warnings
 */
function collectMissingFiles(cwd: string): DiscoveryResult {
	const contextFiles: ContextFile[] = [];
	const scopedRuleFiles: ScopedRuleFile[] = [];
	const warnings: string[] = [];
	const globalDir = getTallowHomeDir();
	const allowProjectRules = isProjectTrusted(cwd);

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
			contextFiles.push({ filepath, content, source: "global", depth: 0 });
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
				contextFiles.push({ filepath, content, source: "ancestor", depth });
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
			contextFiles.push({
				filepath,
				content,
				source: "cwd",
				depth: filepath.split(path.sep).length,
			});
		}
	}

	// --- Subdirectories (pi doesn't walk down at all) ---
	const subdirFiles = findSubdirContextFiles(cwd);
	for (const filepath of subdirFiles) {
		const content = readFileSafe(filepath);
		if (content) {
			const depth = filepath.split(path.sep).length;
			contextFiles.push({ filepath, content, source: "subdirectory", depth });
		}
	}

	// --- Rules directories (.tallow/rules/, .claude/rules/) ---
	const rulesDirs = allowProjectRules
		? [
				path.join(cwd, ".tallow", "rules"),
				path.join(cwd, ".claude", "rules"),
				path.join(globalDir, "rules"),
			]
		: [path.join(globalDir, "rules")];
	for (const rulesDir of rulesDirs) {
		for (const filepath of findRuleFiles(rulesDir)) {
			const content = readFileSafe(filepath);
			if (content) {
				addDiscoveredFile(contextFiles, scopedRuleFiles, warnings, {
					filepath,
					content,
					source: "cwd",
					depth: 0,
				});
			}
		}
	}

	// --- Subdirectory rules (nested .tallow/rules/ and .claude/rules/) ---
	if (allowProjectRules) {
		for (const filepath of findSubdirRuleFiles(cwd)) {
			const content = readFileSafe(filepath);
			if (content) {
				addDiscoveredFile(contextFiles, scopedRuleFiles, warnings, {
					filepath,
					content,
					source: "subdirectory",
					depth: filepath.split(path.sep).length,
				});
			}
		}
	}

	return { contextFiles, scopedRuleFiles, warnings };
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

/**
 * Convert unknown thrown values into a display-safe message.
 *
 * @param error - Unknown thrown value
 * @returns Error message string
 */
function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
 * @returns Unconditional context files, scoped rules, and warnings
 */
function collectFromAdditionalDir(dir: string): DiscoveryResult {
	const contextFiles: ContextFile[] = [];
	const scopedRuleFiles: ScopedRuleFile[] = [];
	const warnings: string[] = [];

	// Direct context files in the directory root
	for (const filepath of findContextFiles(dir)) {
		const content = readFileSafe(filepath);
		if (content) {
			contextFiles.push({
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
			contextFiles.push({
				filepath,
				content,
				source: "additional",
				depth: filepath.split(path.sep).length,
			});
		}
	}

	// Subdirectory rules in additional dirs
	for (const filepath of findSubdirRuleFiles(dir)) {
		const content = readFileSafe(filepath);
		if (content) {
			addDiscoveredFile(contextFiles, scopedRuleFiles, warnings, {
				filepath,
				content,
				source: "additional",
				depth: filepath.split(path.sep).length,
			});
		}
	}

	return { contextFiles, scopedRuleFiles, warnings };
}

export default function contextFilesExtension(pi: ExtensionAPI) {
	let contextFiles: ContextFile[] = [];
	let cwdContextFiles: ContextFile[] = [];
	let scopedRuleFiles: ScopedRuleFile[] = [];
	let cwdScopedRuleFiles: ScopedRuleFile[] = [];
	let cwdWarnings: string[] = [];
	let discoveryWarnings: string[] = [];
	const activeScopedRuleFiles: Set<string> = new Set();
	const additionalDirs: Set<string> = new Set();

	/**
	 * Re-scan all additional directories and merge results into discovered files.
	 * Preserves original cwd-based ordering and appends additional-dir files in
	 * sorted directory order for deterministic prompts.
	 *
	 * @param baseContextFiles - Context files from primary cwd scan
	 * @param baseScopedRuleFiles - Scoped rule files from primary cwd scan
	 * @returns Merged discovery result
	 */
	function mergeAdditionalDirFiles(
		baseContextFiles: ContextFile[],
		baseScopedRuleFiles: ScopedRuleFile[]
	): DiscoveryResult {
		if (additionalDirs.size === 0) {
			return {
				contextFiles: [...baseContextFiles],
				scopedRuleFiles: [...baseScopedRuleFiles],
				warnings: [],
			};
		}

		const mergedContextFiles = [...baseContextFiles];
		const mergedScopedRuleFiles = [...baseScopedRuleFiles];
		const warnings: string[] = [];
		const seen = new Set([
			...baseContextFiles.map((file) => path.resolve(file.filepath)),
			...baseScopedRuleFiles.map((file) => path.resolve(file.filepath)),
		]);

		for (const dir of [...additionalDirs].sort()) {
			const discovered = collectFromAdditionalDir(dir);
			warnings.push(...discovered.warnings);

			for (const file of discovered.contextFiles) {
				const resolved = path.resolve(file.filepath);
				if (seen.has(resolved)) continue;
				seen.add(resolved);
				mergedContextFiles.push(file);
			}

			for (const file of discovered.scopedRuleFiles) {
				const resolved = path.resolve(file.filepath);
				if (seen.has(resolved)) continue;
				seen.add(resolved);
				mergedScopedRuleFiles.push(file);
			}
		}

		return {
			contextFiles: mergedContextFiles,
			scopedRuleFiles: mergedScopedRuleFiles,
			warnings,
		};
	}

	/**
	 * Set extension discovery caches for cwd + additional directories.
	 *
	 * @param baseContextFiles - Files discovered from primary cwd scan
	 * @param baseScopedRuleFiles - Scoped rule files discovered from primary cwd scan
	 * @param baseWarnings - Warnings produced by primary cwd discovery
	 * @returns Nothing
	 */
	function setDiscoveredFiles(
		baseContextFiles: ContextFile[],
		baseScopedRuleFiles: ScopedRuleFile[],
		baseWarnings: string[]
	): void {
		cwdContextFiles = [...baseContextFiles];
		cwdScopedRuleFiles = [...baseScopedRuleFiles];
		cwdWarnings = [...baseWarnings];

		const merged = mergeAdditionalDirFiles(cwdContextFiles, cwdScopedRuleFiles);
		contextFiles = merged.contextFiles;
		scopedRuleFiles = merged.scopedRuleFiles;
		discoveryWarnings = [...cwdWarnings, ...merged.warnings];

		const discoveredRuleIds = new Set(scopedRuleFiles.map((file) => path.resolve(file.filepath)));
		for (const activeRuleId of [...activeScopedRuleFiles]) {
			if (!discoveredRuleIds.has(activeRuleId)) {
				activeScopedRuleFiles.delete(activeRuleId);
			}
		}
	}

	/**
	 * Show warnings emitted while parsing rule frontmatter.
	 *
	 * @param ctx - Extension context used for UI notifications
	 * @param warnings - Warning messages to emit
	 * @returns Nothing
	 */
	function notifyRuleWarnings(ctx: ExtensionContext, warnings: readonly string[]): void {
		for (const warning of [...new Set(warnings)]) {
			ctx.ui.notify(warning, "warning");
		}
	}

	/**
	 * Notify the user about discovered context/rule files.
	 *
	 * @param ctx - Extension context used for UI notifications
	 * @returns Nothing
	 */
	function notifyDiscoveredContextFiles(ctx: ExtensionContext): void {
		const discoveredFiles = [...contextFiles, ...scopedRuleFiles];
		if (discoveredFiles.length === 0) return;

		const label = discoveredFiles.length === 1 ? "context file" : "context files";
		const paths = discoveredFiles.map((file) => shortenPath(file.filepath)).join(", ");
		ctx.ui.notify(`context-files: +${discoveredFiles.length} ${label}: ${paths}`, "info");
	}

	/**
	 * Build the ordered file list to inject into the system prompt.
	 *
	 * Includes all unconditional context files and currently-activated scoped rules.
	 *
	 * @returns Files to include in prompt augmentation
	 */
	function getPromptFiles(): ContextFile[] {
		if (activeScopedRuleFiles.size === 0) {
			return contextFiles;
		}

		const activeRules = scopedRuleFiles.filter((file) =>
			activeScopedRuleFiles.has(path.resolve(file.filepath))
		);
		return [...contextFiles, ...activeRules];
	}

	/**
	 * Resolve a tool-observed file path to a cwd-relative POSIX path for matching.
	 *
	 * @param cwd - Current working directory
	 * @param observedPath - Raw path from tool input
	 * @returns Normalized relative path, or null when path is outside cwd
	 */
	function normalizeObservedToolPath(cwd: string, observedPath: string): string | null {
		const resolved = path.resolve(cwd, observedPath);
		const relative = path.relative(cwd, resolved);
		if (relative.length === 0) {
			return ".";
		}
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			return null;
		}
		return toPosixPath(relative);
	}

	/**
	 * Check whether a normalized relative path matches a rule glob pattern.
	 *
	 * @param relativePath - Cwd-relative POSIX path
	 * @param pattern - Normalized rule pattern from frontmatter
	 * @returns True when the path matches
	 */
	function matchesRulePattern(relativePath: string, pattern: string): boolean {
		const candidate = pattern.startsWith("/") ? `/${relativePath}` : relativePath;
		return path.posix.matchesGlob(candidate, pattern);
	}

	/**
	 * Activate scoped rules that match an observed file path.
	 *
	 * @param relativePath - Cwd-relative POSIX file path
	 * @returns Newly activated scoped rules in discovery order
	 */
	function activateScopedRules(relativePath: string): ScopedRuleFile[] {
		const activated: ScopedRuleFile[] = [];

		for (const ruleFile of scopedRuleFiles) {
			const ruleId = path.resolve(ruleFile.filepath);
			if (activeScopedRuleFiles.has(ruleId)) continue;

			const isMatch = ruleFile.patterns.some((pattern) =>
				matchesRulePattern(relativePath, pattern)
			);
			if (!isMatch) continue;

			activeScopedRuleFiles.add(ruleId);
			activated.push(ruleFile);
		}

		return activated;
	}

	/**
	 * Extract candidate file paths from a tool input payload.
	 *
	 * @param input - Tool input payload
	 * @returns Candidate file paths to evaluate
	 */
	function getToolInputPaths(input: Record<string, unknown>): string[] {
		const inputPath = input.path;
		if (typeof inputPath === "string") return [inputPath];
		if (Array.isArray(inputPath)) {
			return inputPath.filter((value): value is string => typeof value === "string");
		}
		return [];
	}

	const lazyScan = createLazyInitializer<ExtensionContext>({
		name: "context-files",
		initialize: async ({ context }) => {
			const discovered = collectMissingFiles(context.cwd);
			setDiscoveredFiles(discovered.contextFiles, discovered.scopedRuleFiles, discovered.warnings);
			notifyDiscoveredContextFiles(context);
			notifyRuleWarnings(context, discoveryWarnings);
		},
	});

	/**
	 * Ensure context file discovery has completed before using cached files.
	 *
	 * @param trigger - Trigger name passed to lazy-init instrumentation
	 * @param ctx - Current extension context
	 * @returns True when scanning succeeded
	 */
	async function ensureScanReady(trigger: string, ctx: ExtensionContext): Promise<boolean> {
		try {
			await lazyScan.ensureInitialized({ trigger, context: ctx });
			return true;
		} catch (error) {
			const message = getErrorMessage(error);
			ctx.ui.notify(`context-files: failed to discover context files: ${message}`, "error");
			return false;
		}
	}

	/**
	 * Reset all session-scoped discovery and activation state.
	 *
	 * @returns Nothing
	 */
	function resetSessionState(): void {
		contextFiles = [];
		cwdContextFiles = [];
		scopedRuleFiles = [];
		cwdScopedRuleFiles = [];
		cwdWarnings = [];
		discoveryWarnings = [];
		activeScopedRuleFiles.clear();
		lazyScan.reset();
	}

	pi.on("session_start", async () => {
		resetSessionState();
	});

	pi.on("session_before_switch", async () => {
		resetSessionState();
	});

	pi.on("session_switch", async () => {
		resetSessionState();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (!RULE_TRIGGER_TOOLS.has(event.toolName)) return;

		const scanReady = await ensureScanReady("tool_result", ctx);
		if (!scanReady || scopedRuleFiles.length === 0) return;
		if (!event.input || typeof event.input !== "object") return;

		const observedPaths = getToolInputPaths(event.input as Record<string, unknown>);
		if (observedPaths.length === 0) return;

		const activatedRulePaths: string[] = [];
		for (const observedPath of observedPaths) {
			const normalized = normalizeObservedToolPath(ctx.cwd, observedPath);
			if (!normalized) continue;

			for (const activatedRule of activateScopedRules(normalized)) {
				activatedRulePaths.push(shortenPath(activatedRule.filepath));
			}
		}

		if (activatedRulePaths.length === 0) return;

		const uniquePaths = [...new Set(activatedRulePaths)];
		const label = uniquePaths.length === 1 ? "rule" : "rules";
		ctx.ui.notify(
			`context-files: activated ${uniquePaths.length} scoped ${label}: ${uniquePaths.join(", ")}`,
			"info"
		);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const scanReady = await ensureScanReady("before_agent_start", ctx);
		if (!scanReady) return;

		const promptFiles = getPromptFiles();
		if (promptFiles.length === 0) return;

		const sections = promptFiles.map((file) => {
			const rel = shortenPath(file.filepath);
			const processed = resolveImports(file.content, path.dirname(file.filepath));
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
					const discovered = collectFromAdditionalDir(dir);
					const count = discovered.contextFiles.length + discovered.scopedRuleFiles.length;
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

			if (lazyScan.isInitialized()) {
				setDiscoveredFiles(cwdContextFiles, cwdScopedRuleFiles, cwdWarnings);
			}

			const discovered = collectFromAdditionalDir(resolved);
			notifyRuleWarnings(ctx, discovered.warnings);

			const newFiles = [...discovered.contextFiles, ...discovered.scopedRuleFiles];
			if (newFiles.length > 0) {
				const label = newFiles.length === 1 ? "file" : "files";
				const paths = newFiles.map((file) => shortenPath(file.filepath)).join(", ");
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

			if (lazyScan.isInitialized()) {
				setDiscoveredFiles(cwdContextFiles, cwdScopedRuleFiles, cwdWarnings);
			}

			const label = count === 1 ? "directory" : "directories";
			ctx.ui.notify(`Cleared ${count} additional ${label}.`, "info");
		},
	});
}
