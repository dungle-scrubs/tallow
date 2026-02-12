/**
 * Frontmatter Index
 *
 * Pre-indexes command/skill markdown files at session start, extracting
 * `context`, `agent`, `model`, and `allowed-tools` frontmatter fields
 * into an O(1) lookup map keyed by command name.
 *
 * Scans the same directories as command-prompt:
 * - .tallow/prompts/ and .tallow/commands/ (project-local)
 * - ~/.tallow/prompts/ and ~/.tallow/commands/ (global)
 * - Package prompt/command sources from settings.json
 * - Skills via loadSkills()
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, loadSkills, parseFrontmatter } from "@mariozechner/pi-coding-agent";

/** Parsed frontmatter fields relevant to context-fork. */
export interface CommandFrontmatter {
	context?: "fork" | "inline";
	agent?: string;
	model?: string;
	allowedTools?: string[];
	filePath: string;
}

/** Map of command name → frontmatter metadata. */
export type FrontmatterIndex = Map<string, CommandFrontmatter>;

/** Raw frontmatter shape from YAML. */
interface RawFrontmatter {
	context?: string;
	agent?: string;
	model?: string;
	"allowed-tools"?: string;
	[key: string]: unknown;
}

/**
 * Parses context-fork frontmatter from a markdown file.
 *
 * @param filePath - Absolute path to the .md file
 * @returns Parsed frontmatter or undefined if file is unreadable
 */
function parseFileFrontmatter(filePath: string): CommandFrontmatter | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	let frontmatter: RawFrontmatter;
	try {
		({ frontmatter } = parseFrontmatter<RawFrontmatter>(content));
	} catch {
		// Some files have YAML the strict parser rejects (e.g., unquoted brackets).
		// Skip them — they don't have fork-related frontmatter.
		return undefined;
	}

	const context =
		frontmatter.context === "fork" || frontmatter.context === "inline"
			? frontmatter.context
			: undefined;

	const allowedTools =
		typeof frontmatter["allowed-tools"] === "string"
			? frontmatter["allowed-tools"]
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: undefined;

	return {
		context,
		agent: typeof frontmatter.agent === "string" ? frontmatter.agent : undefined,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		allowedTools,
		filePath,
	};
}

/**
 * Resolves a path that may start with ~ to an absolute path.
 *
 * @param p - Path to resolve
 * @param base - Base directory for relative paths
 * @returns Absolute path
 */
function resolvePath(p: string, base: string): string {
	const trimmed = p.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	return path.resolve(base, trimmed);
}

/**
 * Scans a directory for .md files (top-level only).
 *
 * @param dir - Directory to scan
 * @returns Array of { name, filePath } entries
 */
function scanTopLevel(dir: string): Array<{ name: string; filePath: string }> {
	const results: Array<{ name: string; filePath: string }> = [];
	if (!fs.existsSync(dir)) return results;

	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.name.endsWith(".md") || entry.name.startsWith("_")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;

			results.push({
				name: entry.name.replace(/\.md$/, ""),
				filePath: path.join(dir, entry.name),
			});
		}
	} catch {
		/* skip unreadable dir */
	}

	return results;
}

/**
 * Scans a directory for subdirectory .md files (one level deep).
 * Returns entries as dir:name.
 *
 * @param dir - Directory to scan
 * @returns Array of { name (dir:file), filePath } entries
 */
function scanNested(dir: string): Array<{ name: string; filePath: string }> {
	const results: Array<{ name: string; filePath: string }> = [];
	if (!fs.existsSync(dir)) return results;

	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_"))
				continue;

			const subdir = path.join(dir, entry.name);
			try {
				for (const file of fs.readdirSync(subdir, { withFileTypes: true })) {
					if (!file.name.endsWith(".md") || file.name.startsWith("_")) continue;
					if (!file.isFile() && !file.isSymbolicLink()) continue;

					results.push({
						name: `${entry.name}:${file.name.replace(/\.md$/, "")}`,
						filePath: path.join(subdir, file.name),
					});
				}
			} catch {
				/* skip unreadable subdir */
			}
		}
	} catch {
		/* skip unreadable dir */
	}

	return results;
}

