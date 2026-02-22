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

import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	createMemoryReleaseCompletedEvent,
	MEMORY_RELEASE_EVENTS,
} from "../_shared/memory-release-events.js";

/** Deferred slash command waiting for the current turn to finish. */
interface DeferredCommand {
	readonly command: "compact" | "release-memory";
	readonly customInstructions?: string;
}

/**
 * Deferred command request — set by the tool handler, consumed by the
 * `agent_end` hook. Deferring avoids the spinner-hang bug where
 * `ctx.compact()` aborts the agent mid-tool-call, orphaning the tool
 * execution UI component. See plans 95 and 98 for full analysis.
 */
let pendingCommand: DeferredCommand | null = null;

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
	["release-memory", true],
]);

/** Human-readable descriptions for each bridged command. */
const COMMAND_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
	["show-system-prompt", "Returns the current system prompt text"],
	["context", "Returns context window usage breakdown (tokens used/remaining per category)"],
	["compact", "Triggers session compaction to free up context window space"],
	[
		"release-memory",
		"Compacts session context, then signals extensions to release rebuildable in-memory caches",
	],
]);

/**
 * Formats context usage into a readable summary.
 *
 * @param usage - Context usage data from the session
 * @returns Formatted string with token breakdown
 */
function formatContextUsage(usage: ContextUsage): string {
	const tokens = usage.tokens ?? 0;
	const pct = usage.contextWindow > 0 ? ((tokens / usage.contextWindow) * 100).toFixed(1) : "0";

	const lines = [
		`Context Usage: ${tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${pct}%)`,
		`Free: ${Math.max(0, usage.contextWindow - tokens).toLocaleString()} tokens`,
	];

	return lines.join("\n");
}

/**
 * Attempt to queue a deferred command for agent_end execution.
 *
 * @param next - Command to queue
 * @returns Error text when a command is already pending; otherwise undefined
 */
function queueDeferredCommand(next: DeferredCommand): string | undefined {
	if (!pendingCommand) {
		pendingCommand = next;
		return undefined;
	}

	return (
		`Cannot queue "/${next.command}" while "/${pendingCommand.command}" is already pending. ` +
		"Finish the current response so the queued operation can run first."
	);
}

/**
 * Emit a lifecycle event after memory release completes.
 *
 * @param pi - Extension API event bus
 * @param ctx - Extension context for warning notifications
 * @returns void
 */
function emitMemoryReleaseCompleted(pi: ExtensionAPI, ctx: ExtensionContext): void {
	try {
		pi.events.emit(MEMORY_RELEASE_EVENTS.completed, createMemoryReleaseCompletedEvent());
	} catch (_error) {
		ctx.ui?.notify?.(
			"Memory release completed, but extension cache cleanup handlers failed.",
			"warning"
		);
	}
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
- Need to compact or release memory to free up context space

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
					if (!usage) {
						return {
							content: [
								{
									type: "text",
									text: "No context usage data available yet. A message must be processed first.",
								},
							],
							details: { command, error: "no_usage_data" },
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: formatContextUsage(usage) }],
						details: {
							command,
							tokens: usage.tokens ?? 0,
							contextWindow: usage.contextWindow,
						},
					};
				}

				case "compact": {
					// Don't call ctx.compact() here — it aborts the agent mid-tool-call,
					// orphaning the tool execution spinner (plan 95/98). Defer to the
					// agent_end hook so the tool completes normally first.
					const queueError = queueDeferredCommand({
						command: "compact",
						customInstructions: undefined,
					});
					if (queueError) {
						return {
							content: [{ type: "text", text: queueError }],
							details: { command, error: "already_pending", pending: pendingCommand?.command },
							isError: true,
						};
					}

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

				case "release-memory": {
					const queueError = queueDeferredCommand({
						command: "release-memory",
						customInstructions: undefined,
					});
					if (queueError) {
						return {
							content: [{ type: "text", text: queueError }],
							details: { command, error: "already_pending", pending: pendingCommand?.command },
							isError: true,
						};
					}

					return {
						content: [
							{
								type: "text",
								text:
									"Session memory release will begin after this response completes. " +
									"tallow will compact context, then ask extensions to release " +
									"rebuildable caches. Do NOT call any more tools — finish your " +
									"response so memory release can start. If needed, use /rewind to recover.",
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

	pi.registerCommand("release-memory", {
		description: "Compact context and ask extensions to release rebuildable in-memory caches",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify(
					"Cannot release memory while the session is still busy. Wait for the current turn to finish.",
					"warning"
				);
				return;
			}
			if (pendingCommand) {
				ctx.ui.notify(
					`Cannot run /release-memory while /${pendingCommand.command} is pending.`,
					"warning"
				);
				return;
			}

			ctx.ui.setWorkingMessage("Releasing session memory…");
			ctx.ui.setStatus("release-memory", "🧹 releasing memory");
			ctx.compact({
				onComplete: () => {
					emitMemoryReleaseCompleted(pi, ctx);
					ctx.ui.setWorkingMessage();
					ctx.ui.setStatus("release-memory", undefined);
					ctx.ui.notify(
						"Memory release completed. Use /rewind if you need to recover recent context.",
						"info"
					);
				},
				onError: () => {
					ctx.ui.setWorkingMessage();
					ctx.ui.setStatus("release-memory", undefined);
				},
			});
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

	// ── Deferred compact/release ────────────────────────────────

	/**
	 * Fires deferred compact/release after the agent finishes its turn.
	 * This avoids the spinner-hang caused by aborting the agent
	 * mid-tool-execution. The tool sets `pendingCommand`, then agent_end
	 * picks it up.
	 */
	pi.on("agent_end", (_event, ctx) => {
		if (!pendingCommand) return;

		const command = pendingCommand;
		pendingCommand = null;

		const isReleaseMemory = command.command === "release-memory";
		const statusKey = isReleaseMemory ? "release-memory" : "compact";

		ctx.ui?.setWorkingMessage?.(
			isReleaseMemory ? "Releasing session memory…" : "Compacting session…"
		);
		ctx.ui?.setStatus?.(statusKey, isReleaseMemory ? "🧹 releasing memory" : "🧹 compacting");

		ctx.compact({
			customInstructions: command.customInstructions,
			onComplete: () => {
				if (isReleaseMemory) {
					emitMemoryReleaseCompleted(pi, ctx);
					ctx.ui?.notify?.(
						"Memory release completed. Use /rewind if you need to recover recent context.",
						"info"
					);
				}
				ctx.ui?.setWorkingMessage?.();
				ctx.ui?.setStatus?.(statusKey, undefined);
				// Framework's executeCompaction rebuilds the UI and
				// shows the compaction summary. No extra action needed.
			},
			onError: () => {
				ctx.ui?.setWorkingMessage?.();
				ctx.ui?.setStatus?.(statusKey, undefined);
				// Framework's executeCompaction handles error/cancel
				// display. No extra handling needed.
			},
		});
	});

	/** Clear pending deferred command if the session switches before the turn ends. */
	pi.on("session_before_switch", () => {
		pendingCommand = null;
	});
}
