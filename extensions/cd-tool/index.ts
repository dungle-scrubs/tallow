/**
 * CD Extension - Change pi's working directory.
 *
 * Provides:
 * - /cd <path> command for user
 * - cd tool for the LLM via the shared workspace-transition host
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getWorkspaceTransitionHost } from "../../runtime/workspace-transition.js";
import {
	getRelaySocketPath,
	requestTransitionViaRelay,
} from "../../runtime/workspace-transition-relay.js";
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
 * Remap original-repo absolute paths into the active session worktree.
 *
 * When `--worktree` is active, callers may still hand the cd tool a path under
 * the original repository root. Keep navigation inside the detached worktree by
 * translating matching paths to the mirrored location under TALLOW_WORKTREE_PATH.
 *
 * @param resolvedPath - Already-resolved absolute path
 * @returns Remapped absolute path when session worktree metadata applies
 */
function remapIntoActiveSessionWorktree(resolvedPath: string): string {
	const worktreeRoot = process.env.TALLOW_WORKTREE_PATH;
	const originalRepoRoot = process.env.TALLOW_WORKTREE_ORIGINAL_CWD;
	if (!worktreeRoot || !originalRepoRoot) {
		return resolvedPath;
	}

	const safeOriginalRepoRoot = resolve(originalRepoRoot);
	const isWithinOriginalRepo =
		resolvedPath === safeOriginalRepoRoot ||
		resolvedPath.startsWith(`${safeOriginalRepoRoot}${sep}`);
	if (!isWithinOriginalRepo) {
		return resolvedPath;
	}

	return resolve(worktreeRoot, relative(safeOriginalRepoRoot, resolvedPath));
}

/**
 * Resolve and validate a directory path, expanding `~` to home.
 *
 * @param inputPath - Path to resolve
 * @param baseCwd - Working directory used for relative paths
 * @returns Resolved absolute directory path
 * @throws {Error} When the path does not exist or is not a directory
 */
function resolvePath(inputPath: string, baseCwd: string): string {
	let resolvedPath = inputPath;
	if (resolvedPath.startsWith("~")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		resolvedPath = resolvedPath.replace(/^~/, home);
	}

	resolvedPath = remapIntoActiveSessionWorktree(resolve(baseCwd, resolvedPath));
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
	if (host) {
		return host.requestTransition({
			initiator,
			sourceCwd: ctx.cwd ?? process.cwd(),
			targetCwd: resolvedPath,
			ui: ctx.ui,
		});
	}

	// No local host — try the parent session's relay server.
	const relaySocket = getRelaySocketPath();
	if (relaySocket) {
		return requestTransitionViaRelay(
			relaySocket,
			ctx.cwd ?? process.cwd(),
			resolvedPath,
			initiator
		);
	}

	return {
		reason: "Workspace transitions are only available in the interactive TUI session right now.",
		status: "unavailable" as const,
	};
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
	const currentCwd = ctx.cwd;
	if (!inputPath) {
		ctx.ui.notify(`Current directory: ${currentCwd}`, "info");
		return;
	}

	try {
		const resolvedPath = resolvePath(inputPath, currentCwd);
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
	const currentCwd = ctx.cwd;
	try {
		const resolvedPath = resolvePath(params.path, currentCwd);
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
					current: resolvedPath,
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
					current: currentCwd,
					requested: resolvedPath,
					status: "cancelled",
				},
				isError: true,
			};
		}
		return {
			content: [{ type: "text", text: result.reason }],
			details: {
				current: currentCwd,
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
				current: currentCwd,
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
			"Request an interactive workspace transition to another directory. Requires explicit user approval and restarts the turn in the new workspace. IMPORTANT: cd must be the ONLY tool call in your response — never combine it with other tools (edit, bash, write, etc.). The transition restarts the turn and discards sibling tool results.",
		promptGuidelines: [
			"The cd tool triggers an interactive workspace transition that restarts the current turn. When you need to cd, emit it as the SOLE tool call in your response — do not pair it with edit, bash, write, read, or any other tool. Sibling tool calls will race against the transition and their results will be lost when the turn restarts.",
		],
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
