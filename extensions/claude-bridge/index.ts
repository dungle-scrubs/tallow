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
 * Registers a resources_discover handler that adds .claude/skills/
 * directories to the framework's skill loading paths.
 *
 * @param pi - Extension API
 */
export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", async (event) => {
		const skillPaths: string[] = [];

		// User-level: ~/.claude/skills/
		const userClaudeSkills = path.join(os.homedir(), CLAUDE_DIR, "skills");
		if (fs.existsSync(userClaudeSkills)) {
			skillPaths.push(userClaudeSkills);
		}

		// Project-level: cwd/.claude/skills/
		const projectClaudeSkills = path.resolve((event as { cwd: string }).cwd, CLAUDE_DIR, "skills");
		if (fs.existsSync(projectClaudeSkills)) {
			skillPaths.push(projectClaudeSkills);
		}

		if (skillPaths.length === 0) return;
		return { skillPaths };
	});
}
