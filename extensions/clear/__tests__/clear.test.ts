import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, Usage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
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
import { registerContextForkExtension } from "../../context-fork/index.js";
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
	resetResetDiagnosticsForTests();
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

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly reject: (error?: unknown) => void;
	readonly resolve: (value: T) => void;
}

/**
 * Create a deferred promise for controlling async completion timing in tests.
 *
 * @template T
 * @returns Deferred promise controls
 */
function createDeferred<T>(): Deferred<T> {
	let reject!: (error?: unknown) => void;
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve, innerReject) => {
		resolve = innerResolve;
		reject = innerReject;
	});
	return { promise, reject, resolve };
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

	test("/clear after deferred fork completion leaves the replacement session idle", async () => {
		const commandDir = mkdtempSync(join(tmpdir(), "clear-fork-command-"));
		const commandPath = join(commandDir, "review.md");
		const deferred = createDeferred<{ duration: number; exitCode: number; output: string }>();
		const workingMessages: string[] = [];
		writeFileSync(commandPath, "Review the code.\n", "utf-8");

		try {
			registerContextForkExtension(harness.api, {
				buildFrontmatterIndex: () =>
					new Map([
						[
							"review",
							{
								context: "fork",
								filePath: commandPath,
							},
						],
					]),
				loadAllAgents: () => new Map(),
				routeForkedModel: async () => undefined,
				spawnForkSubprocess: () => deferred.promise,
			});
			registerClear(harness.api);

			const clearCommand = harness.commands.get("clear");
			const ctx = buildContext({
				hasUI: true,
				ui: {
					notify: () => {},
					setWorkingMessage: (message?: string) => {
						workingMessages.push(message ?? "");
					},
				} as ExtensionUIContext,
				isIdle: () => true,
			});

			if (!clearCommand?.handler) {
				throw new Error("expected clear command to be registered");
			}

			const [forkResult] = await harness.fireEvent("input", { text: "/review" }, ctx);
			expect(forkResult).toEqual({ action: "handled" });
			expect(harness.sentMessages).toHaveLength(1);
			expect(harness.sentMessages[0]?.content).toContain("🔀 /review");

			const newSession = mock(async () => {
				await harness.fireEvent(
					"session_before_switch",
					{ type: "session_before_switch", reason: "new" },
					ctx
				);
			});
			await clearCommand.handler("", { ...ctx, newSession } as never);
			deferred.resolve({ duration: 5, exitCode: 0, output: "fork done" });
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(newSession).toHaveBeenCalledTimes(1);
			expect(workingMessages).toContain("🔀 forking: /review");
			expect(workingMessages.at(-1)).toBe("");
			expect(harness.sentMessages).toHaveLength(1);
			expect(harness.sentMessages.some((message) => message.options?.triggerTurn === true)).toBe(
				false
			);

			const diagnostics = getResetDiagnosticsForTests();
			expect(diagnostics.some((event) => event.kind === "deferred_cancelled")).toBe(true);
			expect(
				diagnostics.some(
					(event) =>
						event.kind === "deferred_dropped" &&
						event.source === "context-fork" &&
						event.reason === "session_generation_mismatch"
				)
			).toBe(true);
		} finally {
			deferred.reject(new Error("cleanup"));
			rmSync(commandDir, { force: true, recursive: true });
		}
	});
});
