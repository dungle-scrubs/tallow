import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getWorkspaceTransitionHost } from "../../runtime/workspace-transition.js";
import {
	emitWorktreeLifecycleEvent,
	type WorktreeLifecycleEventPayload,
} from "../_shared/interop-events.js";
import {
	cleanupStaleWorktrees,
	createProjectWorktree,
	removeWorktree,
	validateGitRepo,
} from "./lifecycle.js";

/** Env var containing active session worktree path (set by CLI when -w/--worktree is used). */
const TALLOW_WORKTREE_PATH_ENV = "TALLOW_WORKTREE_PATH";

/** Env var containing original cwd before session worktree activation. */
const TALLOW_WORKTREE_ORIGINAL_CWD_ENV = "TALLOW_WORKTREE_ORIGINAL_CWD";

/** Marker added to system prompt so worktree context is only injected once. */
const SESSION_WORKTREE_PROMPT_MARKER = "Session worktree isolation is active.";

/** In-memory state for session-level worktree lifecycle management. */
interface SessionWorktreeState {
	readonly originalCwd: string;
	readonly repoRoot: string;
	readonly worktreePath: string;
}

/** Parameters accepted by the worktree_create tool. */
interface WorktreeCreateParams {
	readonly baseRef?: string;
	readonly branch: string;
	readonly path?: string;
}

/** Details returned by worktree_create. */
interface WorktreeCreateDetails {
	readonly baseRef?: string;
	readonly branch?: string;
	readonly branchExisted?: boolean;
	readonly reason?: string;
	readonly repoRoot?: string;
	readonly status: "cancelled" | "completed" | "create_failed" | "unavailable";
	readonly worktreePath?: string;
}

/**
 * Parse `/worktree-create` arguments.
 *
 * @param args - Raw slash-command argument string
 * @returns Worktree creation parameters
 * @throws {Error} When the branch argument is missing
 */
function parseWorktreeCreateArgs(args: string): WorktreeCreateParams {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const branch = parts[0];
	if (!branch) {
		throw new Error("Usage: /worktree-create <branch> [path]");
	}
	return {
		branch,
		path: parts[1],
	};
}

/**
 * Create a project worktree and transition the interactive session into it.
 *
 * @param params - Branch, base ref, and optional path
 * @param ctx - Extension context carrying cwd and UI surface
 * @param initiator - Whether the request came from a command or tool
 * @returns Worktree creation and transition result details
 */
async function createAndEnterProjectWorktree(
	params: WorktreeCreateParams,
	ctx: Pick<ExtensionContext, "cwd" | "ui">,
	initiator: "command" | "tool",
	events: ExtensionAPI["events"]
): Promise<WorktreeCreateDetails> {
	const host = getWorkspaceTransitionHost();
	if (!host) {
		return {
			reason: "Workspace transitions are only available in the interactive TUI session right now.",
			status: "unavailable",
		};
	}

	let created: ReturnType<typeof createProjectWorktree>;
	try {
		created = createProjectWorktree(ctx.cwd, params);
	} catch (error) {
		return {
			reason: error instanceof Error ? error.message : String(error),
			status: "create_failed",
		};
	}

	emitWorktreeLifecycleEvent(events, "worktree_create", {
		agentId: undefined,
		repoRoot: created.repoRoot,
		scope: "project",
		timestamp: Date.now(),
		worktreePath: created.worktreePath,
	});

	const transition = await host.requestTransition({
		initiator,
		sourceCwd: ctx.cwd,
		targetCwd: created.worktreePath,
		ui: ctx.ui,
	});
	if (transition.status !== "completed") {
		return {
			baseRef: created.baseRef,
			branch: created.branch,
			branchExisted: created.branchExisted,
			reason: transition.status === "unavailable" ? transition.reason : undefined,
			repoRoot: created.repoRoot,
			status: transition.status,
			worktreePath: created.worktreePath,
		};
	}

	return {
		baseRef: created.baseRef,
		branch: created.branch,
		branchExisted: created.branchExisted,
		repoRoot: created.repoRoot,
		status: "completed",
		worktreePath: created.worktreePath,
	};
}

/**
 * Worktree lifecycle extension.
 *
 * Responsibilities:
 * - prune stale managed worktrees on session startup
 * - emit session-level worktree lifecycle events for hooks
 * - inject explicit worktree context into the system prompt
 * - perform best-effort teardown on session shutdown
 *
 * @param pi - Extension API
 */
