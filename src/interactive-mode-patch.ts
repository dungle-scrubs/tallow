import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { scheduleAfterIO } from "./yield-to-io.js";

interface QueuedMessagesLike {
	followUp?: unknown[];
	steering?: unknown[];
}

interface SessionLike {
	autoCompactionEnabled?: boolean;
	isStreaming?: boolean;
}

interface InteractiveModeInstanceLike {
	compactionQueuedMessages?: Array<unknown>;
	createExtensionUIContext?:
		| ((...args: unknown[]) => { notify?: ((...args: unknown[]) => unknown) | undefined })
		| undefined;
	defaultEditor?: { onEscape?: (() => void) | undefined };
	flushPendingBashComponents?: (() => void) | undefined;
	getAllQueuedMessages?: (() => QueuedMessagesLike) | undefined;
	loadingAnimation?: unknown;
	pendingWorkingMessage?: unknown;
	restoreQueuedMessagesToEditor?: ((options?: { abort?: boolean }) => unknown) | undefined;
	session?: SessionLike;
	statusContainer?: { clear?: (() => void) | undefined };
	ui?: { requestRender?: (() => void) | undefined };
	updatePendingMessagesDisplay?: (() => void) | undefined;
}

interface AssistantMessageLike {
	content?: unknown[];
	errorMessage?: string;
	role?: string;
	stopReason?: string;
}

interface InteractiveModeEventLike {
	aborted?: boolean;
	errorMessage?: string;
	message?: AssistantMessageLike;
	result?: unknown;
	type?: string;
	willRetry?: boolean;
}

interface InteractiveModePrototypeLike {
	__tallow_stale_ui_patch_applied__?: boolean;
	createExtensionUIContext?: ((...args: unknown[]) => Record<string, unknown>) | undefined;
	handleBashCommand?:
		| ((command: string, excludeFromContext?: boolean) => Promise<unknown>)
		| undefined;
	handleEvent?: ((event: InteractiveModeEventLike) => Promise<unknown>) | undefined;
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
 * Overflow error patterns mirrored from pi-ai overflow detection.
 *
 * Keeping these aligned prevents suppressing errors that would not trigger
 * compaction, and ensures overflow-specific UI suppression stays targeted.
 */
const OVERFLOW_ERROR_PATTERNS = [
	/prompt is too long/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
] as const;

/** UI-visible overflow summary appended when suppressing noisy provider payloads. */
const OVERFLOW_VISIBLE_INDICATOR_TEXT =
	"⚠️ Context overflow detected. Attempting auto-compaction recovery.";

/** Warning shown when auto-compaction promised retry but no continuation started. */
const COMPACTION_RETRY_STALLED_WARNING_TEXT =
	"Auto-compaction completed, but continuation did not start. Retry your last request, run /compact, or resend a shorter message.";

/** Warning shown when auto-compaction ended without result/error/abort signal. */
const AMBIGUOUS_COMPACTION_END_WARNING_TEXT =
	"Auto-compaction ended without a clear result. Retry your last request, run /compact, or resend your message after reducing context.";

/** Retry liveness timeout after auto_compaction_end before warning the user. */
const COMPACTION_RETRY_WATCHDOG_TIMEOUT_MS = 2_500;

const CONTINUATION_SIGNAL_EVENT_TYPES = new Set([
	"agent_start",
	"auto_retry_start",
	"message_start",
	"tool_execution_start",
	"turn_start",
]);

const compactionRetryWatchdogTimers = new WeakMap<
	InteractiveModeInstanceLike,
	ReturnType<typeof setTimeout>
>();

/**
 * Per-instance state for message_update coalescing.
 *
 * During high-frequency streaming, many `message_update` events fire per
 * second. Processing each one individually (update component + requestRender)
 * generates sustained microtask pressure that starves stdin I/O.
 *
 * By coalescing: only the latest `message_update` per I/O cycle is
 * processed. This caps UI updates to ~60fps while guaranteeing I/O yield
 * points between updates.
 *
 * @see Plan 176 — Input still blocked during streaming (Layer 2)
 * @see Plan 177 — Bun setImmediate does not yield to I/O
 */
interface MessageUpdateCoalesceState {
	/** The latest buffered message_update event, or null if none pending. */
	pendingEvent: InteractiveModeEventLike | null;
	/** Whether an I/O-yielding flush is already scheduled. */
	flushScheduled: boolean;
}

const messageUpdateCoalesceState = new WeakMap<
	InteractiveModeInstanceLike,
	MessageUpdateCoalesceState
>();

/**
 * Returns (or creates) the coalesce state for an interactive mode instance.
 *
 * @param mode - Interactive mode instance
 * @returns Coalesce state for this instance
 */
function getCoalesceState(mode: InteractiveModeInstanceLike): MessageUpdateCoalesceState {
	let state = messageUpdateCoalesceState.get(mode);
	if (!state) {
		state = { pendingEvent: null, flushScheduled: false };
		messageUpdateCoalesceState.set(mode, state);
	}
	return state;
}

/**
 * Immediately flushes any pending coalesced message_update event.
 *
 * Called before events that depend on streaming state being current
 * (message_end, agent_end, tool events) to prevent stale UI.
 *
 * @param mode - Interactive mode instance
 * @param handler - Original handleEvent to call with the flushed event
 * @returns Promise that resolves after the flush completes (or immediately if nothing pending)
 */
async function flushPendingMessageUpdate(
	mode: InteractiveModeInstanceLike,
	handler: (event: InteractiveModeEventLike) => Promise<unknown>
): Promise<void> {
	const state = getCoalesceState(mode);
	if (!state.pendingEvent) return;
	const event = state.pendingEvent;
	state.pendingEvent = null;
	await handler.call(mode, event);
}

/**
 * Returns whether assistant content includes tool calls.
 *
 * Overflow suppression is only safe when no tool calls are present. Tool-call
 * error rendering uses stopReason===error to mark pending tool components.
 *
 * @param content - Assistant message content blocks
 * @returns True when at least one content block is a tool call
 */
function hasToolCalls(content: unknown[] | undefined): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return (block as { type?: unknown }).type === "toolCall";
	});
}

