/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan-mode command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
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
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

/** Base tools available in plan mode (read-only) */
const PLAN_MODE_BASE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

/** Base tools available in normal mode (full access) */
const NORMAL_MODE_BASE_TOOLS = ["read", "bash", "edit", "write"];

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
	let executionMode = false;
	let todoItems: TodoItem[] = [];

	/**
	 * Builds the full tool list by merging base tools with all non-base
	 * (extension-registered) tools. This ensures extension tools like
	 * plan_mode itself and MCP adapter tools are never dropped.
	 * @param baseTools - The base tool names to include
	 * @returns Full list of tool names including extension tools
	 */
	function buildToolList(baseTools: string[]): string[] {
		const knownBaseTools = new Set([...NORMAL_MODE_BASE_TOOLS, ...PLAN_MODE_BASE_TOOLS]);
		const extensionTools = pi
			.getAllTools()
			.map((t) => t.name)
			.filter((name) => !knownBaseTools.has(name));
		return [...baseTools, ...extensionTools];
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
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("accent", `${getIcon("task_list")} ${completed}/${todoItems.length}`)
			);
		} else if (planModeEnabled) {
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

		// Full-width banner above editor using existing theme background tokens
		if (planModeEnabled || executionMode) {
			ctx.ui.setWidget("plan-banner", (_tui, theme) => {
				const label = planModeEnabled ? " PLAN MODE — READ ONLY " : " EXECUTING PLAN ";
				const bg = planModeEnabled ? "customMessageBg" : "toolSuccessBg";
				const fg = planModeEnabled ? "customMessageLabel" : "success";
				return {
					render: (width: number) => [theme.bg(bg, theme.fg(fg, label.padEnd(width)))],
					invalidate() {},
				};
			});
		} else {
			ctx.ui.setWidget("plan-banner", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", `${getIcon("pending")} `)}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	/**
	 * Toggles plan mode on or off.
	 * @param ctx - The extension context
	 */
	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			pi.setActiveTools(buildToolList(PLAN_MODE_BASE_TOOLS));
			ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_BASE_TOOLS.join(", ")}`);
		} else {
			pi.setActiveTools(buildToolList(NORMAL_MODE_BASE_TOOLS));
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
	}

	/**
	 * Persists the current plan mode state to the session.
	 */
	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
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
		description: `Toggle plan mode on or off. Plan mode is a read-only exploration mode for safe code analysis.

When enabled:
- Only read-only tools are available (read, bash, grep, find, ls)
- Bash is restricted to safe read-only commands
- edit and write tools are disabled

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
				const mode = executionMode ? "executing" : planModeEnabled ? "planning" : "normal";
				const tools = planModeEnabled ? PLAN_MODE_BASE_TOOLS : NORMAL_MODE_BASE_TOOLS;
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
			executionMode = false;
			todoItems = [];

			if (planModeEnabled) {
				pi.setActiveTools(buildToolList(PLAN_MODE_BASE_TOOLS));
			} else {
				pi.setActiveTools(buildToolList(NORMAL_MODE_BASE_TOOLS));
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
							? `Plan mode enabled. Tools restricted to: ${PLAN_MODE_BASE_TOOLS.join(", ")}. Write operations are blocked.`
							: "Plan mode disabled. Full tool access restored.",
					},
				],
				details: {},
			};
		},
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			const reason = `Plan mode: command blocked (not allowlisted). Use /plan-mode to disable plan mode first.\nCommand: ${command}`;
			ctx.ui?.notify(`⛔ ${reason}`, "error");
			return { block: true, reason };
		}
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
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

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

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{
						customType: "plan-complete",
						content: `**Plan Complete!** ${getIcon("success")}\n\n${completedList}`,
						display: true,
					},
					{ triggerTurn: false }
				);
				executionMode = false;
				todoItems = [];
				pi.setActiveTools(buildToolList(NORMAL_MODE_BASE_TOOLS));
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!(planModeEnabled && ctx.hasUI)) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		// Show plan steps and prompt for next action
		if (todoItems.length > 0) {
			const todoListText = todoItems
				.map((t, i) => `${i + 1}. ${getIcon("pending")} ${t.text}`)
				.join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false }
			);
		}

		const choice = await ctx.ui.select("Plan mode - what next?", [
			todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			pi.setActiveTools(buildToolList(NORMAL_MODE_BASE_TOOLS));
			updateStatus(ctx);

			const execMessage =
				todoItems.length > 0
					? `Execute the plan. Start with: ${todoItems[0].text}`
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
			| { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean } }
			| undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (
					entry.type === "message" &&
					"message" in entry &&
					isAssistantMessage(entry.message as AgentMessage)
				) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			pi.setActiveTools(buildToolList(PLAN_MODE_BASE_TOOLS));
		}
		updateStatus(ctx);
	});
}
