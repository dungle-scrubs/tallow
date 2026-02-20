/**
 * Claude Bridge Extension
 *
 * Bridges .claude/ directories so tallow discovers Claude Code resources.
 * Hooks `resources_discover` to inject .claude/skills/ paths into the
 * pi framework's skill loader, making them available in both the system
 * prompt and /skill-name commands.
 *
 * Agent and command bridging is handled directly by the subagent-tool,
 * agent-commands-tool, and command-prompt extensions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CLAUDE_DIR = ".claude";
/** Project-level config directories (current + legacy) */
const PROJECT_CONFIG_DIRS = [".tallow", ".pi"];

/**
 * Expand ~ prefix to the user's home directory.
 *
 * @param p - Path string that may start with ~
 * @returns Resolved absolute path
 */
function expandTilde(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * List subdirectory names inside a directory (non-hidden only).
 *
 * @param dir - Directory to scan
 * @returns Array of subdirectory names
 */
function listSubdirNames(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => e.name);
	} catch {
		return [];
	}
}

/**
 * Read the packages array from a settings.json file.
 *
 * @param settingsPath - Absolute path to settings.json
 * @returns Array of package path strings (unexpanded)
 */
function readPackages(settingsPath: string): string[] {
	try {
		const content = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return Array.isArray(content.packages) ? content.packages : [];
	} catch {
		return [];
	}
}

/**
 * Collect all known skill names from tallow's skill sources:
 * user dir, project dir, and packages referenced in settings.
 *
 * This enables collision detection against skills from tallow packages
 * (e.g. ~/dev/tallow-plugins/fuse/skills/database), not just the
 * agent home skills directory.
 *
 * @param agentDir - Tallow home directory (e.g. ~/.tallow-fuse)
 * @param cwd - Current working directory
 * @returns Set of skill directory names already managed by tallow
 */
export function collectKnownSkillNames(agentDir: string, cwd: string): Set<string> {
	const names = new Set<string>();

	// User-level skills (agentDir/skills/)
	for (const name of listSubdirNames(path.join(agentDir, "skills"))) {
		names.add(name);
	}

	// Project-level skills (cwd/.tallow/skills/, cwd/.pi/skills/)
	for (const configDir of PROJECT_CONFIG_DIRS) {
		for (const name of listSubdirNames(path.join(cwd, configDir, "skills"))) {
			names.add(name);
		}
	}

	// Package skills (global + project settings)
	const settingsPaths = [
		path.join(agentDir, "settings.json"),
		...PROJECT_CONFIG_DIRS.map((d) => path.join(cwd, d, "settings.json")),
	];

	const allPackages = new Set<string>();
	for (const sp of settingsPaths) {
		for (const pkg of readPackages(sp)) {
			allPackages.add(expandTilde(pkg));
		}
	}

	for (const pkg of allPackages) {
		for (const name of listSubdirNames(path.join(pkg, "skills"))) {
			names.add(name);
		}
	}

	return names;
}

/**
 * Enumerates skill subdirectories in a .claude/skills/ parent,
 * filtering out entries whose names appear in knownSkillNames.
 *
 * Returns SKILL.md file paths (not directories) when possible to avoid
 * the framework picking up auxiliary .md files (e.g. reference.md).
 *
 * @param claudeSkillsDir - Parent .claude/skills/ directory
 * @param knownSkillNames - Set of skill names already managed by tallow
 * @returns SKILL.md file paths (or directory fallback) for non-colliding entries
 */
export function getNonCollidingSkillPaths(
	claudeSkillsDir: string,
	knownSkillNames: ReadonlySet<string>
): string[] {
	const paths: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true });
	} catch {
		return paths;
	}

	const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of sortedEntries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (knownSkillNames.has(entry.name)) continue;

		// Prefer SKILL.md file path over directory to avoid picking up
		// auxiliary .md files (e.g. reference.md) in the same directory
		const skillFile = path.join(claudeSkillsDir, entry.name, "SKILL.md");
		if (fs.existsSync(skillFile)) {
			paths.push(skillFile);
		} else {
			paths.push(path.join(claudeSkillsDir, entry.name));
		}
	}
	return paths;
}

/**
 * Registers a resources_discover handler that adds .claude/skills/
 * to the framework's skill loading paths.
 *
 * Filters out skill directories that collide with tallow-managed skills
 * (from user dir, project dir, and packages) to avoid noisy diagnostics.
 * Returns SKILL.md file paths instead of directories to prevent auxiliary
 * .md files from being parsed as skills.
 *
 * @param pi - Extension API
 */
export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", async (event) => {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".tallow");
		const cwd = (event as { cwd: string }).cwd;
		const knownNames = collectKnownSkillNames(agentDir, cwd);

		const skillPaths: string[] = [];

		// User-level: ~/.claude/skills/
		const userClaudeSkills = path.join(os.homedir(), CLAUDE_DIR, "skills");
		if (fs.existsSync(userClaudeSkills)) {
			skillPaths.push(...getNonCollidingSkillPaths(userClaudeSkills, knownNames));
		}

		// Project-level: cwd/.claude/skills/
		const projectClaudeSkills = path.resolve(cwd, CLAUDE_DIR, "skills");
		if (fs.existsSync(projectClaudeSkills)) {
			skillPaths.push(...getNonCollidingSkillPaths(projectClaudeSkills, knownNames));
		}

		if (skillPaths.length === 0) return;
		return { skillPaths };
	});
}
