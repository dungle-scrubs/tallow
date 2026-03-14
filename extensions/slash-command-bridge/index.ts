/**
 * Slash Command Bridge Extension
 *
 * Exposes a curated set of slash commands as tools the model can invoke.
 * Phase 1: uses ExtensionContext methods directly for commands whose logic
 * is available in tool execution context (show-system-prompt, context, compact).
 *
 * Phase 2 (future): framework-level `allowModelInvocation` flag on command
 * registration, with auto-generated tool schemas and full command handler access.
 */

import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

/**
 * Deferred compact request — set by the tool handler, consumed on the first
 * safe assistant `turn_end` after the tool result. Deferring avoids the
 * spinner-hang bug where `ctx.compact()` aborts the agent mid-tool-call,
 * orphaning the tool execution UI component. See plans 95, 98, and 191.
 */
let pendingCompact: { customInstructions?: string } | null = null;

/**
 * Whether the extension is in the post-compaction "resuming" state.
 * Set when compaction completes and the agent will auto-continue.
 * Cleared on `turn_start` (loader is active), `session_before_switch`,
 * or when `!isIdle()` (user sent a message during compaction).
 */
let resumingAfterCompact = false;

/**
 * Timer handle for the auto-continue delay after compaction.
 * Cancelled if a `turn_start` fires before the timer expires (indicating
 * `flushCompactionQueue` or user input already prompted the agent), or
 * on session switch. See plan 159, bug 1.
 */
let continuationTimer: SchedulerHandle | null = null;

/** Spinner frames for compact progress status updates. */
const COMPACT_PROGRESS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Interval cadence for compact progress status updates. */
const COMPACT_PROGRESS_INTERVAL_MS = 1000;

type SchedulerHandle = unknown;

/** Timer scheduler used by compact UI and continuation timers. */
export interface SlashCommandBridgeTimerScheduler {
	readonly now: () => number;
	readonly setInterval: (callback: () => void, intervalMs: number) => SchedulerHandle;
	readonly clearInterval: (handle: SchedulerHandle | null) => void;
	readonly setTimeout: (callback: () => void, delayMs: number) => SchedulerHandle;
	readonly clearTimeout: (handle: SchedulerHandle | null) => void;
}

/** Default runtime timer scheduler. */
const DEFAULT_TIMER_SCHEDULER: SlashCommandBridgeTimerScheduler = {
	now: () => Date.now(),
	setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
	clearInterval: (handle) => {
		if (handle) {
			clearInterval(handle as ReturnType<typeof setInterval>);
		}
	},
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => {
		if (handle) {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		}
	},
};

let timerScheduler: SlashCommandBridgeTimerScheduler = DEFAULT_TIMER_SCHEDULER;

/** Module-level heartbeat state for deferred compact UI updates. */
const compactProgressState: {
	interval: SchedulerHandle | null;
	spinnerIndex: number;
	startedAt: number;
} = {
	interval: null,
	spinnerIndex: 0,
	startedAt: 0,
};

/**
 * Starts compact progress heartbeat updates in the footer status.
 *
 * This helper is idempotent: it always clears any previous heartbeat before
 * starting a new one, preventing duplicate intervals after retries.
 *
 * @param ctx - Extension context used to update footer status
 * @returns Nothing
 */
function startCompactProgress(ctx: ExtensionContext): void {
	stopCompactProgress();

	if (!ctx.ui?.setStatus) {
		return;
	}

	compactProgressState.startedAt = timerScheduler.now();
	compactProgressState.spinnerIndex = 0;

	const renderStatus = () => {
		const elapsedSeconds = Math.floor(
			(timerScheduler.now() - compactProgressState.startedAt) / 1000
		);
		const frame =
			COMPACT_PROGRESS_FRAMES[compactProgressState.spinnerIndex] ?? COMPACT_PROGRESS_FRAMES[0];
		ctx.ui?.setStatus?.("compact", `🧹 ${frame} compacting · ${elapsedSeconds}s`);
		compactProgressState.spinnerIndex =
			(compactProgressState.spinnerIndex + 1) % COMPACT_PROGRESS_FRAMES.length;
	};

	renderStatus();
	compactProgressState.interval = timerScheduler.setInterval(
		renderStatus,
		COMPACT_PROGRESS_INTERVAL_MS
	);
}

/**
 * Stops compact progress heartbeat updates and resets module-level state.
 *
 * @returns Nothing
 */
function stopCompactProgress(): void {
	if (compactProgressState.interval) {
		timerScheduler.clearInterval(compactProgressState.interval);
		compactProgressState.interval = null;
	}

	compactProgressState.startedAt = 0;
	compactProgressState.spinnerIndex = 0;
}

