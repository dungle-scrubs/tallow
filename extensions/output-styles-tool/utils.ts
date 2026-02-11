/**
 * Pure utility functions for output-styles.
 * No side effects, no filesystem access — fully testable.
 */
import * as path from "node:path";

// ── Types ────────────────────────────────────────────

export interface OutputStyleFrontmatter {
	name: string;
	description: string;
	keepToolInstructions: boolean;
	reminder: boolean;
	reminderInterval: number;
}

export interface OutputStyle extends OutputStyleFrontmatter {
	/** Filename without extension (used as ID) */
	id: string;
	/** Source path */
	path: string;
	/** Style body (after frontmatter) */
	body: string;
	/** "user" or "project" */
	scope: "user" | "project";
}

// ── Frontmatter Parser ──────────────────────────────

/**
 * Parse frontmatter key-value pairs from a block between --- delimiters.
 * Simple YAML-like: "key: value" per line.
 * @param block - Raw text between opening and closing ---
 * @returns Record of key → value strings
 */
export function parseFrontmatterBlock(block: string): Record<string, string> {
	const fm: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (key) fm[key] = value;
	}
	return fm;
}

/**
 * Parse a style markdown file into an OutputStyle.
 * @param content - Raw markdown file content
 * @param filePath - Path to the file
 * @param scope - "user" or "project"
 * @returns Parsed OutputStyle, never null
 */
export function parseStyleFile(
	content: string,
	filePath: string,
	scope: "user" | "project"
): OutputStyle {
	const filename = path.basename(filePath, ".md");

	const defaults: OutputStyle = {
		id: filename,
		path: filePath,
		name: filename,
		description: "",
		keepToolInstructions: false,
		reminder: false,
		reminderInterval: 5,
		body: content.trim(),
		scope,
	};

	// No frontmatter
	if (!content.startsWith("---")) return defaults;

	// Find closing ---
	const endIdx = content.indexOf("\n---", 3);
	if (endIdx === -1) return defaults;

	const frontmatterBlock = content.slice(4, endIdx);
	const body = content.slice(endIdx + 4).trim();
	const fm = parseFrontmatterBlock(frontmatterBlock);

	return {
		id: filename,
		path: filePath,
		name: fm.name || filename,
		description: fm.description || "",
		keepToolInstructions: fm["keep-tool-instructions"] === "true",
		reminder: fm.reminder === "true",
		reminderInterval: Number.parseInt(fm["reminder-interval"] || "5", 10) || 5,
		body,
		scope,
	};
}

// ── System Prompt Assembly ──────────────────────────

/**
 * Build the modified system prompt for an active output style.
 * @param currentPrompt - The existing system prompt
 * @param style - The active output style
 * @returns Modified system prompt
 */
export function buildStyledPrompt(currentPrompt: string, style: OutputStyle): string {
	if (style.keepToolInstructions) {
		// Append: style augments the default personality
		return `${currentPrompt}\n\n# Output Style: ${style.name}\n\n${style.body}`;
	}

	// Prepend: style defines the personality, tools/context preserved below
	return (
		`# Output Style: ${style.name}\n\n` +
		`${style.body}\n\n` +
		`---\n\n` +
		`The above defines your primary role and personality for this session. ` +
		`The instructions below provide your tools, context, and operational guidelines. ` +
		`Follow both, but when personality conflicts arise, prefer the output style above.\n\n` +
		`${currentPrompt}`
	);
}

/**
 * Determine if a reminder should fire on this turn.
 * @param style - Active style with reminder config
 * @param turnCount - Current turn number (0-indexed)
 * @returns true if a reminder should be injected
 */
export function shouldRemind(style: OutputStyle, turnCount: number): boolean {
	if (!style.reminder) return false;
	if (turnCount === 0) return false;
	return turnCount % style.reminderInterval === 0;
}

/**
 * Build the reminder message content.
 * @param style - Active output style
 * @returns Reminder text
 */
export function buildReminderContent(style: OutputStyle): string {
	return `[Style Reminder: ${style.name}]\n\n${style.body}`;
}
