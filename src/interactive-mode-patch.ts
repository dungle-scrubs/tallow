import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

interface QueuedMessagesLike {
	followUp?: unknown[];
	steering?: unknown[];
}

interface InteractiveModeInstanceLike {
	defaultEditor?: { onEscape?: (() => void) | undefined };
	getAllQueuedMessages?: (() => QueuedMessagesLike) | undefined;
	loadingAnimation?: unknown;
	pendingWorkingMessage?: unknown;
	restoreQueuedMessagesToEditor?: ((options?: { abort?: boolean }) => unknown) | undefined;
	session?: { isStreaming?: boolean };
	statusContainer?: { clear?: (() => void) | undefined };
	ui?: { requestRender?: (() => void) | undefined };
	updatePendingMessagesDisplay?: (() => void) | undefined;
}

interface InteractiveModePrototypeLike {
	__tallow_stale_ui_patch_applied__?: boolean;
	createExtensionUIContext?: ((...args: unknown[]) => Record<string, unknown>) | undefined;
	handleEvent?: ((event: { type?: string }) => Promise<unknown>) | undefined;
	setupKeyHandlers?: ((...args: unknown[]) => unknown) | undefined;
}

const APPLY_FLAG = "__tallow_interactive_stale_ui_patch_applied__";

/** Matches messages that begin with an emoji/symbol icon. */
const LEADING_ICON_PATTERN = /^\s*\p{Extended_Pictographic}/u;

/**
 * Returns whether a notify message starts with an icon.
 *
 * Extension notify messages that already start with an icon (e.g. "⛔")
 * don't need the extra "Error:" prefix added by InteractiveMode error rendering.
 *
 * @param message - Notification message text
 * @returns True when the message starts with a leading icon
 */
function hasLeadingIcon(message: string): boolean {
	return LEADING_ICON_PATTERN.test(message);
}

/**
 * Returns whether queued steering/follow-up messages exist.
 *
 * @param messages - Queued messages snapshot
 * @returns True when either steering or follow-up queue is non-empty
 */
function hasQueuedMessages(messages: QueuedMessagesLike | undefined): boolean {
	if (!messages) return false;
	const steeringCount = Array.isArray(messages.steering) ? messages.steering.length : 0;
	const followUpCount = Array.isArray(messages.followUp) ? messages.followUp.length : 0;
	return steeringCount > 0 || followUpCount > 0;
}

/**
 * Patches InteractiveMode prototype methods to prevent stale UI carry-over.
 *
 * The patch adds:
 * - agent_end cleanup for pending working messages + pending-message refresh
 * - idle Escape behavior that clears queued steering/follow-up messages
 * - setWorkingMessage guard so idle non-empty updates don't queue stale text
 *
 * @param prototype - InteractiveMode prototype object
 * @returns Nothing
 */
export function patchInteractiveModePrototype(prototype: InteractiveModePrototypeLike): void {
	if (prototype.__tallow_stale_ui_patch_applied__) return;
	prototype.__tallow_stale_ui_patch_applied__ = true;

	const originalHandleEvent = prototype.handleEvent;
	if (typeof originalHandleEvent === "function") {
		prototype.handleEvent = async function (this: InteractiveModeInstanceLike, event) {
			const result = await originalHandleEvent.call(this, event);
			if (event?.type === "agent_end") {
				this.pendingWorkingMessage = undefined;
				this.statusContainer?.clear?.();
				this.updatePendingMessagesDisplay?.();
				this.ui?.requestRender?.();
			}
			return result;
		};
	}

	const originalSetupKeyHandlers = prototype.setupKeyHandlers;
	if (typeof originalSetupKeyHandlers === "function") {
		prototype.setupKeyHandlers = function (this: InteractiveModeInstanceLike, ...args: unknown[]) {
			const result = originalSetupKeyHandlers.call(this, ...args);
			const editor = this.defaultEditor;
			const existingEscape = editor?.onEscape;
			if (editor && typeof existingEscape === "function") {
				editor.onEscape = () => {
					const queued = this.getAllQueuedMessages?.();
					if (!this.loadingAnimation && hasQueuedMessages(queued)) {
						this.restoreQueuedMessagesToEditor?.({ abort: false });
						return;
					}
					existingEscape();
				};
			}
			return result;
		};
	}

	const originalCreateExtensionUIContext = prototype.createExtensionUIContext;
	if (typeof originalCreateExtensionUIContext === "function") {
		prototype.createExtensionUIContext = function (
			this: InteractiveModeInstanceLike,
			...args: unknown[]
		) {
			const context = originalCreateExtensionUIContext.call(this, ...args);
			const originalSetWorkingMessage = context.setWorkingMessage;
			if (typeof originalSetWorkingMessage === "function") {
				context.setWorkingMessage = (message?: string) => {
					const hasLoader = Boolean(this.loadingAnimation);
					const isStreaming = Boolean(this.session?.isStreaming);
					if (!hasLoader && !isStreaming && typeof message === "string" && message.length > 0) {
						return;
					}
					(originalSetWorkingMessage as (value?: string) => unknown)(message);
				};
			}

			const originalNotify = context.notify;
			if (typeof originalNotify === "function") {
				context.notify = (message: string, type?: "info" | "warning" | "error") => {
					if (type === "error" && hasLeadingIcon(message)) {
						(originalNotify as (msg: string, level?: "info" | "warning" | "error") => unknown)(
							message,
							"info"
						);
						return;
					}
					(originalNotify as (msg: string, level?: "info" | "warning" | "error") => unknown)(
						message,
						type
					);
				};
			}

			return context;
		};
	}
}

/**
 * Applies the stale UI patch to pi-coding-agent InteractiveMode.
 *
 * Uses a direct file import via resolved package path because the InteractiveMode
 * subpath is not exported from the package.
 *
 * @returns Nothing
 */
export async function applyInteractiveModeStaleUiPatch(): Promise<void> {
	const globals = globalThis as Record<string, unknown>;
	if (globals[APPLY_FLAG] === true) return;

	try {
		const require = createRequire(import.meta.url);
		const packageJsonPath = require.resolve("@mariozechner/pi-coding-agent/package.json");
		const packageRoot = dirname(packageJsonPath);
		const interactiveModePath = join(
			packageRoot,
			"dist",
			"modes",
			"interactive",
			"interactive-mode.js"
		);
		const moduleUrl = pathToFileURL(interactiveModePath).href;
		const mod = (await import(moduleUrl)) as {
			InteractiveMode?: { prototype?: InteractiveModePrototypeLike };
		};
		const prototype = mod.InteractiveMode?.prototype;
		if (!prototype) return;
		patchInteractiveModePrototype(prototype);
		globals[APPLY_FLAG] = true;
	} catch {
		// Non-fatal: patching is a runtime compatibility improvement.
	}
}