/**
 * Cancels the pending continuation timer, if one exists.
 *
 * @returns Nothing
 */
function clearContinuationTimer(): void {
	if (!continuationTimer) {
		return;
	}

	timerScheduler.clearTimeout(continuationTimer);
	continuationTimer = null;
}

/**
 * Resets module-level compact state between runs or tests.
 *
 * @returns Nothing
 */
function clearCompactRuntimeState(): void {
	pendingCompact = null;
	resumingAfterCompact = false;
	stopCompactProgress();
	clearContinuationTimer();
}

/**
 * Installs a deterministic timer scheduler for tests.
 *
 * @param scheduler - Test scheduler implementation
 * @returns Nothing
 */
export function setSlashCommandBridgeSchedulerForTests(
	scheduler: SlashCommandBridgeTimerScheduler
): void {
	clearCompactRuntimeState();
	timerScheduler = scheduler;
}

/**
 * Resets test scheduler/state overrides back to runtime defaults.
 *
 * @returns Nothing
 */
export function resetSlashCommandBridgeStateForTests(): void {
	clearCompactRuntimeState();
	timerScheduler = DEFAULT_TIMER_SCHEDULER;
}

/**
 * Commands the model is allowed to invoke.
 * Maps command name → whether it's executable from tool context.
 *
 * - `true`: can be executed using ExtensionContext methods
 * - `false`: requires ExtensionCommandContext (not available in tools)
 */
const ALLOWED_COMMANDS: ReadonlyMap<string, boolean> = new Map([
	["show-system-prompt", true],
	["context", true],
	["compact", true],
]);

/** Human-readable descriptions for each bridged command. */
const COMMAND_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
	["show-system-prompt", "Returns the current system prompt text"],
	["context", "Returns context window usage breakdown (tokens used/remaining per category)"],
	["compact", "Triggers session compaction to free up context window space"],
]);

/** Context usage with a known finite token count. */
interface KnownContextUsage extends ContextUsage {
	readonly tokens: number;
}

/** Shared no-data message for /context parity. */
const NO_CONTEXT_USAGE_DATA_TEXT =
	"No context usage data available yet. A message must be processed first.";

/**
 * Returns true when context usage exists and tokens are known.
 *
 * @param usage - Context usage snapshot from session state
 * @returns True when the usage token count is a finite number
 */
function hasKnownContextTokens(usage: ContextUsage | undefined): usage is KnownContextUsage {
	return typeof usage?.tokens === "number" && Number.isFinite(usage.tokens);
}

/**
 * Builds the shared no-usage result payload for `/context` parity.
 *
 * @param command - Bridged command name
 * @returns Tool error payload for unavailable usage data
 */
function buildNoUsageDataResult(command: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: NO_CONTEXT_USAGE_DATA_TEXT,
			},
		],
		details: { command, error: "no_usage_data" as const },
		isError: true,
	};
}

/**
 * Formats context usage into a readable summary.
 *
 * @param usage - Context usage data from the session
 * @returns Formatted string with token breakdown
 */
function formatContextUsage(usage: KnownContextUsage): string {
	const tokens = usage.tokens;
	const pct = usage.contextWindow > 0 ? ((tokens / usage.contextWindow) * 100).toFixed(1) : "0";

	const lines = [
		`Context Usage: ${tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${pct}%)`,
		`Free: ${Math.max(0, usage.contextWindow - tokens).toLocaleString()} tokens`,
	];

	return lines.join("\n");
}

/**
 * Returns true when the current turn_end is the first safe compaction boundary.
 *
 * The compact tool always finishes on a `toolUse` turn first. The model then
 * gets one more assistant turn to finish its response after seeing the tool
 * result. Consuming the request on `agent_end` is too late: `session.prompt()`
 * returns before prior `agent_end` extension work fully drains, so a stale
 * `agent_end` from the previous run can steal a newer compact request. The
 * first assistant `turn_end` whose stop reason is not `toolUse` is the proven
 * boundary for starting deferred compaction exactly once.
 *
 * @param event - Turn lifecycle event
 * @returns True when deferred compaction should start now
 */
function shouldStartDeferredCompactOnTurnEnd(event: TurnEndEvent): boolean {
	return event.message.role === "assistant" && event.message.stopReason !== "toolUse";
}

/**
 * Starts the deferred compact flow and wires continuation/error cleanup.
 *
 * @param pi - Extension API used to enqueue the hidden continuation message
 * @param ctx - Extension context with compact/UI capabilities
 * @param options - Deferred compact request options
 * @returns Nothing
 */
