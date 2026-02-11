/**
 * Minimal Skill Display Extension
 *
 * Replaces the default skill rendering (with background box and padding)
 * with a minimal single-line display: 📚 skill: name
 *
 * Intercepts /skill:name commands, expands them manually, and sends
 * content to the agent in a format that bypasses the default skill renderer.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadSkills, stripFrontmatter } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

interface Skill {
	name: string;
	filePath: string;
	baseDir: string;
	description: string;
}

interface MinimalSkillDetails {
	skillName: string;
	location: string;
}

export default function (pi: ExtensionAPI) {
	// Load skills at startup
	let skills: Skill[] = [];

	function reloadSkills() {
		try {
			const loaded = loadSkills();
			skills = loaded.skills.map((s) => ({
				name: s.name,
				filePath: s.filePath,
				baseDir: s.baseDir,
				description: s.description || "",
			}));
		} catch {
			skills = [];
		}
	}

	reloadSkills();

	// Reload on session start
	pi.on("session_start", async () => {
		reloadSkills();
	});

	// Register minimal renderer for our custom skill message type
	pi.registerMessageRenderer<MinimalSkillDetails>("minimal-skill", (message, _options, theme) => {
		const details = message.details;
		const text =
			theme.fg("dim", "📚 ") +
			theme.fg("muted", "skill: ") +
			theme.fg("accent", details?.skillName || "unknown");
		return new Text(text, 0, 0);
	});

	// Intercept skill commands
	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();

		// Check if it's a skill command
		if (!text.startsWith("/skill:")) {
			return { action: "continue" as const };
		}

		// Parse skill name and args
		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		// Find the skill
		const skill = skills.find((s) => s.name === skillName);
		if (!skill) {
			// Skill not found, let default handling show error
			return { action: "continue" as const };
		}

		// Read and expand skill content
		let content: string;
		try {
			const raw = fs.readFileSync(skill.filePath, "utf-8");
			content = stripFrontmatter(raw).trim();
		} catch (_err) {
			ctx.ui.notify(`Failed to read skill: ${skillName}`, "error");
			return { action: "handled" as const };
		}

		// Send minimal display message (custom type with our renderer)
		pi.sendMessage({
			customType: "minimal-skill",
			content: `📚 skill: ${skillName}`,
			display: true,
			details: {
				skillName: skill.name,
				location: skill.filePath,
			},
		});

		// Format skill content WITHOUT <skill> tags to bypass default renderer
		// Use a simpler format that still provides context to the LLM
		const skillContent = `[Skill: ${skill.name}]\nLocation: ${skill.filePath}\nReferences are relative to ${skill.baseDir}.\n\n${content}`;

		// Build full message with args if present
		const fullMessage = args ? `${skillContent}\n\n${args}` : skillContent;

		// Send as user message to trigger agent response
		pi.sendUserMessage(fullMessage);

		return { action: "handled" as const };
	});
}
