/**
 * CD Extension - Change pi's working directory.
 *
 * Provides:
 * - /cd <path> command for user
 * - cd tool for the LLM via the shared workspace-transition host
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getWorkspaceTransitionHost } from "../../src/workspace-transition.js";
import { getTallowSettingsPath } from "../_shared/tallow-paths.js";

/** Details returned from the cd tool. */
interface CdToolDetails {
	current: string;
	requested?: string;
	reason?: string;
	status: "completed" | "cancelled" | "unavailable" | "resolve_failed";
	trustedOnEntry?: boolean;
}

/**
 * Check if BASH_MAINTAIN_PROJECT_WORKING_DIR is enabled in settings.
 *
 * @returns True if the setting is enabled
 */
function isMaintainProjectDirEnabled(): boolean {
	try {
		const raw = readFileSync(getTallowSettingsPath(), "utf-8");
		return (
			(JSON.parse(raw) as { BASH_MAINTAIN_PROJECT_WORKING_DIR?: boolean })
				.BASH_MAINTAIN_PROJECT_WORKING_DIR === true
		);
	} catch {
		return false;
	}
}

/**
 * Resolve and validate a directory path, expanding `~` to home.
 *
 * @param inputPath - Path to resolve
 * @returns Resolved absolute directory path
 * @throws {Error} When the path does not exist or is not a directory
 */
function resolvePath(inputPath: string): string {
	let resolvedPath = inputPath;
	if (resolvedPath.startsWith("~")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		resolvedPath = resolvedPath.replace(/^~/, home);
	}

	resolvedPath = resolve(resolvedPath);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Path does not exist: ${resolvedPath}`);
	}

	const stat = statSync(resolvedPath);
	if (!stat.isDirectory()) {
		throw new Error(`Not a directory: ${resolvedPath}`);
	}

	return resolvedPath;
}

/**
 * Perform a workspace transition through the shared interactive host.
 *
 * @param initiator - Whether the request came from a command or tool
 * @param resolvedPath - Already-validated target directory
 * @param ctx - Extension context providing UI access
 * @returns Transition outcome from the interactive host
 */
async function requestWorkspaceTransition(
	initiator: "command" | "tool",
	resolvedPath: string,
	ctx: Pick<ExtensionContext, "ui"> & { cwd?: string }
) {
	const host = getWorkspaceTransitionHost();
	if (!host) {
		return {
			reason: "Workspace transitions are only available in the interactive TUI session right now.",
			status: "unavailable" as const,
		};
	}

	return host.requestTransition({
		initiator,
		sourceCwd: process.cwd(),
		targetCwd: resolvedPath,
		ui: ctx.ui,
	});
}

/**
 * Handle the user-facing /cd command through the workspace-transition host.
 *
 * @param args - Raw slash-command arguments
 * @param ctx - Command context
 * @returns Nothing
 */
async function handleCdCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const inputPath = args.trim();
	if (!inputPath) {
		ctx.ui.notify(`Current directory: ${process.cwd()}`, "info");
		return;
	}

	try {
		const resolvedPath = resolvePath(inputPath);
		const currentCwd = process.cwd();
		if (resolvedPath === currentCwd) {
			ctx.ui.notify(`Already in: ${resolvedPath}`, "info");
			return;
		}

		const result = await requestWorkspaceTransition("command", resolvedPath, ctx);
		if (result.status === "cancelled") {
			ctx.ui.notify("Directory jump canceled.", "info");
			return;
		}
		if (result.status === "unavailable") {
			ctx.ui.notify(result.reason, "error");
			return;
		}

		ctx.ui.notify(`Changed to: ${resolvedPath}`, "info");
		if (!result.trustedOnEntry) {
			ctx.ui.notify(
				"Opened untrusted — repo-controlled project surfaces remain blocked.",
				"warning"
			);
		}
		if (isMaintainProjectDirEnabled()) {
			ctx.ui.notify(
				"Note: BASH_MAINTAIN_PROJECT_WORKING_DIR is enabled — bash commands will still run from the project root",
				"warning"
			);
		}
	} catch (error) {
		ctx.ui.notify(`${error}`, "error");
	}
}

/**
 * Handle the tool-driven `cd` request through the workspace-transition host.
 *
 * @param params - Tool parameters
 * @param ctx - Tool execution context
 * @returns Tool result payload
 */
async function executeCdTool(
	params: { path: string },
	ctx: ExtensionContext
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: CdToolDetails;
	isError: boolean;
}> {
	try {
		const resolvedPath = resolvePath(params.path);
		const result = await requestWorkspaceTransition("tool", resolvedPath, ctx);
		if (result.status === "completed") {
			return {
				content: [
					{
						type: "text",
						text:
							`Workspace transition scheduled to ${resolvedPath}. ` +
							"The current turn will restart in the new workspace with synthetic transition context.",
					},
				],
				details: {
					current: process.cwd(),
					requested: resolvedPath,
					status: "completed",
					trustedOnEntry: result.trustedOnEntry,
				},
				isError: false,
			};
		}
		if (result.status === "cancelled") {
			return {
				content: [{ type: "text", text: "Workspace transition canceled by the user." }],
				details: {
					current: process.cwd(),
					requested: resolvedPath,
					status: "cancelled",
				},
				isError: true,
			};
		}
		return {
			content: [{ type: "text", text: result.reason }],
			details: {
				current: process.cwd(),
				requested: resolvedPath,
				reason: result.reason,
				status: "unavailable",
			},
			isError: true,
		};
	} catch (error) {
		const reason = `Failed to resolve directory: ${error}`;
		return {
			content: [{ type: "text", text: reason }],
			details: {
				current: process.cwd(),
				reason,
				status: "resolve_failed",
			},
			isError: true,
		};
	}
}

/**
 * Register /cd and the cd tool.
 *
 * @param pi - Extension API for registering commands and tools
 * @returns Nothing
 */
export default function (pi: ExtensionAPI): void {
	pi.registerCommand("cd", {
		description:
			"Change working directory with explicit approval, trust handling, and workspace transition",
		handler: handleCdCommand,
	});

	pi.registerTool({
		name: "cd",
		label: "cd",
		description:
			"Request an interactive workspace transition to another directory. Requires explicit user approval and restarts the turn in the new workspace.",
		parameters: Type.Object({
			path: Type.String({
				description: "Directory path to open via the interactive workspace transition flow",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeCdTool(params, ctx);
		},
	});
}
