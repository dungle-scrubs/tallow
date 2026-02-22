import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../test-utils/extension-harness.js";
import planModeExtension from "../plan-mode-tool/index.js";

const PLAN_TEXT = [
	"Plan:",
	"1. Inspect tool failure paths in plan execution",
	"2. Verify fallback behavior for blocked operations",
	"3. Finalize recovery guidance for remaining step",
].join("\n");

interface ContextOptions {
	readonly confirmResponse?: boolean;
	readonly editorResponse?: string;
	readonly hasUI: boolean;
	readonly selectResponse?: string;
}

/**
 * Create a minimal extension context with configurable UI responses.
 *
 * @param options - Context and UI response options
 * @returns Extension context for direct event firing
 */
function createContext(options: ContextOptions): ExtensionContext {
	const theme = {
		bg(_token: string, value: string) {
			return value;
		},
		fg(_token: string, value: string) {
			return value;
		},
		strikethrough(value: string) {
			return value;
		},
	};

	return {
		abort: () => {},
		compact: () => {},
		cwd: process.cwd(),
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		hasPendingMessages: () => false,
		hasUI: options.hasUI,
		isIdle: () => true,
		model: undefined,
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
		} as never,
		sessionManager: {
			appendEntry: () => {},
			getEntries: () => [],
		} as never,
		shutdown: () => {},
		ui: {
			async confirm() {
				return options.confirmResponse ?? false;
			},
			async custom() {
				return undefined as never;
			},
			async editor() {
				return options.editorResponse;
			},
			async input() {
				return undefined;
			},
			notify() {},
			pasteToEditor() {},
			async select() {
				return options.selectResponse;
			},
			setEditorComponent() {},
			setEditorText() {},
			setFooter() {},
			setHeader() {},
			setStatus() {},
			setTitle() {},
			setToolsExpanded() {},
			setWidget() {},
			setWorkingMessage() {},
			get theme() {
				return theme as ExtensionContext["ui"]["theme"];
			},
			getAllThemes() {
				return [];
			},
			getEditorText() {
				return "";
			},
			getTheme() {
				return undefined;
			},
			getToolsExpanded() {
				return false;
			},
			setTheme() {
				return { error: "Test stub", success: false };
			},
		} as ExtensionContext["ui"],
	};
}

/**
 * Build an assistant message payload with a single text block.
 *
 * @param text - Assistant text content
 * @returns Assistant message payload
 */
function assistantMessage(text: string): {
	readonly content: readonly [{ readonly text: string; readonly type: "text" }];
	readonly role: "assistant";
} {
	return {
		content: [{ text, type: "text" }],
		role: "assistant",
	};
}

/**
 * Initialize plan execution mode with a 3-step plan and tracking enabled.
 *
 * @param harness - Extension harness with plan-mode extension loaded
 * @returns Promise that resolves once execution mode is active
 */
async function initializeExecutionMode(harness: ExtensionHarness): Promise<void> {
	harness.setFlag("plan", true);
	await harness.fireEvent(
		"session_start",
		{ type: "session_start" },
		createContext({ hasUI: true })
	);
	await harness.fireEvent(
		"agent_end",
		{ messages: [assistantMessage(PLAN_TEXT)] },
		createContext({
			hasUI: true,
			selectResponse: "Execute the plan (track progress)",
		})
	);
}

/**
 * Fire a failed tool_result event using the documented test payload shape.
 *
 * @param harness - Extension harness instance
 * @param ctx - Extension context for the event
 * @returns Promise that resolves after handlers run
 */
async function fireFailedToolResult(
	harness: ExtensionHarness,
	ctx: ExtensionContext
): Promise<void> {
	await harness.fireEvent(
		"tool_result",
		{
			content: [{ text: "blocked", type: "text" }],
			input: { command: "echo blocked" },
			isError: true,
			toolCallId: "tool-call-1",
			toolName: "bash",
		},
		ctx
	);
}

/**
 * Fire a turn_end event that marks a plan step as complete.
 *
 * @param harness - Extension harness instance
 * @param step - Step number to mark done
 * @returns Promise that resolves after handlers run
 */
async function fireDoneStep(harness: ExtensionHarness, step: number): Promise<void> {
	await harness.fireEvent(
		"turn_end",
		{ message: assistantMessage(`[DONE:${step}]`) },
		createContext({ hasUI: true })
	);
}

describe("Plan rejection feedback", () => {
	it("ignores tool_result during execution when hasUI is false", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(planModeExtension);
		await initializeExecutionMode(harness);

		await fireFailedToolResult(harness, createContext({ hasUI: false }));

		expect(harness.sentUserMessages).toHaveLength(0);
	});

	it("sends steer guidance with Step 1 prefix when user confirms and provides guidance", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(planModeExtension);
		await initializeExecutionMode(harness);

		await fireFailedToolResult(
			harness,
			createContext({
				confirmResponse: true,
				editorResponse: "Use a narrower inspection command and continue.",
				hasUI: true,
			})
		);

		expect(harness.sentUserMessages).toHaveLength(1);
		const [message] = harness.sentUserMessages;
		if (!message || typeof message.content !== "string") {
			throw new Error("Expected one string user message");
		}
		expect(message.content.startsWith("[PLAN GUIDANCE — Step 1:")).toBe(true);
		expect(message.options?.deliverAs).toBe("steer");
	});

	it("does not send guidance when user declines confirmation", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(planModeExtension);
		await initializeExecutionMode(harness);

		await fireFailedToolResult(
			harness,
			createContext({
				confirmResponse: false,
				hasUI: true,
			})
		);

		expect(harness.sentUserMessages).toHaveLength(0);
	});

	it("advances tracked step guidance to Step 3 and stops after all steps complete", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(planModeExtension);
		await initializeExecutionMode(harness);

		await fireDoneStep(harness, 1);
		await fireDoneStep(harness, 2);

		await fireFailedToolResult(
			harness,
			createContext({
				confirmResponse: true,
				editorResponse: "Focus on the final verification sequence.",
				hasUI: true,
			})
		);

		expect(harness.sentUserMessages).toHaveLength(1);
		const [stepThreeGuidance] = harness.sentUserMessages;
		if (!stepThreeGuidance || typeof stepThreeGuidance.content !== "string") {
			throw new Error("Expected one string user message");
		}
		expect(stepThreeGuidance.content.startsWith("[PLAN GUIDANCE — Step 3:")).toBe(true);
		expect(stepThreeGuidance.options?.deliverAs).toBe("steer");

		await fireDoneStep(harness, 3);

		await fireFailedToolResult(
			harness,
			createContext({
				confirmResponse: true,
				editorResponse: "This should not be sent after completion.",
				hasUI: true,
			})
		);

		expect(harness.sentUserMessages).toHaveLength(1);
	});
});
