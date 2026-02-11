/**
 * Clear Extension
 *
 * Registers /clear as an alias for /new (start a fresh session).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Registers the /clear command.
 * @param pi - Extension API
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}