function startDeferredCompact(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { customInstructions?: string }
): void {
	// Show explicit UI feedback while compaction runs. Without this,
	// users only see the deferred tool message and no live progress signal.
	ctx.ui?.setWorkingMessage?.("Compacting session…");
	startCompactProgress(ctx);

	ctx.compact({
		customInstructions: options.customInstructions,
		onComplete: () => {
			stopCompactProgress();

			// Transition from compaction indicators to resuming indicators.
			// setWorkingMessage queues as pendingWorkingMessage (no loader
			// exists after executeCompaction stops it). Applied automatically
			// when agent_start creates the loader. Footer status is visible
			// immediately — covers the brief gap before the loader appears.
			resumingAfterCompact = true;
			ctx.ui?.setWorkingMessage?.("Resuming task…");
			ctx.ui?.setStatus?.("compact", "⏳ resuming");

			// Always schedule continuation. Safety nets prevent duplicate prompts:
			// 1. turn_start listener cancels if flushCompactionQueue already started a turn
			// 2. isIdle() check at timer expiry skips if agent is streaming
			// 3. sendCustomMessage queues as steering if agent started mid-delay
			//
			// Previously gated on hasCompactionQueuedMessages(), but that method
			// checked both the compaction queue AND session steering — causing a
			// false positive when steering messages were queued before compact.
			// flushCompactionQueue only processes compactionQueuedMessages, so
			// session steering messages were orphaned. See plan 160.
			//
			// 200ms gives session.prompt()'s async setup (API key resolution,
			// compaction check) time to settle. The turn_start listener cancels
			// this timer if a turn starts before it fires (defense-in-depth).
			continuationTimer = timerScheduler.setTimeout(() => {
				continuationTimer = null;
				if (ctx.isIdle()) {
					pi.sendMessage(
						{
							customType: "compact-continue",
							content:
								"Session compaction is complete. Continue with the task " +
								"you were working on before compaction was triggered.",
							display: false,
						},
						{ triggerTurn: true }
					);
				} else {
					// User sent a message during compaction — their turn is
					// handling things, clean up our indicators.
					resumingAfterCompact = false;
					ctx.ui?.setStatus?.("compact", undefined);
					ctx.ui?.setWorkingMessage?.();
				}
			}, 200);
		},
		onError: () => {
			stopCompactProgress();
			ctx.ui?.setWorkingMessage?.();
			ctx.ui?.setStatus?.("compact", undefined);
			// Framework's executeCompaction handles error/cancel
			// display. No continuation on failure — user decides.
		},
	});
}

/**
 * Registers the slash-command-bridge tool and context injection.
 *
 * @param pi - Extension API for registering tools and event handlers
 */
