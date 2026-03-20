/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan-mode command or Ctrl+Alt+P to toggle
 * - Strict fail-closed tool allowlist while plan mode is active
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - Delegates execution tracking to the tasks extension
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	type EditorTheme,
	Key,
	Loader,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import { renderBorderedBox } from "../_shared/bordered-box.js";
import {
	detectPlanIntent,
	extractTodoItems,
	isPlanModeToolAllowed,
	isSafeCommand,
	PLAN_MODE_ALLOWED_TOOLS,
	stripPlanIntent,
	type TodoItem,
} from "./utils.js";

/**
 * Type guard to check if a message is an assistant message.
 * @param m - The message to check
 * @returns true if the message is from the assistant
 */
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

/**
 * Extracts all text content from an assistant message.
 * @param message - The assistant message to extract text from
 * @returns Concatenated text content
 */
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Plan mode label shown in the editor border */
const PLAN_LABEL = ` ${getIcon("plan_mode")} PLAN `;

/**
 * Custom editor that renders a warning-colored border in plan mode.
 * Extends CustomEditor to preserve all app keybindings.
 */
class PlanModeEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, { ...theme, borderColor: (s: string) => `\x1b[33m${s}\x1b[39m` }, keybindings);
	}

	/**
	 * Renders the editor with a PLAN label in the top border.
	 * @param width - Available width
	 * @returns Array of rendered lines
	 */
	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length > 0) {
			const label = `\x1b[33;1m${PLAN_LABEL}\x1b[22;39m`;
			const first = lines[0];
			const vis = visibleWidth(first);
			const labelVis = visibleWidth(PLAN_LABEL);
			if (vis >= labelVis + 4) {
				lines[0] = truncateToWidth(first, width - labelVis, "") + label;
			}
		}
		return lines;
	}
}

/**
 * Registers the plan mode extension with Pi.
 * Provides read-only exploration mode with progress tracking.
 * @param pi - The Pi extension API
 */
