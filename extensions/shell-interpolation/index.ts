/**
 * Shell Interpolation Extension
 *
 * Expands !`command` patterns in user input by executing shell commands
 * and replacing the pattern with stdout. Compatible with Claude Code's
 * backtick interpolation syntax in prompt templates.
 *
 * The core transform is exported as a named function so other extensions
 * (e.g. subagent-tool) can import and call it directly on arbitrary strings.
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Matches !`command` patterns. Global flag for multiple occurrences. */
const PATTERN = /!`([^`]+)`/g;

/** Shell command execution timeout in milliseconds. */
const TIMEOUT_MS = 5000;

/** Maximum stdout buffer size (1 MB). Prevents OOM from unbounded output. */
const MAX_BUFFER = 1024 * 1024;

/**
 * Expand !`command` patterns in text by executing shell commands
 * and replacing each pattern with the command's stdout.
 *
 * Non-recursive: output is never re-scanned for additional patterns,
 * preventing injection attacks from command output containing !`...`.
 *
 * @param text - Input text potentially containing !`command` patterns
 * @param cwd - Working directory for command execution
 * @returns Text with all patterns replaced by command output (or error markers)
 */
export function expandShellCommands(text: string, cwd: string): string {
	if (!PATTERN.test(text)) return text;
	PATTERN.lastIndex = 0;

	return text.replace(PATTERN, (_match, cmd: string) => {
		const trimmed = cmd.trim();
		try {
			const output = execSync(trimmed, {
				cwd,
				encoding: "utf-8",
				timeout: TIMEOUT_MS,
				stdio: ["pipe", "pipe", "pipe"],
				maxBuffer: MAX_BUFFER,
			});
			return output.trimEnd();
		} catch {
			return `[error: command failed: ${trimmed}]`;
		}
	});
}

/**
 * Extension factory. Registers an input handler that expands
 * !`command` patterns before the prompt reaches the agent.
 *
 * @param pi - Extension API provided by the runtime
 */
export default function (pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		const result = expandShellCommands(event.text, process.cwd());
		if (result === event.text) {
			return { action: "continue" as const };
		}
		return { action: "transform" as const, text: result };
	});
}
