/**
 * Integration tests for slash-command-bridge.
 *
 * The compact regression uses the real headless session path and verifies the
 * ordered lifecycle from tool result → deferred compact → resumed turn.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { ManualTimerScheduler } from "../../test-utils/manual-timer-scheduler.js";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";
import { createSessionRunner, type SessionRunner } from "../../test-utils/session-runner.js";
import slashCommandBridge, {
	resetSlashCommandBridgeStateForTests,
	setSlashCommandBridgeSchedulerForTests,
} from "../slash-command-bridge/index.js";

interface CompactionTrackerState {
	order: string[];
	resumedAssistantCount: number;
}

let runner: SessionRunner | undefined;
let scheduler: ManualTimerScheduler;

beforeEach(() => {
	scheduler = new ManualTimerScheduler();
	setSlashCommandBridgeSchedulerForTests(scheduler.runtime);
});

afterEach(() => {
	runner?.dispose();
	runner = undefined;
	resetSlashCommandBridgeStateForTests();
});

/**
 * Returns assistant text content as a plain string for matcher-friendly assertions.
 *
 * @param message - Agent message to inspect
 * @returns Flattened text content
 */
function getMessageText(message: AgentMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}

	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/**
 * Builds a tracking extension that records the compact lifecycle order.
 *
 * The hook also provides a deterministic compaction result so the regression can
 * exercise the real deferred path without making a network summarization call.
 *
 * @param state - Shared mutable tracker state for assertions
 * @returns Extension factory that records compact lifecycle events
 */
function buildCompactionTracker(state: CompactionTrackerState): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.on("tool_result", async (event) => {
			if (event.toolName !== "run_slash_command") {
				return;
			}
			if ((event.details as { command?: string } | undefined)?.command !== "compact") {
				return;
			}
			state.order.push("tool_result");
		});

		pi.on("turn_end", async (event) => {
			if (event.message.role !== "assistant") {
				return;
			}
			state.order.push(`turn_end:${event.message.stopReason}`);
		});

		pi.on("session_before_compact", async () => {
			state.order.push("session_before_compact");
			return {
				compaction: {
					summary: "mock compact summary",
					firstKeptEntryId: undefined,
					tokensBefore: 123,
					details: { modifiedFiles: [], readFiles: [] },
				},
			};
		});

		pi.on("session_compact", async () => {
			state.order.push("session_compact");
		});

		pi.on("message_end", async (event) => {
			const text = getMessageText(event.message);
			if (event.message.role === "custom" && text.includes("Session compaction is complete")) {
				state.order.push("continuation_message");
			}
			if (event.message.role === "assistant" && text.includes("resumed after compact")) {
				state.order.push("assistant_resumed");
				state.resumedAssistantCount++;
			}
		});
	};
}

/**
 * Lets queued extension/session work settle after a prompt or timer advance.
 *
 * `session.prompt()` does not wait for all extension-side follow-up work, so the
 * regression explicitly drains microtasks around `agent.waitForIdle()`.
 *
 * @param activeRunner - Runner whose session should be drained
 * @returns Nothing
 */
async function flushSessionWork(activeRunner: SessionRunner): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await activeRunner.session.agent.waitForIdle();
	await Promise.resolve();
	await Promise.resolve();
	await activeRunner.session.agent.waitForIdle();
	await Promise.resolve();
}

/**
 * Returns the first index of a recorded lifecycle step.
 *
 * @param order - Recorded lifecycle events
 * @param step - Step name to locate
 * @returns Zero-based index in the order array
 */
function indexOfStep(order: readonly string[], step: string): number {
	return order.indexOf(step);
}

describe("slash-command-bridge integration", () => {
	it("model invokes show-system-prompt and receives prompt text", async () => {
		const toolResults: string[] = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "run_slash_command") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [{ name: "run_slash_command", arguments: { command: "show-system-prompt" } }],
				},
				{ text: "Got the system prompt" },
			]),
			extensionFactories: [slashCommandBridge, tracker],
		});

		await runner.run("Show me the system prompt");

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].length).toBeGreaterThan(0);
	});

	it("model invokes context and receives usage data", async () => {
		const toolResults: Array<{ isError: boolean; text: string }> = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "run_slash_command") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") {
						toolResults.push({ text: text.text, isError: event.isError });
					}
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [{ name: "run_slash_command", arguments: { command: "context" } }],
				},
				{ text: "Context usage noted" },
			]),
			extensionFactories: [slashCommandBridge, tracker],
		});

		await runner.run("Check context usage");

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].text.length).toBeGreaterThan(0);
	});

	it("model receives error for unknown commands", async () => {
		const toolResults: string[] = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "run_slash_command") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [{ name: "run_slash_command", arguments: { command: "reboot" } }],
				},
				{ text: "That command is not available" },
			]),
			extensionFactories: [slashCommandBridge, tracker],
		});

		await runner.run("Reboot the system");

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toContain("Unknown command");
		expect(toolResults[0]).toContain("reboot");
	});

	it("model-invoked compact preserves ordered lifecycle and resumes once", async () => {
		const state: CompactionTrackerState = {
			order: [],
			resumedAssistantCount: 0,
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{ text: "warmup" },
				{
					toolCalls: [{ name: "run_slash_command", arguments: { command: "compact" } }],
				},
				{ text: "finish response" },
				{ text: "resumed after compact" },
			]),
			extensionFactories: [slashCommandBridge, buildCompactionTracker(state)],
			settings: {
				compaction: {
					enabled: true,
					keepRecentTokens: 1,
					reserveTokens: 10,
				},
			},
		});

		await runner.run("warm up the session");
		state.order.length = 0;
		state.resumedAssistantCount = 0;

		await runner.run("compact the session");
		scheduler.advanceBy(200);
		await flushSessionWork(runner);

		expect(state.resumedAssistantCount).toBe(1);
		expect(state.order.filter((step) => step === "session_before_compact")).toHaveLength(1);
		expect(state.order.filter((step) => step === "session_compact")).toHaveLength(1);
		expect(state.order.filter((step) => step === "assistant_resumed")).toHaveLength(1);

		const toolResultIndex = indexOfStep(state.order, "tool_result");
		const toolUseTurnEndIndex = indexOfStep(state.order, "turn_end:toolUse");
		const finalTurnEndIndex = indexOfStep(state.order, "turn_end:stop");
		const beforeCompactIndex = indexOfStep(state.order, "session_before_compact");
		const compactIndex = indexOfStep(state.order, "session_compact");
		const continuationIndex = indexOfStep(state.order, "continuation_message");
		const resumedIndex = indexOfStep(state.order, "assistant_resumed");

		expect(toolResultIndex).toBeGreaterThanOrEqual(0);
		expect(toolUseTurnEndIndex).toBeGreaterThan(toolResultIndex);
		expect(finalTurnEndIndex).toBeGreaterThan(toolUseTurnEndIndex);
		expect(beforeCompactIndex).toBeGreaterThan(finalTurnEndIndex);
		expect(compactIndex).toBeGreaterThan(beforeCompactIndex);
		expect(continuationIndex).toBeGreaterThan(compactIndex);
		expect(resumedIndex).toBeGreaterThan(continuationIndex);
	});
});