export default function slashCommandBridge(pi: ExtensionAPI): void {
	// Build the list of available command names for the tool description
	const commandList = Array.from(ALLOWED_COMMANDS.keys())
		.map((name) => `- ${name}: ${COMMAND_DESCRIPTIONS.get(name) ?? "No description"}`)
		.join("\n");

	pi.registerTool({
		name: "run_slash_command",
		label: "run_slash_command",
		description: `Invoke a slash command programmatically. Use this when you need to perform session management or introspection actions.

Available commands:
${commandList}

WHEN TO USE:
- Need to check the system prompt for debugging
- Need to see context window usage before deciding to compact
- Need to compact the session to free up context space

WHEN NOT TO USE:
- The user already ran the command themselves
- You want to start a new session (suggest the user run /clear instead)`,
		parameters: Type.Object({
			command: Type.String({
				description:
					"Slash command name (without the / prefix). " +
					`One of: ${Array.from(ALLOWED_COMMANDS.keys()).join(", ")}`,
			}),
		}),

		/**
		 * Renders the tool call header showing which command is being invoked.
		 *
		 * @param args - Tool arguments containing the command name
		 * @param theme - Theme for styling
		 * @returns Text component with styled command display
		 */
		renderCall(args, theme) {
			const cmd = args.command ?? "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("run_slash_command ")) + theme.fg("accent", `/${cmd}`),
				0,
				0
			);
		},

		/**
		 * Executes the requested slash command.
		 *
		 * @param _toolCallId - Unique tool call identifier
		 * @param params - Parameters containing the command name
		 * @param _signal - Abort signal (unused)
		 * @param _onUpdate - Update callback (unused)
		 * @param ctx - Extension context with session access
		 * @returns Tool result with command output
		 */
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { command } = params;

			// Reject unknown commands
			if (!ALLOWED_COMMANDS.has(command)) {
				const available = Array.from(ALLOWED_COMMANDS.keys()).join(", ");
				return {
					content: [
						{
							type: "text",
							text: `Unknown command: "${command}". Available commands: ${available}`,
						},
					],
					details: { command, error: "unknown_command" },
					isError: true,
				};
			}

			// Reject commands that need ExtensionCommandContext
			if (!ALLOWED_COMMANDS.get(command)) {
				return {
					content: [
						{
							type: "text",
							text:
								`Command "/${command}" cannot be invoked by the model yet — it requires ` +
								"user-level session control. Suggest the user run it directly.",
						},
					],
					details: { command, error: "requires_command_context" },
					isError: true,
				};
			}

			// Dispatch to the appropriate handler
			switch (command) {
				case "show-system-prompt": {
					const prompt = ctx.getSystemPrompt();
					return {
						content: [{ type: "text", text: prompt }],
						details: { command, length: prompt.length },
					};
				}

				case "context": {
					const usage = ctx.getContextUsage();
					if (!hasKnownContextTokens(usage)) {
						return buildNoUsageDataResult(command);
					}
					return {
						content: [{ type: "text", text: formatContextUsage(usage) }],
						details: {
							command,
							tokens: usage.tokens,
							contextWindow: usage.contextWindow,
						},
					};
				}

				case "compact": {
					// Don't call ctx.compact() here — it aborts the agent mid-tool-call,
					// orphaning the tool execution spinner (plan 95/98). Defer to a
					// proven turn_end boundary so the tool completes normally first.
					pendingCompact = { customInstructions: undefined };

					return {
						content: [
							{
								type: "text",
								text:
									"Session compaction will begin after this response completes. " +
									"Do NOT call any more tools — finish your response so " +
									"compaction can start.",
							},
						],
						details: { command },
					};
				}

				default: {
					// Exhaustiveness guard — should never reach here
					return {
						content: [{ type: "text", text: `Unhandled command: ${command}` }],
						details: { command, error: "unhandled" },
						isError: true,
					};
				}
			}
		},
	});

	// ── Context injection ────────────────────────────────────────

	pi.on("before_agent_start", async () => {
		const bridgedCommands = Array.from(ALLOWED_COMMANDS.keys())
			.map((name) => `/${name}`)
			.join(", ");

		return {
			message: {
				customType: "slash-command-bridge-context",
				content:
					`You can invoke these slash commands programmatically via the run_slash_command tool: ${bridgedCommands}. ` +
					"For other slash commands, suggest the user run them directly.",
				display: false,
			},
		};
	});

	// ── Deferred compact ─────────────────────────────────────────

	/**
	 * Fires compact on the first safe assistant `turn_end` after the compact tool
	 * returns. The immediate `toolUse` turn is too early because the model has not
	 * finished its post-tool response yet, while `agent_end` is too late because a
	 * stale `agent_end` from the previous run can steal a newer pending request.
	 *
	 * @see Plan 98 — deferred compact moved out of the tool handler
	 * @see Plan 157 — auto-continue after model-triggered compaction
	 * @see Plan 191 — stale prior agent_end could consume a later compact request
	 */
	pi.on("turn_end", (event, ctx) => {
		if (!pendingCompact || !shouldStartDeferredCompactOnTurnEnd(event)) {
			return;
		}

		const options = pendingCompact;
		pendingCompact = null;
		startDeferredCompact(pi, ctx, options);
	});

	/**
	 * Cancel the auto-continue timer and clear resuming status on turn start.
	 *
	 * If a turn starts before the 200ms timer fires, something else already
	 * prompted the agent (flushCompactionQueue or user input). Cancel the
	 * timer to avoid a duplicate prompt race (plan 159, bug 1 defense-in-depth).
	 *
	 * Also clears the footer "⏳ resuming" status — the loading spinner is
	 * now active and showing the pending working message ("Resuming task…").
	 */
	pi.on("turn_start", (_event, ctx) => {
		clearContinuationTimer();
		if (!resumingAfterCompact) return;
		resumingAfterCompact = false;
		ctx.ui?.setStatus?.("compact", undefined);
	});

	/**
	 * Clear pending compact, resuming state, and continuation timer if the
	 * session switches before the turn ends.
	 */
	pi.on("session_before_switch", (_event, ctx) => {
		clearCompactRuntimeState();
		ctx.ui?.setStatus?.("compact", undefined);
		ctx.ui?.setWorkingMessage?.();
	});
}
