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

/**
 * Registers /init command to create or improve AGENTS.md for a project.
 * Handles migration from CLAUDE.md to AGENTS.md.
 * @param pi - Extension API for registering commands
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Initialize AGENTS.md for the current project",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const claudeMdPath = path.join(cwd, "CLAUDE.md");
			const agentsMdPath = path.join(cwd, "AGENTS.md");

			const claudeExists = fs.existsSync(claudeMdPath);
			const agentsExists = fs.existsSync(agentsMdPath);

			if (agentsExists) {
				// AGENTS.md already exists — suggest improvements
				ctx.ui.notify("Found existing AGENTS.md — will suggest improvements", "info");
				pi.sendUserMessage(INIT_PROMPT);
			} else if (claudeExists) {
				// Only CLAUDE.md exists — migrate to AGENTS.md
				ctx.ui.notify("Found CLAUDE.md without AGENTS.md — will migrate to AGENTS.md", "info");
				pi.sendUserMessage(MIGRATE_PROMPT);
			} else {
				// Neither exists — create fresh AGENTS.md
				ctx.ui.notify("Analyzing codebase to create AGENTS.md...", "info");
				pi.sendUserMessage(INIT_PROMPT);
			}
		},
	});
}
