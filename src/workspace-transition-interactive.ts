import { resolveProjectTrust, trustProject } from "./project-trust.js";
import type { TallowSession, TallowSessionOptions } from "./sdk.js";
import { createTallowSession } from "./sdk.js";
import {
	buildWorkspaceTransitionSummary,
	type WorkspaceTransitionHost,
	type WorkspaceTransitionRequest,
	type WorkspaceTransitionResult,
} from "./workspace-transition.js";

/** User choice for the first workspace-jump confirmation prompt. */
type WorkspaceJumpApproval = "proceed" | "cancel";
/** User choice for how an untrusted target should be opened. */
type WorkspaceTrustDecision = "trust" | "untrusted" | "cancel";

/** Runtime shape needed from InteractiveMode for session swapping. */
interface InteractiveModeLike {
	chatContainer: { clear(): void };
	compactionQueuedMessages: unknown[];
	loadingAnimation?: { stop(): void };
	pendingMessagesContainer: { clear(): void };
	pendingTools: Map<string, unknown>;
	renderInitialMessages(): void;
	resetExtensionUI(): void;
	session: AgentSessionLike;
	showStatus(message: string): void;
	statusContainer: { clear(): void };
	streamingComponent?: unknown;
	streamingMessage?: unknown;
	subscribeToAgent(): void;
	ui: { requestRender(force?: boolean): void; requestScrollbackClear?(): void };
	unsubscribe?: (() => void) | undefined;
	updateTerminalTitle(): void;
	initExtensions(): Promise<void>;
}

/** Runtime shape needed from AgentSession for transition orchestration. */
type AgentSessionLike = TallowSession["session"] & {
	abort(): void;
	agent: { waitForIdle(): Promise<void> };
	extensionRunner?: {
		hasHandlers(eventName: string): boolean;
		emit(event: { type: string }): Promise<unknown>;
	};
	model?: TallowSessionOptions["model"];
	sendCustomMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: Record<string, unknown>;
		},
		options?: { triggerTurn?: boolean; deliverAs?: "nextTurn" | "followUp" | "steer" }
	): Promise<void>;
	thinkingLevel?: TallowSessionOptions["thinkingLevel"];
};

/** Injectable runtime dependencies for transition-host tests. */
interface WorkspaceTransitionDeps {
	readonly changeDirectory: (cwd: string) => void;
	readonly createSession: (options: TallowSessionOptions) => Promise<TallowSession>;
	readonly resolveTrust: (cwd: string) => { status: "trusted" | "untrusted" | "stale_fingerprint" };
	readonly trustProject: (cwd: string) => unknown;
}

const DEFAULT_WORKSPACE_TRANSITION_DEPS: WorkspaceTransitionDeps = {
	changeDirectory: (cwd: string): void => {
		process.chdir(cwd);
	},
	createSession: createTallowSession,
	resolveTrust: resolveProjectTrust,
	trustProject,
};

/**
 * Ask the user for explicit approval before leaving the current workspace.
 *
 * @param request - Transition request payload
 * @returns Proceed/cancel decision
 */
async function requestWorkspaceJumpApproval(
	request: WorkspaceTransitionRequest
): Promise<WorkspaceJumpApproval> {
	const choice = await request.ui.select("Directory jump — choose the landing zone", [
		`Enter ${request.targetCwd}`,
		`Stay in ${request.sourceCwd}`,
	]);
	if (!choice || choice.startsWith("Stay")) {
		return "cancel";
	}
	return "proceed";
}

/**
 * Ask how an untrusted target workspace should be opened.
 *
 * @param request - Transition request payload
 * @param trustStatus - Current trust status for the target workspace
 * @returns Trust/open/cancel decision
 */
async function requestWorkspaceTrustDecision(
	request: WorkspaceTransitionRequest,
	trustStatus: "untrusted" | "stale_fingerprint"
): Promise<WorkspaceTrustDecision> {
	const statusLabel =
		trustStatus === "stale_fingerprint"
			? "stale trust fingerprint detected"
			: "folder is untrusted";
	const choice = await request.ui.select(
		`Workspace trust gate — ${request.targetCwd} (${statusLabel})`,
		[
			"🔓 Trust folder + reload with repo-controlled surfaces enabled",
			"🔒 Open untrusted + reload with repo-controlled surfaces blocked",
			"✖ Cancel directory jump",
		]
	);
	if (!choice || choice.startsWith("✖")) {
		return "cancel";
	}
	if (choice.startsWith("🔓")) {
		return "trust";
	}
	return "untrusted";
}

