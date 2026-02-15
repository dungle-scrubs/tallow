/**
 * CD Extension - Change pi's working directory
 *
 * Provides:
 * - /cd <path> command for user
 * - cd tool for LLM
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Check if BASH_MAINTAIN_PROJECT_WORKING_DIR is enabled in settings.
 *
 * @returns True if the setting is enabled
 */
function isMaintainProjectDirEnabled(): boolean {
	try {
		const raw = readFileSync(join(homedir(), ".tallow", "settings.json"), "utf-8");
		return (
			(JSON.parse(raw) as { BASH_MAINTAIN_PROJECT_WORKING_DIR?: boolean })
				.BASH_MAINTAIN_PROJECT_WORKING_DIR === true
		);
	} catch {
		return false;
	}
}

/**
 * Resolves and validates a path, expanding ~ to home directory.
 *
 * @param inputPath - Path to resolve
 * @returns Resolved absolute path
 * @throws Error if path doesn't exist or isn't a directory
 */
function resolvePath(inputPath: string): string {
	// Expand ~ to home directory
	let resolved = inputPath;
	if (resolved.startsWith("~")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		resolved = resolved.replace(/^~/, home);
	}

	// Resolve to absolute path
	resolved = resolve(resolved);

	// Validate
	if (!existsSync(resolved)) {
		throw new Error(`Path does not exist: ${resolved}`);
	}

	const stat = statSync(resolved);
	if (!stat.isDirectory()) {
		throw new Error(`Not a directory: ${resolved}`);
	}

	return resolved;
}

/**
 * Registers /cd command and cd tool for changing working directory.
 * @param pi - Extension API for registering commands and tools
 */
export default function (pi: ExtensionAPI) {
	// /cd command for user
	pi.registerCommand("cd", {
		description: "Change working directory",
		handler: async (args, ctx) => {
			const path = args.trim();

			if (!path) {
				ctx.ui.notify(`Current directory: ${process.cwd()}`, "info");
				return;
			}

			try {
				const resolved = resolvePath(path);
				process.chdir(resolved);
				ctx.ui.notify(`Changed to: ${resolved}`, "info");
				if (isMaintainProjectDirEnabled()) {
					ctx.ui.notify(
						"Note: BASH_MAINTAIN_PROJECT_WORKING_DIR is enabled — bash commands will still run from the project root",
						"warning"
					);
				}
			} catch (err) {
				ctx.ui.notify(`${err}`, "error");
			}
		},
	});

	// cd tool for LLM
	pi.registerTool({
		name: "cd",
		label: "Change Directory",
		description:
			"Change the current working directory. Use this before running commands that need to be in a specific directory.",
		parameters: Type.Object({
			path: Type.String({
				description: "Directory path (absolute or relative, ~ expands to home)",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const resolved = resolvePath(params.path);
				const previous = process.cwd();
				process.chdir(resolved);

				const note = isMaintainProjectDirEnabled()
					? `\nNote: BASH_MAINTAIN_PROJECT_WORKING_DIR is enabled — bash commands will still run from the project root`
					: "";

				return {
					content: [{ type: "text", text: `Changed directory: ${previous} → ${resolved}${note}` }],
					details: { previous, current: resolved },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to change directory: ${err}` }],
					details: { error: String(err) },
					isError: true,
				};
			}
		},
	});
}
