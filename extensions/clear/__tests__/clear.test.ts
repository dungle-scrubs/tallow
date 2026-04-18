import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage, Usage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import { ManualTimerScheduler } from "../../../test-utils/manual-timer-scheduler.js";
import slashCommandBridge, {
	resetSlashCommandBridgeStateForTests,
	setSlashCommandBridgeSchedulerForTests,
} from "../../slash-command-bridge/index.js";
import registerClear from "../index.js";

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

beforeEach(() => {
	scheduler = new ManualTimerScheduler();
	setSlashCommandBridgeSchedulerForTests(scheduler.runtime);
	harness = ExtensionHarness.create();
});

afterEach(() => {
	resetSlashCommandBridgeStateForTests();
});

/**
 * Build a compact-lifecycle test context.
 *
 * @param overrides - Context overrides
 * @returns Extension context
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
		getContextUsage: () => ({ contextWindow: 100, tokens: 90 }),
		compact: () => {},
		getSystemPrompt: () => "",
		...overrides,
	};
}

/**
 * Build a realistic assistant turn_end event for compact lifecycle tests.
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
 * Build the compact tool result payload recorded on the tool-use turn.
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

describe("clear extension", () => {
	test("registers /clear command", () => {
		const commands: Array<{ name: string; description: string }> = [];
		const pi = {
			registerCommand: (name: string, opts: { description: string }) => {
				commands.push({ name, description: opts.description });
			},
		} as unknown as ExtensionAPI;

		registerClear(pi);

		expect(commands).toHaveLength(1);
		expect(commands[0].name).toBe("clear");
		expect(commands[0].description).toContain("new session");
	});

	test("handler calls ctx.newSession()", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (
				_name: string,
				opts: { handler: (args: string, ctx: unknown) => Promise<void> }
			) => {
				handler = opts.handler;
			},
		} as unknown as ExtensionAPI;

		registerClear(pi);

		const newSession = mock(() => Promise.resolve());
		await handler?.("", { newSession });
		expect(newSession).toHaveBeenCalledTimes(1);
	});

	test("/clear cancels pending compact continuation before it can restart work", async () => {
		await harness.loadExtension(slashCommandBridge);
		registerClear(harness.api);

		const compactTool = harness.tools.get("run_slash_command");
		const clearCommand = harness.commands.get("clear");
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

		if (!compactTool?.execute || !clearCommand?.handler) {
			throw new Error("expected compact tool and clear command to be registered");
		}

		await compactTool.execute("test-call-id", { command: "compact" }, undefined, undefined, ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("toolUse"), ctx);
		await harness.fireEvent("turn_end", buildAssistantTurnEnd("stop"), ctx);
		compactOptions?.onComplete?.();

		const newSession = mock(async () => {
			await harness.fireEvent(
				"session_before_switch",
				{ type: "session_before_switch", reason: "new" },
				ctx
			);
		});
		await clearCommand.handler("", { ...ctx, newSession } as never);
		scheduler.advanceBy(200);

		expect(newSession).toHaveBeenCalledTimes(1);
		expect(harness.sentMessages.some((message) => message.customType === "compact-continue")).toBe(
			false
		);
		expect(widgetUpdates.at(-1)).toEqual({ key: "compact-progress", content: undefined });
		expect(workingMessages.at(-1)).toBeUndefined();
	});
});
