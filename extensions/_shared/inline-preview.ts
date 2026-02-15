/**
 * Shared utility for extracting compact inline previews from command output
 * or agent responses. Used by background-task-tool and subagent-tool to
 * display inline completion notifications.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Extract the last N non-empty lines from output text for inline preview.
 *
 * Strips ANSI escape codes, truncates long lines with ellipsis,
 * and filters out blank lines.
 *
 * @param output - Raw output string (may contain ANSI codes)
 * @param maxLines - Maximum lines to extract (default: 3)
 * @param maxLineWidth - Maximum visible width per line before truncation (default: 80)
 * @returns Array of clean, truncated preview lines
 */
export function extractPreview(output: string, maxLines = 3, maxLineWidth = 80): string[] {
	if (!output || !output.trim()) return [];

	const lines = output
		.split("\n")
		.map((l) => l.replace(ANSI_RE, "").trimEnd())
		.filter((l) => l.length > 0);

	if (lines.length === 0) return [];

	const tail = lines.slice(-maxLines);
	return tail.map((line) =>
		line.length > maxLineWidth ? `${line.slice(0, maxLineWidth - 1)}…` : line
	);
}

/**
 * Read the `inlineAgentResults` setting from ~/.tallow/settings.json.
 *
 * Returns true by default if the setting is missing or unreadable.
 *
 * @returns Whether inline agent results are enabled
 */
export function isInlineResultsEnabled(): boolean {
	try {
		const settingsPath = path.join(os.homedir(), ".tallow", "settings.json");
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { inlineAgentResults?: boolean };
		return settings.inlineAgentResults !== false;
	} catch {
		return true;
	}
}