export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let todoItems: TodoItem[] = [];
	let normalModeTools: string[] = [];

	/**
	 * Capture the active tools used outside plan mode.
	 *
	 * @returns Snapshot of normal-mode tools
	 */
	function captureNormalModeTools(): string[] {
		const activeTools = pi.getActiveTools();
		normalModeTools =
			activeTools.length > 0 ? [...activeTools] : pi.getAllTools().map((t) => t.name);
		return normalModeTools;
	}

	/**
	 * Resolve allowlisted tools that exist in the current session.
	 *
	 * @returns Plan-mode tool list constrained to the strict allowlist
	 */
	function getPlanModeTools(): string[] {
		const availableTools = new Set(pi.getAllTools().map((t) => t.name));
		return PLAN_MODE_ALLOWED_TOOLS.filter((name) => availableTools.has(name));
	}

	/**
	 * Apply strict read-only tool policy for plan mode.
	 *
	 * @returns The active allowlisted tool names
	 */
	function applyPlanModeTools(): string[] {
		const tools = getPlanModeTools();
		pi.setActiveTools(tools);
		return tools;
	}

	/**
	 * Restore the normal tool set captured before plan mode was enabled.
	 *
	 * @returns Restored normal-mode tool names
	 */
	function restoreNormalModeTools(): string[] {
		if (normalModeTools.length === 0) {
			captureNormalModeTools();
		}
		pi.setActiveTools(normalModeTools);
		return normalModeTools;
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	/**
	 * Updates visual indicators: footer status, editor border, and widgets.
	 * Plan mode gets a warning-colored editor border with PLAN label,
	 * a custom footer bar, and the todo widget when executing.
	 * @param ctx - The extension context
	 */
	function updateStatus(ctx: ExtensionContext): void {
		// Footer status — plan mode only
		if (planModeEnabled) {
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("warning", `${getIcon("plan_mode")} PLAN MODE — read-only`)
			);
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Editor border: warning-colored in plan mode, default otherwise
		if (planModeEnabled) {
			ctx.ui.setEditorComponent(
				(tui, theme, keybindings) => new PlanModeEditor(tui, theme, keybindings)
			);
		} else {
			ctx.ui.setEditorComponent(undefined);
		}

		// Full-width banner above editor — plan mode only.
		if (planModeEnabled) {
			ctx.ui.setWidget("plan-banner", (_tui, theme) => {
				const label = " PLAN MODE — READ ONLY ";
				return {
					render: (width: number) => [
						theme.bg("customMessageBg", theme.fg("customMessageLabel", label.padEnd(width))),
					],
					invalidate() {},
				};
			});
		} else {
			ctx.ui.setWidget("plan-banner", undefined);
		}

		ctx.ui.setWidget("plan-todos", undefined);
	}

	/**
	 * Toggles plan mode on or off.
	 * @param ctx - The extension context
	 */
	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		todoItems = [];

		if (planModeEnabled) {
			captureNormalModeTools();
			const tools = applyPlanModeTools();
			ctx.ui.notify(`Plan mode enabled. Strict read-only tools: ${tools.join(", ")}`);
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Previous tool access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	/**
	 * Persists the current plan mode state to the session.
	 */
	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			normalTools: normalModeTools,
			todos: todoItems,
		});
	}

	pi.registerCommand("plan-mode", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan-mode", "info");
				return;
			}
			const list = todoItems
				.map(
					(item, i) =>
						`${i + 1}. ${item.completed ? getIcon("success") : getIcon("idle")} ${item.text}`
				)
				.join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Tool for the agent to toggle plan mode programmatically
	pi.registerTool({
		name: "plan_mode",
		label: "plan_mode",
		description: `Toggle plan mode on or off. Plan mode is a strict read-only exploration mode for safe code analysis.

When enabled:
- Only allowlisted read-only tools are available (read, bash, grep, find, ls, questionnaire, plan_mode)
- All other tools are blocked fail-closed (including extension tools)
- Bash is additionally restricted to safe read-only commands

Use action "enable" to enter plan mode, "disable" to exit, or "status" to check current state.`,
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("enable"), Type.Literal("disable"), Type.Literal("status")],
				{
					description: "Whether to enable, disable, or check plan mode status",
				}
			),
		}),

		/**
		 * Toggles plan mode or reports current status.
		 * @param _toolCallId - Unique identifier for this tool call
		 * @param params - Action to perform (enable/disable/status)
		 * @param _signal - Abort signal
		 * @param _onUpdate - Update callback
		 * @param ctx - Extension context
		 * @returns Tool result with the new state
		 */
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action } = params;

			if (action === "status") {
				const mode = planModeEnabled ? "planning" : "normal";
				const tools = planModeEnabled ? getPlanModeTools() : pi.getActiveTools();
				return {
					content: [
						{
							type: "text",
							text: `Plan mode: ${mode}\nActive tools: ${tools.join(", ")}${
								todoItems.length > 0
									? `\nTodos: ${todoItems.filter((t) => t.completed).length}/${todoItems.length} completed`
									: ""
							}`,
						},
					],
					details: {},
				};
			}

			const shouldEnable = action === "enable";

			if (shouldEnable === planModeEnabled) {
				return {
					content: [
						{
							type: "text",
							text: `Plan mode is already ${shouldEnable ? "enabled" : "disabled"}.`,
						},
					],
					details: {},
				};
			}

			planModeEnabled = shouldEnable;
			todoItems = [];

			let activeTools: string[];
			if (planModeEnabled) {
				captureNormalModeTools();
				activeTools = applyPlanModeTools();
			} else {
				activeTools = restoreNormalModeTools();
			}

			if (ctx.hasUI) {
				updateStatus(ctx);
			}
			persistState();

			return {
				content: [
					{
						type: "text",
						text: planModeEnabled
							? `Plan mode enabled. Strict allowlist active: ${activeTools.join(", ")}. All other tools are blocked.`
							: "Plan mode disabled. Previous tool access restored.",
					},
				],
				details: {},
			};
		},
	});

	// Enforce strict plan-mode allowlist and safe bash commands
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;

		if (!isPlanModeToolAllowed(event.toolName)) {
			const reason =
				`Plan mode: tool "${event.toolName}" blocked (not in strict read-only allowlist). ` +
				"Disable plan mode first to use this tool.";
			ctx.ui?.notify(`⛔ ${reason}`, "error");
			return { block: true, reason };
		}

		if (event.toolName !== "bash") return;

		const command =
			typeof event.input.command === "string" ? event.input.command : String(event.input.command);
		if (!isSafeCommand(command)) {
			const reason =
				"Plan mode: bash command blocked (not in read-only command allowlist). " +
				`Disable plan mode first to run it.\nCommand: ${command}`;
			ctx.ui?.notify(`⛔ ${reason}`, "error");
			return { block: true, reason };
		}
	});

	// Auto-enable plan mode when a human interactive session explicitly signals planning intent.
	pi.on("input", async (event, ctx) => {
		// No-op if already in plan mode
		if (planModeEnabled) {
			return { action: "continue" as const };
		}

		// Headless/orchestrated prompts should never toggle workflow modes via string matching.
		if (!ctx.hasUI || event.source !== "interactive") {
			return { action: "continue" as const };
		}

		if (!detectPlanIntent(event.text)) {
			return { action: "continue" as const };
		}

		// Auto-enable plan mode
		planModeEnabled = true;
		captureNormalModeTools();
		applyPlanModeTools();
		updateStatus(ctx);
		persistState();

		ctx.ui?.notify(
			"Plan mode auto-enabled (detected planning intent). Use /plan-mode or Ctrl+Alt+P to disable.",
			"info"
		);

		// Strip the plan-intent phrase, keep the actual request
		const stripped = stripPlanIntent(event.text);
		if (stripped !== event.text) {
			return { action: "transform" as const, text: stripped };
		}
		return { action: "continue" as const };
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]")
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use strict allowlisted read-only tools: read, bash, grep, find, ls, questionnaire, plan_mode
- All other tools are blocked fail-closed (including edit, write, bg_bash, subagent, and mcp__* tools)
- Bash is additionally restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use bash only for safe inspection commands.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		if (!(planModeEnabled && ctx.hasUI)) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		// Show plan steps in a bordered widget above the editor
		if (todoItems.length > 0) {
			ctx.ui.setWidget("plan-steps", (_tui, theme) => ({
				render(width: number): string[] {
					const stepLines = todoItems.map(
						(t) => `${theme.fg("muted", `${getIcon("pending")} `)}${t.text}`
					);
					return renderBorderedBox(stepLines, width, {
						title: `PLAN (${todoItems.length} steps)`,
						style: "rounded",
						borderColorFn: (s: string) => theme.fg("warning", s),
						titleColorFn: (s: string) => theme.fg("warning", s),
					});
				},
				invalidate() {},
			}));
		}

		ctx.ui.setWorkingMessage(Loader.HIDE);

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		// Clear the plan steps widget after user makes a choice
		ctx.ui.setWidget("plan-steps", undefined);

		if (choice?.startsWith("Execute")) {
			const steps = [...todoItems];
			planModeEnabled = false;
			todoItems = [];
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const stepList = steps.map((t) => `${t.step}. ${t.text}`).join("\n");
			const execMessage =
				steps.length > 0
					? `Execute this plan. Create tasks to track each step, then work through them:\n\n${stepList}`
					: "Execute the plan you just created.";
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true }
			);
		} else if (choice === "Stay in plan mode") {
			ctx.ui.notify("Staying in plan mode. Continue refining or ask follow-up questions.", "info");
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			} else {
				ctx.ui.notify("No refinement provided. Plan unchanged.", "info");
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-mode"
			)
			.pop() as
			| {
					data?: {
						enabled?: boolean;
						normalTools?: string[];
						todos?: TodoItem[];
					};
			  }
			| undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			normalModeTools = planModeEntry.data.normalTools ?? normalModeTools;
			todoItems = planModeEntry.data.todos ?? todoItems;
		}

		if (normalModeTools.length === 0) {
			captureNormalModeTools();
		}
		if (planModeEnabled) {
			applyPlanModeTools();
		} else {
			restoreNormalModeTools();
		}
		updateStatus(ctx);
	});
}
