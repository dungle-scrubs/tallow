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
import { Type } from "@sinclair/typebox";

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
		label: "Run Slash Command",
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
					// ctx.compact() is fire-and-forget: it calls session.abort(),
					// killing the agent mid-tool-call. The return value below will
					// almost certainly never be processed — the agent is dead before
					// it can read it. We pass onComplete/onError callbacks for
					// completeness, but the real UX is handled by the framework's
					// executeCompaction (Loader, Esc handler, summary component).
					ctx.compact({
						onComplete: () => {
							// Framework's executeCompaction already rebuilds the UI
							// and shows the compaction summary. No extra action needed.
						},
						onError: () => {
							// Framework's executeCompaction already shows error/cancel
							// messages in the UI. No extra handling needed.
						},
					});

					return {
						content: [
							{
								type: "text",
								text:
									"Session compaction initiated. The agent will be interrupted while " +
									"context is summarized. This is expected — the session will resume " +
									"with a compacted context after summarization completes.",
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
}
