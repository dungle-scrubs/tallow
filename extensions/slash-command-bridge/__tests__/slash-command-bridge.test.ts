/**
 * Unit tests for the slash-command-bridge extension.
 *
 * Focuses on compact deferral, chosen lifecycle boundary, exactly-once guards,
 * and deterministic timer-driven continuation behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage, Usage } from "@mariozechner/pi-ai";
import type {
	ContextUsage,
	ExtensionContext,
	ExtensionUIContext,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import {
	getResetDiagnosticsForTests,
	resetResetDiagnosticsForTests,
} from "../../../src/reset-diagnostics.js";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import { ManualTimerScheduler } from "../../../test-utils/manual-timer-scheduler.js";
import slashCommandBridge, {
	resetSlashCommandBridgeStateForTests,
	setSlashCommandBridgeSchedulerForTests,
} from "../index.js";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let harness: ExtensionHarness;
let scheduler: ManualTimerScheduler;

beforeEach(async () => {
	scheduler = new ManualTimerScheduler();
	setSlashCommandBridgeSchedulerForTests(scheduler.runtime);
	harness = ExtensionHarness.create();
	await harness.loadExtension(slashCommandBridge);
});

afterEach(() => {
	resetResetDiagnosticsForTests();
	resetSlashCommandBridgeStateForTests();
});

/**
 * Builds a mock ExtensionContext with overridable methods.
 *
 * @param overrides - Methods/properties to override on the default stub context
 * @returns Mock ExtensionContext
 */
function buildContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		ui: {} as ExtensionContext["ui"],
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		...overrides,
	};
}

/**
 * Creates a realistic assistant turn_end event for compact lifecycle tests.
 *
 * @param stopReason - Assistant stop reason for the completed turn
 * @returns TurnEnd event payload
 */
function buildAssistantTurnEnd(stopReason: AssistantMessage["stopReason"]): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "mock",
			model: "mock-model",
			stopReason,
			timestamp: Date.now(),
			usage: { ...ZERO_USAGE },
		},
		toolResults: stopReason === "toolUse" ? [buildCompactToolResult()] : [],
	};
}

/**
 * Builds the compact tool result payload recorded on the tool-use turn.
 *
 * @returns Tool result message for `run_slash_command({ command: "compact" })`
 */
function buildCompactToolResult(): ToolResultMessage<{ command: string }> {
	return {
		role: "toolResult",
		toolCallId: "mock-tool-call",
		toolName: "run_slash_command",
		content: [
			{ type: "text", text: "Session compaction will begin after this response completes." },
		],
		details: { command: "compact" },
		isError: false,
		timestamp: Date.now(),
	};
}

/**
 * Executes the registered slash-command tool with the provided context.
 *
 * @param params - Tool parameters
 * @param ctx - Extension context for the execution
 * @returns Tool execution result
 */
async function executeTool(params: { command: string }, ctx?: ExtensionContext) {
	const tool = harness.tools.get("run_slash_command");
	if (!tool) {
		throw new Error("run_slash_command tool not registered");
	}

	return tool.execute("test-call-id", params, undefined, undefined, ctx ?? buildContext());
}

describe("registration", () => {
	test("registers run_slash_command and lifecycle handlers", () => {
		expect(harness.tools.has("run_slash_command")).toBe(true);
		expect(harness.handlers.has("before_agent_start")).toBe(true);
		expect(harness.handlers.has("turn_end")).toBe(true);
		expect(harness.handlers.has("turn_start")).toBe(true);
		expect(harness.handlers.has("session_before_switch")).toBe(true);
	});
});

describe("show-system-prompt", () => {
	test("returns the current system prompt", async () => {
		const systemPrompt = "You are a helpful assistant with custom instructions.";
		const ctx = buildContext({ getSystemPrompt: () => systemPrompt });

		const result = await executeTool({ command: "show-system-prompt" }, ctx);

		expect(result.content[0]).toEqual({ type: "text", text: systemPrompt });
		expect(result.details).toEqual({ command: "show-system-prompt", length: systemPrompt.length });
	});
});

