import type { TallowSessionOptions } from "./sdk.js";

/** Transition source that requested the workspace move. */
export type WorkspaceTransitionInitiator = "command" | "tool";

/** Minimal UI surface required for workspace-transition prompts. */
export interface WorkspaceTransitionUI {
	/**
	 * Show a selector prompt and resolve the chosen option.
	 *
	 * @param title - Prompt title
	 * @param options - Available options
	 * @returns Selected option, or undefined when dismissed
	 */
	select(title: string, options: string[]): Promise<string | undefined>;
	/**
	 * Show a non-blocking notification.
	 *
	 * @param message - Notification text
	 * @param type - Optional severity level
	 * @returns Nothing
	 */
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/**
	 * Update the working message while a transition is running.
	 *
	 * @param message - Working text, or undefined to clear it
	 * @returns Nothing
	 */
	setWorkingMessage(message?: string): void;
}

/** Request payload for an interactive workspace transition. */
export interface WorkspaceTransitionRequest {
	/** Current working directory before the transition. */
	readonly sourceCwd: string;
	/** Target working directory after the transition. */
	readonly targetCwd: string;
	/** Whether the request originated from a command or tool. */
	readonly initiator: WorkspaceTransitionInitiator;
	/** UI surface used for approval/trust prompts. */
	readonly ui: WorkspaceTransitionUI;
}

/** Successful transition details. */
export interface WorkspaceTransitionCompletedResult {
	readonly status: "completed";
	readonly trustedOnEntry: boolean;
}

/** Cancelled transition details. */
export interface WorkspaceTransitionCancelledResult {
	readonly status: "cancelled";
}

/** Transition host unavailable or transition failed before completion. */
export interface WorkspaceTransitionUnavailableResult {
	readonly status: "unavailable";
	readonly reason: string;
}

/** Result union returned to callers. */
export type WorkspaceTransitionResult =
	| WorkspaceTransitionCancelledResult
	| WorkspaceTransitionCompletedResult
	| WorkspaceTransitionUnavailableResult;

/** Active interactive-mode host implementation. */
export interface WorkspaceTransitionHost {
	/**
	 * Execute a workspace transition.
	 *
	 * @param request - Transition request payload
	 * @returns Final transition outcome
	 */
	requestTransition(request: WorkspaceTransitionRequest): Promise<WorkspaceTransitionResult>;
}

/**
 * Snapshot of CLI session options needed to recreate a session in another cwd.
 *
 * Stored separately from the live host so transitions can rebuild the session
 * with the same startup wiring, plugin selection, and tool policy.
 */
export interface WorkspaceTransitionSessionSeed {
	/** Base session options from the current CLI invocation. */
	readonly sessionOptions: TallowSessionOptions;
	/** Active session ID used when the session is persisted. */
	readonly sessionId: string;
}

let activeHost: WorkspaceTransitionHost | null = null;

/**
 * Register or clear the active workspace-transition host.
 *
 * @param host - Host implementation, or null to clear it
 * @returns Nothing
 */
export function registerWorkspaceTransitionHost(host: WorkspaceTransitionHost | null): void {
	activeHost = host;
}

/**
 * Return the active workspace-transition host.
 *
 * @returns Host when interactive transition support is available, otherwise null
 */
export function getWorkspaceTransitionHost(): WorkspaceTransitionHost | null {
	return activeHost;
}

/**
 * Format the one-shot synthetic context shown after a workspace transition.
 *
 * @param sourceCwd - Workspace before the move
 * @param targetCwd - Workspace after the move
 * @param initiator - Transition source kind
 * @param trustedOnEntry - Whether repo-controlled surfaces are enabled in the target workspace
 * @param taskContext - Optional task context carried forward from the previous session
 * @returns Synthetic transition summary for the restarted turn
 */
export function buildWorkspaceTransitionSummary(
	sourceCwd: string,
	targetCwd: string,
	initiator: WorkspaceTransitionInitiator,
	trustedOnEntry: boolean,
	taskContext?: string
): string {
	const initiatorLabel = initiator === "tool" ? "tool request" : "user command";
	const trustLabel = trustedOnEntry
		? "repo-controlled project surfaces are enabled in the target workspace"
		: "repo-controlled project surfaces remain blocked because the target workspace is untrusted";
	let summary =
		`Workspace transition complete (${initiatorLabel}).\n` +
		`Previous workspace: ${sourceCwd}\n` +
		`Current workspace: ${targetCwd}\n` +
		`${trustLabel}.\n`;

	if (taskContext) {
		summary +=
			"\n--- Task context carried forward from previous workspace ---\n" +
			`${taskContext}\n` +
			"--- End task context ---\n\n" +
			"Continue working on the task above in the new workspace.";
	} else {
		summary +=
			"Treat the interrupted turn as ended. Re-evaluate the new workspace before continuing.";
	}

	return summary;
}
