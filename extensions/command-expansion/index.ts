/**
 * Nested Command Expansion Extension
 *
 * Expands nested commands/skills/templates used as arguments to other commands.
 *
 * Example:
 *   /outer-command /skill:inner-skill args
 *
 * Before this extension: /skill:inner-skill is passed as literal string
 * After this extension: /skill:inner-skill is expanded to its content
 *
 * Supports:
 *   - /skill:name args - skill commands
 *   - /template-name args - prompt templates
 *   - Recursive expansion (nested within nested)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadSkills, stripFrontmatter } from "@mariozechner/pi-coding-agent";

interface PromptTemplate {
	name: string;
	content: string;
	filePath: string;
}

interface Skill {
	name: string;
	filePath: string;
	baseDir: string;
	description: string;
}

/**
 * Parse command arguments respecting quoted strings (bash-style).
 * @internal
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];
		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) {
		args.push(current);
	}
	return args;
}

/**
 * Substitute argument placeholders in template content.
 * Supports $1, $2, ..., $@, $ARGUMENTS, ${@:N}, ${@:N:L}
 * @internal
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// Replace $1, $2, etc. with positional args FIRST
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	// Replace ${@:start} or ${@:start:length} with sliced args
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});

	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);

	return result;
}

/**
 * Load prompt templates from ~/.tallow/prompts/ and .tallow/prompts/
 */
function loadPromptTemplates(): PromptTemplate[] {
	const templates: PromptTemplate[] = [];
	const homeDir = os.homedir();

	const dirs = [
		path.join(homeDir, ".tallow", "prompts"),
		path.join(process.cwd(), ".tallow", "prompts"),
	];

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;

		try {
			const files = fs.readdirSync(dir);
			for (const file of files) {
				if (!file.endsWith(".md")) continue;

				const filePath = path.join(dir, file);
				try {
					// Read directly — avoids TOCTOU race between stat and read
					const content = fs.readFileSync(filePath, "utf-8");
					const name = file.replace(/\.md$/, "");

					// Strip frontmatter to get content
					const body = stripFrontmatter(content);

					templates.push({
						name,
						content: body.trim(),
						filePath,
					});
				} catch {
					// Skip unreadable files
				}
			}
		} catch {
			// Skip unreadable directories
		}
	}

	return templates;
}

/**
 * Expand a skill command to its content.
 */
function expandSkill(skillName: string, args: string, skills: Skill[]): string | null {
	const skill = skills.find((s) => s.name === skillName);
	if (!skill) return null;

	try {
		const content = fs.readFileSync(skill.filePath, "utf-8");
		const body = stripFrontmatter(content).trim();
		const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		return args ? `${skillBlock}\n\n${args}` : skillBlock;
	} catch {
		return null;
	}
}

/**
 * Expand a prompt template to its content.
 */
function expandTemplate(
	templateName: string,
	argsString: string,
	templates: PromptTemplate[]
): string | null {
	const template = templates.find((t) => t.name === templateName);
	if (!template) return null;

	const args = parseCommandArgs(argsString);
	return substituteArgs(template.content, args);
}

/**
 * Check if text starts with a command pattern.
 * Returns { command, args } if it's a command, null otherwise.
 */
function parseCommand(
	text: string
): { type: "skill" | "template"; name: string; args: string } | null {
	if (!text.startsWith("/")) return null;

	const spaceIndex = text.indexOf(" ");
	const commandPart = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	if (commandPart.startsWith("skill:")) {
		return { type: "skill", name: commandPart.slice(6), args };
	}

	// It's potentially a template (we'll check if it exists later)
	return { type: "template", name: commandPart, args };
}

/**
 * Recursively expand all commands in text.
 * Handles commands at the start and within arguments.
 */
function expandCommands(
	text: string,
	skills: Skill[],
	templates: PromptTemplate[],
	depth = 0
): string {
	// Prevent infinite recursion
	if (depth > 10) return text;

	// First, try to expand if the text itself starts with a command
	const parsed = parseCommand(text);
	if (parsed) {
		let expanded: string | null = null;

		if (parsed.type === "skill") {
			// Recursively expand args first
			const expandedArgs = expandCommands(parsed.args, skills, templates, depth + 1);
			expanded = expandSkill(parsed.name, expandedArgs, skills);
		} else if (parsed.type === "template") {
			// Recursively expand args first
			const expandedArgs = expandCommands(parsed.args, skills, templates, depth + 1);
			expanded = expandTemplate(parsed.name, expandedArgs, templates);
		}

		if (expanded !== null) {
			// Recursively expand the result in case it contains more commands
			return expandCommands(expanded, skills, templates, depth + 1);
		}
	}

	// If not a command at the start, look for commands in the text
	// Find the first /command pattern and try to expand it
	const commandMatch = text.match(/(?:^|\s)(\/\S+)/);
	if (commandMatch && commandMatch.index !== undefined) {
		const matchStart = commandMatch.index + (commandMatch[0].startsWith(" ") ? 1 : 0);
		const beforeCommand = text.slice(0, matchStart);
		const commandAndRest = text.slice(matchStart);

		// Try to parse and expand this command
		const parsed = parseCommand(commandAndRest);
		if (parsed) {
			let expanded: string | null = null;

			if (parsed.type === "skill") {
				expanded = expandSkill(parsed.name, parsed.args, skills);
			} else if (parsed.type === "template") {
				expanded = expandTemplate(parsed.name, parsed.args, templates);
			}

			if (expanded !== null) {
				const result = beforeCommand + expanded;
				// Recursively expand any remaining commands
				return expandCommands(result, skills, templates, depth + 1);
			}
		}
	}

	return text;
}

/**
 * Extract the outer command and its arguments.
 * Returns { outerCommand, args } for "/cmd1 /cmd2 args" -> { outerCommand: "/cmd1", args: "/cmd2 args" }
 * @internal
 */
export function splitOuterCommand(text: string): { outerCommand: string; args: string } | null {
	if (!text.startsWith("/")) return null;

	const spaceIndex = text.indexOf(" ");
	if (spaceIndex === -1) {
		return { outerCommand: text, args: "" };
	}

	return {
		outerCommand: text.slice(0, spaceIndex),
		args: text.slice(spaceIndex + 1),
	};
}

export default function (pi: ExtensionAPI) {
	// Load skills and templates once at startup
	let skills: Skill[] = [];
	let templates: PromptTemplate[] = [];

	function reloadResources() {
		try {
			const loadedSkills = loadSkills();
			skills = loadedSkills.skills.map((s) => ({
				name: s.name,
				filePath: s.filePath,
				baseDir: s.baseDir,
				description: s.description || "",
			}));
		} catch {
			skills = [];
		}

		templates = loadPromptTemplates();
	}

	// Initial load
	reloadResources();

	// Reload on session start (in case resources changed)
	pi.on("session_start", async () => {
		reloadResources();
	});

	// Intercept input and expand nested commands
	pi.on("input", async (event, _ctx) => {
		const text = event.text;

		// Only process if it looks like a command with arguments
		const split = splitOuterCommand(text);
		if (!split || !split.args) {
			return { action: "continue" as const };
		}

		// Check if args contain a potential command pattern
		if (!split.args.match(/\/\S+/)) {
			return { action: "continue" as const };
		}

		// Expand nested commands in the arguments
		const expandedArgs = expandCommands(split.args, skills, templates, 0);

		// If nothing changed, continue normally
		if (expandedArgs === split.args) {
			return { action: "continue" as const };
		}

		// Transform the input with expanded arguments
		const newText = `${split.outerCommand} ${expandedArgs}`;
		return { action: "transform" as const, text: newText };
	});
}