describe("context", () => {
	test("returns formatted context usage", async () => {
		const usage: ContextUsage = { tokens: 45000, contextWindow: 200000 };
		const ctx = buildContext({ getContextUsage: () => usage });

		const result = await executeTool({ command: "context" }, ctx);
		const text = result.content[0];

		expect(text).toBeDefined();
		if (text?.type === "text") {
			expect(text.text).toContain("45,000");
			expect(text.text).toContain("200,000");
			expect(text.text).toContain("22.5%");
		}
	});

	test("returns error when usage data is unavailable", async () => {
		const result = await executeTool({ command: "context" }, buildContext());

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ command: "context", error: "no_usage_data" });
	});
});

describe("error handling", () => {
	test("rejects unknown commands", async () => {
		const result = await executeTool({ command: "reboot" }, buildContext());

		expect(result.isError).toBe(true);
		const text = result.content[0];
		if (text?.type === "text") {
			expect(text.text).toContain("Unknown command");
			expect(text.text).toContain("reboot");
		}
	});
});

describe("context injection", () => {
	test("injects hidden context listing bridged commands", async () => {
		const results = await harness.fireEvent("before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "",
		});

		const result = results.find((entry) => entry != null) as
			| {
					message: { content: string; customType: string; display: boolean };
			  }
			| undefined;

		expect(result?.message.customType).toBe("slash-command-bridge-context");
		expect(result?.message.display).toBe(false);
		expect(result?.message.content).toContain("/show-system-prompt");
		expect(result?.message.content).toContain("/context");
		expect(result?.message.content).toContain("/compact");
	});
});