/**
 * Resolve whether the target workspace should be trusted on entry.
 *
 * @param request - Transition request payload
 * @returns Final trust decision, or null when the user cancelled
 */
async function resolveTrustOnEntry(
	request: WorkspaceTransitionRequest,
	deps: WorkspaceTransitionDeps
): Promise<boolean | null> {
	const trustContext = deps.resolveTrust(request.targetCwd);
	if (trustContext.status === "trusted") {
		return true;
	}

	const decision = await requestWorkspaceTrustDecision(request, trustContext.status);
	if (decision === "cancel") {
		return null;
	}
	if (decision === "trust") {
		deps.trustProject(request.targetCwd);
		return true;
	}
	return false;
}

/**
 * Build session options for the transitioned workspace.
 *
 * @param baseOptions - CLI session options from the current invocation
 * @param previousSession - Current live session before transition
 * @param targetCwd - Target workspace directory
 * @param sessionId - Stable session ID for persisted sessions
 * @returns Session options for the recreated session
 */
function buildTransitionSessionOptions(
	baseOptions: TallowSessionOptions,
	previousSession: AgentSessionLike,
	targetCwd: string,
	sessionId: string
): TallowSessionOptions {
	const nextOptions: TallowSessionOptions = {
		...baseOptions,
		cwd: targetCwd,
		model: previousSession.model,
		thinkingLevel: previousSession.thinkingLevel,
	};
	if (baseOptions.session?.type === "memory") {
		nextOptions.session = { type: "memory" };
	} else {
		nextOptions.session = { type: "open-or-create", sessionId };
	}
	return nextOptions;
}

/**
 * Clear interactive-mode state that belongs to the previous session.
 *
 * @param mode - Interactive mode instance being reused
 * @returns Nothing
 */
function resetInteractiveModeState(mode: InteractiveModeLike): void {
	if (mode.loadingAnimation) {
		mode.loadingAnimation.stop();
		mode.loadingAnimation = undefined;
	}
	mode.statusContainer.clear();
	mode.pendingMessagesContainer.clear();
	mode.compactionQueuedMessages = [];
	mode.streamingComponent = undefined;
	mode.streamingMessage = undefined;
	mode.pendingTools.clear();
	mode.chatContainer.clear();
	mode.resetExtensionUI();
	mode.unsubscribe?.();
	mode.unsubscribe = undefined;

	// Clear terminal scrollback so stale content from the previous session
	// doesn't visually flow into the new session's startup output.
	mode.ui.requestScrollbackClear?.();
}

/**
 * Emit session_shutdown on the previous session before it is discarded.
 *
 * @param session - Current live session
 * @returns Nothing
 */
async function shutdownPreviousSession(session: AgentSessionLike): Promise<void> {
	const runner = session.extensionRunner;
	if (!runner?.hasHandlers("session_shutdown")) {
		return;
	}
	await runner.emit({ type: "session_shutdown" });
}

/**
 * Swap the interactive mode over to a newly created session.
 *
 * @param mode - Interactive mode instance being reused
 * @param next - Newly created tallow session
 * @param setCleanupSession - Updates process-cleanup session tracking
 * @returns Nothing
 */
async function swapInteractiveModeSession(
	mode: InteractiveModeLike,
	next: TallowSession,
	setCleanupSession: (session: TallowSession["session"]) => void
): Promise<void> {
	resetInteractiveModeState(mode);
	mode.session = next.session as AgentSessionLike;
	setCleanupSession(next.session);
	await mode.initExtensions();
	mode.renderInitialMessages();
	mode.subscribeToAgent();
	mode.updateTerminalTitle();
	mode.ui.requestRender(true);
}

/**
 * Build the one-shot synthetic custom message used after a tool-driven move.
 *
 * @param request - Transition request payload
 * @param trustedOnEntry - Whether the target workspace is trusted
 * @returns Synthetic custom message payload
 */