/**
 * Returns whether an error string matches a context-overflow signature.
 *
 * @param errorMessage - Assistant error message
 * @returns True when the error message indicates context overflow
 */
function isContextOverflowErrorMessage(errorMessage: string): boolean {
	if (OVERFLOW_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
		return true;
	}
	// Some providers return only a status code with no body for overflow.
	return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(errorMessage);
}

/**
 * Returns content blocks with a concise overflow indicator appended exactly once.
 *
 * @param content - Assistant content blocks to clone/augment
 * @returns Cloned content blocks including visible overflow context
 */
function withOverflowIndicatorContent(content: unknown[] | undefined): unknown[] {
	const blocks = Array.isArray(content) ? [...content] : [];
	const alreadyAnnotated = blocks.some((block) => {
		if (!block || typeof block !== "object") return false;
		if ((block as { type?: unknown }).type !== "text") return false;
		const text = (block as { text?: unknown }).text;
		return typeof text === "string" && text.includes("Context overflow detected");
	});
	if (alreadyAnnotated) {
		return blocks;
	}
	blocks.push({
		text: OVERFLOW_VISIBLE_INDICATOR_TEXT,
		type: "text",
	});
	return blocks;
}

/**
 * Emits a user-facing notification via the extension UI context when available.
 *
 * @param mode - Interactive mode instance
 * @param message - Notification text
 * @param type - Notification severity
 * @returns Nothing
 */
function notifyFromInteractiveMode(
	mode: InteractiveModeInstanceLike,
	message: string,
	type: "info" | "warning" | "error"
): void {
	const createContext = mode.createExtensionUIContext;
	if (typeof createContext !== "function") return;
	const context = createContext.call(mode);
	const notify = context?.notify;
	if (typeof notify !== "function") return;
	notify(message, type);
}

/**
 * Clears the liveness watchdog timer for an interactive mode instance.
 *
 * @param mode - Interactive mode instance
 * @returns Nothing
 */
function clearCompactionRetryWatchdog(mode: InteractiveModeInstanceLike): void {
	const timer = compactionRetryWatchdogTimers.get(mode);
	if (!timer) return;
	clearTimeout(timer);
	compactionRetryWatchdogTimers.delete(mode);
}

/**
 * Arms a retry-liveness watchdog after auto_compaction_end with willRetry=true.
 *
 * @param mode - Interactive mode instance
 * @returns Nothing
 */
