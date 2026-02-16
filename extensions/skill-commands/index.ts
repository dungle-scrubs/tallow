/**
 * Skill Commands Extension
 *
 * Registers skills as `/skill-name` commands (Claude Code style, no colon).
 * Supports `user-invocable: false` frontmatter to hide skills from the menu.
 *
 * Automatically disables the built-in `/skill:name` syntax on load so
 * this extension's `/skill-name` commands are the only entry point.
 */

import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";
import { atomicWriteFileSync } from "../_shared/atomic-write.js";

/** Frontmatter parsed from a SKILL.md file. */
interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	"user-invocable"?: boolean;
	"argument-hint"?: string;
	[key: string]: unknown;
}

/**
 * Parses YAML frontmatter from skill content.
 * @param content - Raw skill content with optional frontmatter
 * @returns Parsed frontmatter object with skill metadata
 */
function parseFrontmatter(content: string): SkillFrontmatter {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) return {};

	const frontmatter: SkillFrontmatter = {};
	const lines = match[1].split("\n");

	for (const line of lines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;

		const key = line.slice(0, colonIndex).trim();
		let value: string | boolean = line.slice(colonIndex + 1).trim();

		// Parse booleans
		if (value === "true") value = true;
		else if (value === "false") value = false;

		frontmatter[key] = value;
	}

	return frontmatter;
}

/**
 * Substitutes $ARGUMENTS, $@, and $N placeholders with actual arguments.
 * @param content - Skill content with placeholders
 * @param args - Space-separated argument string
 * @returns Content with substitutions applied
 */
function substituteArguments(content: string, args: string): string {
	const argList = args.split(/\s+/).filter(Boolean);

	// Replace $ARGUMENTS or $@ with all args
	let result = content.replace(/\$ARGUMENTS|\$@/g, args);

	// Replace $ARGUMENTS[N] or $N with specific arg
	result = result.replace(/\$ARGUMENTS\[(\d+)\]|\$(\d+)/g, (_, n1, n2) => {
		const index = Number.parseInt(n1 ?? n2, 10);
		return argList[index] ?? "";
	});

	// If $ARGUMENTS wasn't in content and args provided, append
	if (!(content.includes("$ARGUMENTS") || content.includes("$@")) && args) {
		result += `\n\nUser: ${args}`;
	}

	return result;
}

/** Valid skill command name: lowercase alphanumeric with hyphens. */
const VALID_NAME_RE = /^[a-z0-9-]+$/;

/**
 * Resolves a valid command name for a skill.
 * Prefers the skill's declared name; falls back to the parent directory name
 * when the declared name contains invalid characters (spaces, uppercase, etc).
 *
 * @param skill - Skill object with name and filePath
 * @returns Valid kebab-case command name, or null if no valid name can be derived
 */
export function resolveCommandName(skill: { name: string; filePath: string }): string | null {
	if (VALID_NAME_RE.test(skill.name)) return skill.name;

	const dirName = basename(dirname(skill.filePath));
	if (VALID_NAME_RE.test(dirName)) return dirName;

	return null;
}

/**
 * Disable the built-in `/skill:name` commands so this extension's
 * `/skill-name` style is the sole entry point. Reads and writes
 * the agent settings file directly since the extension API doesn't
 * expose SettingsManager.
 */
function disableBuiltinSkillCommands(): void {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ??
		join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".tallow");
	const settingsPath = join(agentDir, "settings.json");
	try {
		let settings: Record<string, unknown> = {};
		if (fs.existsSync(settingsPath)) {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		}
		if (settings.enableSkillCommands !== false) {
			settings.enableSkillCommands = false;
			atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2), { backup: true });
		}
	} catch {
		// Best-effort — if it fails, built-in commands just coexist
	}
}

export default function (pi: ExtensionAPI) {
	disableBuiltinSkillCommands();

	// Include .claude/skills/ directories for Claude Code compatibility
	const claudeSkillPaths: string[] = [];
	const userClaudeSkills = join(
		process.env.HOME ?? process.env.USERPROFILE ?? "~",
		".claude",
		"skills"
	);
	const projectClaudeSkills = join(process.cwd(), ".claude", "skills");
	if (fs.existsSync(userClaudeSkills)) claudeSkillPaths.push(userClaudeSkills);
	if (fs.existsSync(projectClaudeSkills)) claudeSkillPaths.push(projectClaudeSkills);

	// Load skills synchronously during extension init for autocomplete to work
	const { skills } = loadSkills({ skillPaths: claudeSkillPaths });

	for (const skill of skills) {
		// Validate name before registration — invalid names produce broken commands
		const commandName = resolveCommandName(skill);
		if (!commandName) continue;

		// Read skill file to check frontmatter
		let frontmatter: SkillFrontmatter = {};
		try {
			const content = fs.readFileSync(skill.filePath, "utf-8");
			frontmatter = parseFrontmatter(content);
		} catch {
			// If we can't read, register anyway
		}

		// Skip if user-invocable is explicitly false
		if (frontmatter["user-invocable"] === false) {
			continue;
		}

		const hint = frontmatter["argument-hint"];
		const description = hint ? `${skill.description} ${hint}` : skill.description;

		pi.registerCommand(commandName, {
			description,
			handler: async (args, cmdCtx) => {
				// Read full skill content
				let content: string;
				try {
					content = fs.readFileSync(skill.filePath, "utf-8");
				} catch (_err) {
					cmdCtx.ui.notify(`Failed to read skill: ${skill.name}`, "error");
					return;
				}

				// Remove frontmatter
				content = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");

				// Substitute arguments
				if (args) {
					content = substituteArguments(content, args);
				}

				// Send as user message to trigger agent response
				pi.sendUserMessage(content);
			},
		});
	}
}
