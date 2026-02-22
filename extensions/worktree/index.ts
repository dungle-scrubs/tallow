import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	emitWorktreeLifecycleEvent,
	type WorktreeLifecycleEventPayload,
} from "../_shared/interop-events.js";
import { cleanupStaleWorktrees, removeWorktree, validateGitRepo } from "./lifecycle.js";

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