function armCompactionRetryWatchdog(mode: InteractiveModeInstanceLike): void {
	clearCompactionRetryWatchdog(mode);
	const timer = setTimeout(() => {
		compactionRetryWatchdogTimers.delete(mode);
		notifyFromInteractiveMode(mode, COMPACTION_RETRY_STALLED_WARNING_TEXT, "warning");
	}, COMPACTION_RETRY_WATCHDOG_TIMEOUT_MS);
	compactionRetryWatchdogTimers.set(mode, timer);
}

/**
 * Returns whether an event indicates compaction continuation has started.
 *
 * @param event - Interactive mode event
 * @returns True when the event means retry/continuation is alive
 */
function isCompactionContinuationSignal(event: InteractiveModeEventLike): boolean {
	if (typeof event.type !== "string") return false;
	return CONTINUATION_SIGNAL_EVENT_TYPES.has(event.type);
}

/**
 * Returns whether auto_compaction_end finished without result, abort, or error.
 *
 * @param event - Interactive mode event
 * @returns True when the compaction end state is ambiguous to users
 */
function isAmbiguousCompactionEndState(event: InteractiveModeEventLike): boolean {
	if (event.type !== "auto_compaction_end") return false;
	if (event.willRetry === true) return false;
	if (event.aborted === true) return false;
	if (event.result !== null && event.result !== undefined) return false;
	if (typeof event.errorMessage === "string" && event.errorMessage.trim().length > 0) return false;
	return true;
}

/**
 * Returns an event payload with overflow assistant error text suppressed for UI rendering.
 *
 * For overflow+auto-compaction, the dedicated loader line already communicates
 * state (`Context overflow detected, Auto-compacting...`). Showing an extra
 * assistant error line is redundant and noisy, especially for serialized JSON
 * payloads (for example `Codex error: {...}`).
 *
 * Instead of a raw provider payload, a concise overflow indicator is appended
 * so the final assistant render is still visibly diagnosable.
 *
 * The original event/message object must stay untouched: AgentSession keeps
 * using the same references for persistence and overflow-triggered compaction
 * checks after listener notifications.
 *
 * @param event - Interactive mode event payload
 * @param session - Session-like state used to inspect auto-compaction setting
 * @returns Original event or a shallow-cloned event for UI-only rendering
 */
function suppressOverflowAssistantErrorLine(
	event: InteractiveModeEventLike,
	session: SessionLike | undefined
): InteractiveModeEventLike {
	if (session?.autoCompactionEnabled === false) return event;
	if (event.type !== "message_end") return event;
	const message = event.message;
	if (!message || message.role !== "assistant") return event;
	if (message.stopReason !== "error") return event;
	if (typeof message.errorMessage !== "string") return event;
	if (!isContextOverflowErrorMessage(message.errorMessage)) return event;
	if (hasToolCalls(message.content)) return event;

	// Change stopReason for UI rendering only so assistant-message component
	// does not inject `Error: <payload>`. A concise text indicator keeps the
	// overflow state visible even when thinking blocks are hidden.
	return {
		...event,
		message: {
			...message,
			content: withOverflowIndicatorContent(message.content),
			errorMessage: undefined,
			stopReason: "stop",
		},
	};
}

/**
 * Patches InteractiveMode prototype methods to prevent stale UI carry-over.
 *
 * The patch adds:
 * - overflow error suppression before auto-compaction loader rendering
 * - visible overflow indicators (instead of silent hidden-thinking terminal state)
 * - retry liveness watchdog after auto-compaction retry handoff
 * - warning path for ambiguous auto-compaction terminal states
 * - agent_end cleanup for pending working messages + pending-message refresh
 * - post-bash flush/update so deferred bash output moves inline promptly
 * - idle Escape behavior that clears queued steering/follow-up messages
 * - extension notify normalization for icon-prefixed error messages
 * - compaction queue inspection helper for extension UI context
 *
 * @param prototype - InteractiveMode prototype object
 * @returns Nothing
 */