/**
 * Gets prompt/command directory sources from settings.json packages.
 *
 * @param settingsPath - Path to settings.json
 * @returns Array of { namespace, dirs } entries
 */
function getPackageDirs(settingsPath: string): Array<{ namespace: string; dirs: string[] }> {
	const results: Array<{ namespace: string; dirs: string[] }> = [];
	if (!fs.existsSync(settingsPath)) return results;

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as {
			packages?: Array<string | { source: string }>;
		};

		const settingsDir = path.dirname(settingsPath);
		const seen = new Set<string>();

		for (const pkg of settings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("https://"))
				continue;

			const resolved = resolvePath(source, settingsDir);
			if (seen.has(resolved)) continue;
			seen.add(resolved);

			const namespace = path.basename(resolved);
			const dirs: string[] = [];

			for (const sub of ["prompts", "commands"]) {
				const d = path.join(resolved, sub);
				if (fs.existsSync(d)) dirs.push(d);
			}

			if (dirs.length > 0) {
				results.push({ namespace, dirs });
			}
		}
	} catch {
		/* skip unreadable settings */
	}

	return results;
}

/**
 * Builds the frontmatter index by scanning all prompt/command/skill directories.
 * First entry wins on name collisions (project > global > packages).
 *
 * @param debugLog - Optional debug logger
 * @returns Populated frontmatter index
 */
export function buildFrontmatterIndex(debugLog?: (msg: string) => void): FrontmatterIndex {
	const index: FrontmatterIndex = new Map();
	const debug = debugLog ?? (() => {});

	/**
	 * Adds an entry to the index if the name is not already taken and
	 * the file has relevant frontmatter (context, agent, or model).
	 */
	function maybeAdd(name: string, filePath: string): void {
		if (index.has(name)) return;

		const fm = parseFileFrontmatter(filePath);
		if (!fm) return;

		// Only index files that have at least one relevant field set
		if (!fm.context && !fm.agent && !fm.model && !fm.allowedTools) return;

		if (fm.allowedTools?.length) {
			debug(`allowed-tools on "${name}" ignored (tallow has no permission system)`);
		}

		index.set(name, fm);
	}

	const agentDir = getAgentDir();

	// Project-local prompts/commands (highest priority)
	const projectPromptsDir = path.join(process.cwd(), ".tallow", "prompts");
	const projectCommandsDir = path.join(process.cwd(), ".tallow", "commands");
	const globalPromptsDir = path.join(agentDir, "prompts");
	const globalCommandsDir = path.join(agentDir, "commands");

	// Top-level: name
	for (const dir of [projectPromptsDir, projectCommandsDir, globalPromptsDir, globalCommandsDir]) {
		for (const { name, filePath } of scanTopLevel(dir)) {
			maybeAdd(name, filePath);
		}
	}

	// Nested: dir:name
	for (const dirs of [
		[projectPromptsDir, projectCommandsDir],
		[globalPromptsDir, globalCommandsDir],
	]) {
		for (const dir of dirs) {
			for (const { name, filePath } of scanNested(dir)) {
				maybeAdd(name, filePath);
			}
		}
	}

	// Package sources: namespace:name and namespace:dir:name
	const globalSettings = path.join(agentDir, "settings.json");
	const projectSettings = path.join(process.cwd(), ".tallow", "settings.json");

	for (const settingsPath of [projectSettings, globalSettings]) {
		for (const { namespace, dirs } of getPackageDirs(settingsPath)) {
			for (const dir of dirs) {
				// Top-level: namespace:name
				for (const { name, filePath } of scanTopLevel(dir)) {
					maybeAdd(`${namespace}:${name}`, filePath);
				}
				// Nested: namespace:dir:name
				for (const { name, filePath } of scanNested(dir)) {
					maybeAdd(`${namespace}:${name}`, filePath);
				}
			}
		}
	}

	// Skills: skill name as-is
	try {
		const { skills } = loadSkills();
		for (const skill of skills) {
			maybeAdd(skill.name, skill.filePath);
		}
	} catch {
		debug("Failed to load skills for frontmatter indexing");
	}

	debug(`frontmatter-index: indexed ${index.size} commands with fork/agent/model metadata`);
	return index;
}