function createTransitionMessage(
	request: WorkspaceTransitionRequest,
	trustedOnEntry: boolean
): {
	customType: string;
	content: string;
	details: Record<string, unknown>;
	display: boolean;
} {
	return {
		customType: "workspace-transition",
		content: buildWorkspaceTransitionSummary(
			request.sourceCwd,
			request.targetCwd,
			request.initiator,
			trustedOnEntry
		),
		details: {
			from: request.sourceCwd,
			initiator: request.initiator,
			to: request.targetCwd,
			trustedOnEntry,
		},
		display: true,
	};
}

/**
 * Perform the session recreation and optional restarted turn.
 *
 * @param mode - Interactive mode instance being reused
 * @param baseOptions - Original CLI session options
 * @param request - Transition request payload
 * @param trustedOnEntry - Whether the target workspace should be trusted
 * @param sessionId - Stable session ID used for recreated persisted sessions
 * @param setCleanupSession - Updates process-cleanup session tracking
 * @returns Final transition result
 */
async function performSessionTransition(
	mode: InteractiveModeLike,
	baseOptions: TallowSessionOptions,
	request: WorkspaceTransitionRequest,
	trustedOnEntry: boolean,
	sessionId: string,
	setCleanupSession: (session: TallowSession["session"]) => void,
	deps: WorkspaceTransitionDeps
): Promise<WorkspaceTransitionResult> {
	const previousSession = mode.session;
	if (request.initiator === "tool") {
		previousSession.abort();
		await previousSession.agent.waitForIdle();
	}

	request.ui.setWorkingMessage("Reloading workspace after directory change...");
	try {
		await shutdownPreviousSession(previousSession);
		deps.changeDirectory(request.targetCwd);
		let next: TallowSession;
		try {
			next = await deps.createSession(
				buildTransitionSessionOptions(baseOptions, previousSession, request.targetCwd, sessionId)
			);
		} catch (error) {
			try {
				deps.changeDirectory(request.sourceCwd);
			} catch {
				// Best effort only — preserve the original session even if cwd rollback fails.
			}
			throw error;
		}
		await swapInteractiveModeSession(mode, next, setCleanupSession);

		const transitionMessage = createTransitionMessage(request, trustedOnEntry);
		if (request.initiator === "tool") {
			await mode.session.sendCustomMessage(transitionMessage, { triggerTurn: true });
		} else {
			await mode.session.sendCustomMessage(transitionMessage);
			mode.showStatus(`Changed to ${request.targetCwd}`);
		}
		return {
			status: "completed",
			trustedOnEntry,
		};
	} catch (error) {
		return {
			status: "unavailable",
			reason: error instanceof Error ? error.message : String(error),
		};
	} finally {
		request.ui.setWorkingMessage();
	}
}

/**
 * Create the interactive-mode-backed workspace-transition host.
 *
 * @param mode - Running interactive mode instance
 * @param sessionOptions - CLI session options used to create the current session
 * @param sessionId - Stable current session ID
 * @param setCleanupSession - Updates process-cleanup session tracking
 * @returns Host implementation used by /cd and the cd tool
 */
export function createInteractiveWorkspaceTransitionHost(
	mode: InteractiveModeLike,
	sessionOptions: TallowSessionOptions,
	sessionId: string,
	setCleanupSession: (session: TallowSession["session"]) => void,
	deps: WorkspaceTransitionDeps = DEFAULT_WORKSPACE_TRANSITION_DEPS
): WorkspaceTransitionHost {
	let transitionInFlight = false;

	return {
		async requestTransition(
			request: WorkspaceTransitionRequest
		): Promise<WorkspaceTransitionResult> {
			if (transitionInFlight) {
				return {
					status: "unavailable",
					reason: "Another workspace transition is already in progress.",
				};
			}
			if (request.targetCwd === request.sourceCwd) {
				return {
					status: "completed",
					trustedOnEntry: deps.resolveTrust(request.targetCwd).status === "trusted",
				};
			}

			const approval = await requestWorkspaceJumpApproval(request);
			if (approval === "cancel") {
				return { status: "cancelled" };
			}

			const trustedOnEntry = await resolveTrustOnEntry(request, deps);
			if (trustedOnEntry === null) {
				return { status: "cancelled" };
			}

			transitionInFlight = true;
			try {
				return await performSessionTransition(
					mode,
					sessionOptions,
					request,
					trustedOnEntry,
					sessionId,
					setCleanupSession,
					deps
				);
			} finally {
				transitionInFlight = false;
			}
		},
	};
}