export function patchInteractiveModePrototype(prototype: InteractiveModePrototypeLike): void {
	if (prototype.__tallow_stale_ui_patch_applied__) return;
	prototype.__tallow_stale_ui_patch_applied__ = true;

	const originalHandleEvent = prototype.handleEvent;
	if (typeof originalHandleEvent === "function") {
		prototype.handleEvent = async function (
			this: InteractiveModeInstanceLike,
			event: InteractiveModeEventLike
		) {
			if (event?.type === "auto_compaction_start" || isCompactionContinuationSignal(event)) {
				clearCompactionRetryWatchdog(this);
			}

			// ── message_update coalescing (plan 176) ─────────────────────────
			// During rapid streaming, message_update fires per token. Coalesce
			// into one UI update per I/O cycle (~60fps) so the event loop
			// reaches the I/O poll phase and stdin stays responsive.
			//
			// Uses scheduleAfterIO instead of setImmediate because Bun's
			// setImmediate never enters the I/O poll phase. See plan 177.
			if (event?.type === "message_update") {
				const coalesce = getCoalesceState(this);
				// Keep AgentSession event references immutable.
				const uiEvent = suppressOverflowAssistantErrorLine(event, this.session);
				coalesce.pendingEvent = uiEvent;

				if (!coalesce.flushScheduled) {
					coalesce.flushScheduled = true;
					scheduleAfterIO(async () => {
						const state = getCoalesceState(this);
						state.flushScheduled = false;
						const pending = state.pendingEvent;
						state.pendingEvent = null;
						if (pending) {
							await originalHandleEvent.call(this, pending);
						}
					});
				}
				return;
			}

			// For events that depend on streaming state being current, flush
			// any pending message_update first so the component is up-to-date.
			if (
				event?.type === "message_end" ||
				event?.type === "agent_end" ||
				event?.type === "tool_execution_start" ||
				event?.type === "tool_execution_end"
			) {
				await flushPendingMessageUpdate(this, originalHandleEvent);
			}

			// Keep AgentSession event references immutable for persistence/compaction checks.
			const uiEvent = suppressOverflowAssistantErrorLine(event, this.session);
			const result = await originalHandleEvent.call(this, uiEvent);

			if (event?.type === "auto_compaction_end") {
				if (event.willRetry === true) {
					armCompactionRetryWatchdog(this);
				} else {
					clearCompactionRetryWatchdog(this);
				}
				if (isAmbiguousCompactionEndState(event)) {
					notifyFromInteractiveMode(this, AMBIGUOUS_COMPACTION_END_WARNING_TEXT, "warning");
				}
			}

			if (event?.type === "agent_end") {
				clearCompactionRetryWatchdog(this);
				this.pendingWorkingMessage = undefined;
				// NOTE: Do NOT clear statusContainer here — the original framework
				// guards this behind `if (this.loadingAnimation)`. Unconditionally
				// clearing it strips the compacting loader that extensions add during
				// model-triggered compaction (plan 159, bug 2).
				this.flushPendingBashComponents?.();
				this.updatePendingMessagesDisplay?.();
				this.ui?.requestRender?.();
			}
			return result;
		};
	}

	const originalHandleBashCommand = prototype.handleBashCommand;
	if (typeof originalHandleBashCommand === "function") {
		prototype.handleBashCommand = async function (
			this: InteractiveModeInstanceLike,
			command: string,
			excludeFromContext?: boolean
		) {
			const result = await originalHandleBashCommand.call(this, command, excludeFromContext);
			this.flushPendingBashComponents?.();
			this.updatePendingMessagesDisplay?.();
			this.ui?.requestRender?.();
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
			// NOTE: The original setWorkingMessage guard (plan 157/158) blocked ALL
			// non-empty messages when idle with no loader. This prevented stale text
			// but also dropped intentional post-compaction messages like "Resuming
			// task…". The guard is removed — stale messages are handled by the
			// agent_end patch clearing pendingWorkingMessage (plan 159, bug 3).
			// If stale messages recur, add a targeted guard using a compaction flag
			// rather than a blanket block.

			// Expose compaction queue status so extensions can check whether
			// flushCompactionQueue will handle resumption (plan 159, bug 1).
			// Read-only boolean — does not leak the full queue API.
			//
			// Only checks compactionQueuedMessages — the queue that
			// flushCompactionQueue() actually processes. Session-level
			// steering/followUp are consumed by the agent loop when a new
			// turn starts, not by the compaction flush. Previously this
			// checked getAllQueuedMessages() which included session steering,
			// causing a false positive that orphaned steering messages
			// typed before compact. See plan 160.
			context.hasCompactionQueuedMessages = () => {
				return (
					Array.isArray(this.compactionQueuedMessages) && this.compactionQueuedMessages.length > 0
				);
			};

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
