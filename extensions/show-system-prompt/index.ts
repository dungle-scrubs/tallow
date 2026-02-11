/**
 * Show System Prompt Extension
 * Provides a command to display the current system prompt for debugging.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Registers the show-system-prompt command with Pi.
 * Logs the current system prompt to the terminal for inspection.
 * @param pi - The Pi extension API
 */
export default function showPrompt(pi: ExtensionAPI) {
	pi.registerCommand("show-system-prompt", {
		description: "Show current system prompt",
		/**
		 * Handles the show-system-prompt command execution.
		 * @param _args - Command arguments (unused)
		 * @param ctx - Extension context with UI and system prompt access
		 */
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			console.log("\n=== SYSTEM PROMPT ===\n");
			console.log(prompt);
			console.log("\n=== END ===\n");
			ctx.ui.notify("System prompt logged to terminal", "info");
		},
	});
}