export default function worktreeExtension(pi: ExtensionAPI): void {
	let sessionState: SessionWorktreeState | undefined;
	let cleanedUp = false;

	pi.registerCommand("worktree-create", {
		description: "Create a persistent git worktree for a branch and enter it",
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			let params: WorktreeCreateParams;
			try {
				params = parseWorktreeCreateArgs(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const result = await createAndEnterProjectWorktree(params, ctx, "command", pi.events);
			if (result.status === "completed") {
				ctx.ui.notify(`Created worktree for ${result.branch}: ${result.worktreePath}`, "info");
				return;
			}
			ctx.ui.notify(result.reason ?? `Worktree creation ${result.status}.`, "error");
		},
	});

	pi.registerTool({
		name: "worktree_create",
		label: "worktree_create",
		description:
			"Create a persistent git worktree for a branch, then transition the interactive Tallow session into it. Use when the user asks to create a new worktree/branch and continue working there.",
		promptGuidelines: [
			"This tool triggers an interactive workspace transition. Call it as the only tool in the response; sibling tool calls may be discarded when the session moves.",
		],
		parameters: Type.Object({
			baseRef: Type.Optional(
				Type.String({
					description:
						"Git ref to create the branch from when it does not already exist. Defaults to HEAD.",
				})
			),
			branch: Type.String({
				description: "Local branch name to create or check out in the new worktree.",
			}),
			path: Type.Optional(
				Type.String({
					description:
						"Optional absolute or cwd-relative target worktree path. Defaults to ~/dev/<project>_worktrees/<branch-slug>.",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await createAndEnterProjectWorktree(params, ctx, "tool", pi.events);
			return {
				content: [
					{
						type: "text" as const,
						text:
							result.status === "completed"
								? `Created worktree for ${result.branch}: ${result.worktreePath}`
								: (result.reason ?? `Worktree creation ${result.status}.`),
					},
				],
				details: result,
				isError: result.status !== "completed",
			};
		},
	});

	/**
	 * Best-effort session-worktree cleanup routine.
	 *
	 * @param reason - Cleanup trigger reason for diagnostics
	 */
	const cleanupSessionWorktree = (reason: "session_shutdown"): void => {
		if (cleanedUp || !sessionState) return;
		cleanedUp = true;
		removeWorktree(sessionState.worktreePath);
		emitWorktreeLifecycleEvent(pi.events, "worktree_remove", {
			agentId: undefined,
			repoRoot: sessionState.repoRoot,
			scope: "session",
			timestamp: Date.now(),
			worktreePath: sessionState.worktreePath,
		});
		if (reason === "session_shutdown") {
			delete process.env[TALLOW_WORKTREE_PATH_ENV];
			delete process.env[TALLOW_WORKTREE_ORIGINAL_CWD_ENV];
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const cleanupRoot = resolveCleanupRoot(ctx.cwd);
		if (cleanupRoot) {
			try {
				cleanupStaleWorktrees(cleanupRoot);
			} catch {
				// Startup stale cleanup is best-effort.
			}
		}

		sessionState = resolveSessionWorktreeState(ctx.cwd);
		cleanedUp = false;
		if (!sessionState) return;

		const payload: WorktreeLifecycleEventPayload = {
			agentId: undefined,
			repoRoot: sessionState.repoRoot,
			scope: "session",
			timestamp: Date.now(),
			worktreePath: sessionState.worktreePath,
		};
		emitWorktreeLifecycleEvent(pi.events, "worktree_create", payload);
	});

	pi.on("before_agent_start", async (event) => {
		if (!sessionState) return;
		if (event.systemPrompt.includes(SESSION_WORKTREE_PROMPT_MARKER)) return;

		const hint = [
			SESSION_WORKTREE_PROMPT_MARKER,
			`Current cwd is an isolated detached git worktree: ${sessionState.worktreePath}`,
			`Original cwd before isolation: ${sessionState.originalCwd}`,
			"Any file edits happen inside this temporary worktree.",
		].join("\n");
		return {
			systemPrompt: `${event.systemPrompt}\n\n${hint}`,
		};
	});

	pi.on("session_shutdown", async () => {
		cleanupSessionWorktree("session_shutdown");
	});
}

/**
 * Resolve cleanup root for startup stale-worktree pruning.
 *
 * @param cwd - Current session cwd
 * @returns Repository root when available
 */
function resolveCleanupRoot(cwd: string): string | undefined {
	const originalCwd = process.env[TALLOW_WORKTREE_ORIGINAL_CWD_ENV];
	if (originalCwd) {
		try {
			return validateGitRepo(originalCwd).repoRoot;
		} catch {
			// Fall through to session cwd.
		}
	}

	try {
		return validateGitRepo(cwd).repoRoot;
	} catch {
		return undefined;
	}
}

/**
 * Build session worktree state from environment metadata.
 *
 * @param fallbackCwd - Session cwd fallback when original cwd metadata is absent
 * @returns Parsed session worktree state when metadata is valid
 */
function resolveSessionWorktreeState(fallbackCwd: string): SessionWorktreeState | undefined {
	const worktreePath = process.env[TALLOW_WORKTREE_PATH_ENV];
	if (!worktreePath) return undefined;
	const originalCwd = process.env[TALLOW_WORKTREE_ORIGINAL_CWD_ENV] ?? fallbackCwd;

	try {
		const repoRoot = validateGitRepo(originalCwd).repoRoot;
		return {
			originalCwd,
			repoRoot,
			worktreePath,
		};
	} catch {
		return undefined;
	}
}
