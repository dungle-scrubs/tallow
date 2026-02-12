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

/**
 * Enumerates skill subdirectories in a .claude/skills/ parent,
 * filtering out entries that collide with tallow-managed skills.
 *
 * Instead of adding the entire .claude/skills/ directory (which causes
 * collision diagnostics when tallow already manages a same-named skill),
 * this returns individual skill subdirectory paths for non-colliding entries.
 *
 * @param claudeSkillsDir - Parent .claude/skills/ directory
 * @param tallowSkillsDir - Tallow home skills directory
 * @returns Individual skill subdirectory paths that don't collide
 */
export function getNonCollidingSkillPaths(
	claudeSkillsDir: string,
	tallowSkillsDir: string
): string[] {
	const paths: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true });
	} catch {
		return paths;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const tallowEquivalent = path.join(tallowSkillsDir, entry.name);
		if (fs.existsSync(tallowEquivalent)) continue; // tallow version wins
		paths.push(path.join(claudeSkillsDir, entry.name));
	}
	return paths;
}

/**
 * Registers a resources_discover handler that adds .claude/skills/
 * directories to the framework's skill loading paths.
 * Filters out individual skill directories that collide with
 * tallow-managed skills to avoid noisy collision diagnostics.
 *
 * @param pi - Extension API
 */
export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", async (event) => {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".tallow");
		const tallowSkillsDir = path.join(agentDir, "skills");

		const skillPaths: string[] = [];

		// User-level: ~/.claude/skills/
		const userClaudeSkills = path.join(os.homedir(), CLAUDE_DIR, "skills");
		if (fs.existsSync(userClaudeSkills)) {
			skillPaths.push(...getNonCollidingSkillPaths(userClaudeSkills, tallowSkillsDir));
		}

		// Project-level: cwd/.claude/skills/
		const projectClaudeSkills = path.resolve((event as { cwd: string }).cwd, CLAUDE_DIR, "skills");
		if (fs.existsSync(projectClaudeSkills)) {
			skillPaths.push(...getNonCollidingSkillPaths(projectClaudeSkills, tallowSkillsDir));
		}

		if (skillPaths.length === 0) return;
		return { skillPaths };
	});
}
