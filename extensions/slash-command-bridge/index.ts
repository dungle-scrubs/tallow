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

import type { ContextUsage, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

/**
 * Deferred compact request — set by the tool handler, consumed by the
 * `agent_end` hook. Deferring avoids the spinner-hang bug where
 * `ctx.compact()` aborts the agent mid-tool-call, orphaning the tool
 * execution UI component. See plans 95 and 98 for full analysis.
 */
let pendingCompact: { customInstructions?: string } | null = null;

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
	 * Fires compact after the agent finishes its turn. This avoids the
	 * spinner-hang caused by aborting the agent mid-tool-execution.
	 * The tool sets `pendingCompact`, then agent_end picks it up.
	 */
	pi.on("agent_end", (_event, ctx) => {
		if (!pendingCompact) return;

		const options = pendingCompact;
		pendingCompact = null;

		ctx.compact({
			customInstructions: options.customInstructions,
			onComplete: () => {
				// Framework's executeCompaction rebuilds the UI and
				// shows the compaction summary. No extra action needed.
			},
			onError: () => {
				// Framework's executeCompaction handles error/cancel
				// display. No extra handling needed.
			},
		});
	});

	/** Clear pending compact if the session switches before the turn ends. */
	pi.on("session_before_switch", () => {
		pendingCompact = null;
	});
}