describe("compact", () => {
	test("defers compact instead of calling ctx.compact inline", async () => {
		let compactCalled = false;
		const ctx = buildContext({
			compact: () => {
				compactCalled = true;
			},
		});

		const result = await executeTool({ command: "compact" }, ctx);

		expect(compactCalled).toBe(false);
		expect(result.details).toEqual({ command: "compact" });
		const text = result.content[0];
		if (text?.type === "text") {
			expect(text.text).toContain("compaction will begin after this response");
			expect(text.text).toContain("Do NOT call any more tools");
		}
	});

	test("waits through the tool-use turn and compacts on the following assistant turn_end", async () => {
		let compactCalls = 0;
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const ctx = buildContext({
			compact: (options) => {
				compactCalls++;
				compactOptions = options;
			},
		});

		await executeTool({ command: "compact" }, buildContext());
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("toolUse"), ctx);
		expect(compactCalls).toBe(0);

		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);
		expect(compactCalls).toBe(1);
		expect(typeof compactOptions?.onComplete).toBe("function");
		expect(typeof compactOptions?.onError).toBe("function");
	});

	test("consumes the pending request exactly once", async () => {
		let compactCalls = 0;
		const ctx = buildContext({
			compact: () => {
				compactCalls++;
			},
		});

		await executeTool({ command: "compact" }, buildContext());
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("toolUse"), ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);

		expect(compactCalls).toBe(1);
	});

	test("drives heartbeat and continuation timers deterministically", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const widgetUpdates: Array<{ key: string; content: string[] | undefined }> = [];
		const workingMessages: Array<string | undefined> = [];
		const ctx = buildContext({
			hasUI: true,
			ui: {
				setWidget: (key: string, content?: string[]) => {
					widgetUpdates.push({ key, content });
				},
				setWorkingMessage: (message?: string) => {
					workingMessages.push(message);
				},
			} as ExtensionUIContext,
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, buildContext());
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("toolUse"), ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);

		expect(workingMessages[0]).toBe("Compacting session…");
		expect(widgetUpdates[0]).toEqual({
			key: "compact-progress",
			content: ["🧹 ⠋ Compacting session · 0s"],
		});

		scheduler.advanceBy(1000);
		expect(widgetUpdates.at(-1)).toEqual({
			key: "compact-progress",
			content: ["🧹 ⠙ Compacting session · 1s"],
		});

		compactOptions?.onComplete?.();
		expect(workingMessages.at(-1)).toBe("Resuming task…");
		expect(widgetUpdates.at(-1)).toEqual({
			key: "compact-progress",
			content: ["⏳ Resuming after compaction…"],
		});

		scheduler.advanceBy(199);
		expect(harness.sentMessages).toHaveLength(0);
		scheduler.advanceBy(1);

		const continuation = harness.sentMessages.find(
			(message) => message.customType === "compact-continue"
		);
		expect(
			getResetDiagnosticsForTests().some(
				(event) => event.kind === "deferred_registered" && event.source === "slash-command-bridge"
			)
		).toBe(true);
		expect(continuation?.display).toBe(false);
		expect(continuation?.options?.triggerTurn).toBe(true);
		expect(continuation?.content).toContain("compaction is complete");
	});

	test("turn_start cancels the delayed continuation and clears the inline widget", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const widgetUpdates: Array<{ key: string; content: string[] | undefined }> = [];
		const ctx = buildContext({
			hasUI: true,
			ui: {
				setWidget: (key: string, content?: string[]) => {
					widgetUpdates.push({ key, content });
				},
				setWorkingMessage: () => {},
			} as ExtensionUIContext,
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, buildContext());
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("toolUse"), ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);
		compactOptions?.onComplete?.();

		await harness.fireEvent("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
		scheduler.advanceBy(200);

		expect(
			getResetDiagnosticsForTests().some(
				(event) =>
					event.kind === "deferred_cancelled" &&
					event.source === "slash-command-bridge" &&
					event.reason === "turn_start"
			)
		).toBe(true);
		expect(harness.sentMessages).toHaveLength(0);
		expect(widgetUpdates.at(-1)).toEqual({ key: "compact-progress", content: undefined });
	});

	test("skips continuation and clears indicators when the session is no longer idle", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const widgetUpdates: Array<{ key: string; content: string[] | undefined }> = [];
		const workingMessages: Array<string | undefined> = [];
		const ctx = buildContext({
			hasUI: true,
			ui: {
				setWidget: (key: string, content?: string[]) => {
					widgetUpdates.push({ key, content });
				},
				setWorkingMessage: (message?: string) => {
					workingMessages.push(message);
				},
			} as ExtensionUIContext,
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => false,
		});

		await executeTool({ command: "compact" }, buildContext());
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("toolUse"), ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);
		compactOptions?.onComplete?.();
		scheduler.advanceBy(200);

		expect(
			getResetDiagnosticsForTests().some(
				(event) =>
					event.kind === "deferred_dropped" &&
					event.source === "slash-command-bridge" &&
					event.reason === "session_not_idle"
			)
		).toBe(true);
		expect(harness.sentMessages).toHaveLength(0);
		expect(widgetUpdates.at(-1)).toEqual({ key: "compact-progress", content: undefined });
		expect(workingMessages.at(-1)).toBeUndefined();
	});

	test("onError clears compact UI and sends no continuation", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const widgetUpdates: Array<{ key: string; content: string[] | undefined }> = [];
		const workingMessages: Array<string | undefined> = [];
		const ctx = buildContext({
			hasUI: true,
			ui: {
				setWidget: (key: string, content?: string[]) => {
					widgetUpdates.push({ key, content });
				},
				setWorkingMessage: (message?: string) => {
					workingMessages.push(message);
				},
			} as ExtensionUIContext,
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, buildContext());
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("toolUse"), ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);
		scheduler.advanceBy(1000);
		compactOptions?.onError?.(new Error("boom"));
		scheduler.advanceBy(200);

		expect(harness.sentMessages).toHaveLength(0);
		expect(widgetUpdates.at(-1)).toEqual({ key: "compact-progress", content: undefined });
		expect(workingMessages.at(-1)).toBeUndefined();
	});

	test("session_before_switch clears pending compact, timers, and UI state", async () => {
		let compactCalls = 0;
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const widgetUpdates: Array<{ key: string; content: string[] | undefined }> = [];
		const workingMessages: Array<string | undefined> = [];
		const ctx = buildContext({
			hasUI: true,
			ui: {
				setWidget: (key: string, content?: string[]) => {
					widgetUpdates.push({ key, content });
				},
				setWorkingMessage: (message?: string) => {
					workingMessages.push(message);
				},
			} as ExtensionUIContext,
			compact: (options) => {
				compactCalls++;
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, buildContext());
		await harness.fireEvent(
			"session_before_switch",
			{ type: "session_before_switch", reason: "switch" },
			ctx
		);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("toolUse"), ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);
		expect(compactCalls).toBe(0);

		await executeTool({ command: "compact" }, buildContext());
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("toolUse"), ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);
		compactOptions?.onComplete?.();
		await harness.fireEvent(
			"session_before_switch",
			{ type: "session_before_switch", reason: "switch" },
			ctx
		);
		scheduler.advanceBy(200);

		expect(harness.sentMessages).toHaveLength(0);
		expect(widgetUpdates.at(-1)).toEqual({ key: "compact-progress", content: undefined });
		expect(workingMessages.at(-1)).toBeUndefined();
	});
});
