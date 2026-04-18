import { recordResetDiagnostic } from "./reset-diagnostics.js";

/** Minimal status container shape required for reset orchestration. */
interface ClearableContainer {
	clear(): void;
}

/** Minimal loading-animation shape required for reset orchestration. */
interface ResetLoadingAnimation {
	stop?(): void;
}

/** Minimal UI shape required for reset orchestration. */
interface ResetUI {
	requestRender?(force?: boolean): void;
	requestScrollbackClear?(): void;
	resetRenderGrace?(): void;
}

/** Runtime shape shared by interactive reset call sites. */
export interface InteractiveResetModeLike {
	chatContainer: ClearableContainer;
	compactionQueuedMessages: unknown[];
	loadingAnimation?: ResetLoadingAnimation | null;
	pendingMessagesContainer: ClearableContainer;
	pendingTools: Map<string, unknown>;
	resetExtensionUI?(): void;
	streamingComponent?: unknown;
	streamingMessage?: unknown;
	statusContainer: ClearableContainer;
	ui: ResetUI;
	unsubscribe?: (() => void) | undefined;
}

/** Options controlling which reset responsibilities should run. */
export interface InteractiveResetOptions {
	readonly reason: string;
	readonly clearExtensionUi?: boolean;
	readonly clearSubscription?: boolean;
	readonly requestScrollbackClear?: boolean;
	readonly resetRenderGrace?: boolean;
}

/**
 * Clear shared interactive-mode session state at a session boundary.
 *
 * Owns loader/status/pending-message/transcript clearing. Callers decide
 * whether extension UI and subscriptions also belong to the reset boundary.
 *
 * @param mode - Interactive mode instance being reset
 * @param options - Reset behavior toggles and diagnostic reason
 * @returns Nothing
 */
export function resetInteractiveSessionState(
	mode: InteractiveResetModeLike,
	options: InteractiveResetOptions
): void {
	recordResetDiagnostic({ kind: "reset_start", reason: options.reason });

	if (mode.loadingAnimation) {
		mode.loadingAnimation.stop?.();
		mode.loadingAnimation = undefined;
	}
	mode.statusContainer.clear();
	mode.pendingMessagesContainer.clear();
	mode.compactionQueuedMessages = [];
	mode.streamingComponent = undefined;
	mode.streamingMessage = undefined;
	mode.pendingTools.clear();
	mode.chatContainer.clear();

	if (options.clearExtensionUi) {
		mode.resetExtensionUI?.();
	}
	if (options.clearSubscription) {
		mode.unsubscribe?.();
		mode.unsubscribe = undefined;
	}
	if (options.requestScrollbackClear) {
		mode.ui.requestScrollbackClear?.();
	}
	if (options.resetRenderGrace) {
		mode.ui.resetRenderGrace?.();
	}

	recordResetDiagnostic({ kind: "reset_complete", reason: options.reason });
}
