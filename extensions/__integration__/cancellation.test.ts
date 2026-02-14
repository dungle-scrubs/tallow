/**
 * Integration tests for abort/cancellation behavior:
 * tool abort signals, multi-tool sequences, and error recovery.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";
import { createSessionRunner, type SessionRunner } from "../../test-utils/session-runner.js";

let runner: SessionRunner | undefined;

afterEach(() => {
	runner?.dispose();
	runner = undefined;
});

/**
 * Extension that registers a tool verifying it receives an abort signal.
 *
 * @param signalLog - Mutable array to track signal presence
 * @returns Extension factory
 */
function createSignalTrackerExtension(signalLog: Array<{ hadSignal: boolean }>): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "signal_check",
			label: "Signal Check",
			description: "Checks for abort signal presence",
			parameters: Type.Object({ value: Type.String() }),
			async execute(_id, params, signal, _onUpdate, _ctx) {
				signalLog.push({ hadSignal: signal !== undefined && signal !== null });
				return {
					content: [{ type: "text", text: `Checked: ${params.value}` }],
					details: undefined,
				};
			},
		});
	};
}

/**
 * Extension that registers a tool which always throws.
 *
 * @returns Extension factory
 */
function createFailingToolExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "always_fails",
			label: "Always Fails",
			description: "Always throws an error",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("Intentional failure for testing");
			},
		});
	};
}

/**
 * Extension that registers a tool tracking its execution count.
 *
 * @param counter - Mutable object to track calls
 * @returns Extension factory
 */
function createCounterToolExtension(counter: { calls: number }): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "call_counter",
			label: "Call Counter",
			description: "Counts how many times it's called",
			parameters: Type.Object({}),
			async execute() {
				counter.calls++;
				return {
					content: [{ type: "text", text: `Call #${counter.calls}` }],
					details: undefined,
				};
			},
		});
	};
}

// ── Signal handling ──────────────────────────────────────────────────────────

describe("Tool abort signal", () => {
	it("tools receive an abort signal object", async () => {
		const signals: Array<{ hadSignal: boolean }> = [];

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "signal_check", arguments: { value: "test" } }] },
				{ text: "Done" },
			]),
			extensionFactories: [createSignalTrackerExtension(signals)],
		});

		await runner.run("Check signal");
		expect(signals).toHaveLength(1);
		expect(signals[0].hadSignal).toBe(true);
	});
});

// ── Multi-tool sequences ─────────────────────────────────────────────────────

describe("Multi-tool execution", () => {
	it("executes multiple tool calls in sequence", async () => {
		const counter = { calls: 0 };

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "call_counter", arguments: {} }] },
				{ toolCalls: [{ name: "call_counter", arguments: {} }] },
				{ text: "Done" },
			]),
			extensionFactories: [createCounterToolExtension(counter)],
		});

		await runner.run("Call twice");
		expect(counter.calls).toBe(2);
	});

	it("continues after tool error in a turn", async () => {
		const counter = { calls: 0 };

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "always_fails", arguments: {} }] },
				{ toolCalls: [{ name: "call_counter", arguments: {} }] },
				{ text: "Recovered" },
			]),
			extensionFactories: [createFailingToolExtension(), createCounterToolExtension(counter)],
		});

		await runner.run("Fail then succeed");
		expect(counter.calls).toBe(1);
	});
});

// ── Error recovery ───────────────────────────────────────────────────────────

describe("Error recovery across prompts", () => {
	it("second prompt works after error in first prompt", async () => {
		const counter = { calls: 0 };

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				// First prompt: error
				{ toolCalls: [{ name: "always_fails", arguments: {} }] },
				{ text: "Handled error" },
				// Second prompt: success
				{ toolCalls: [{ name: "call_counter", arguments: {} }] },
				{ text: "All good" },
			]),
			extensionFactories: [createFailingToolExtension(), createCounterToolExtension(counter)],
		});

		await runner.run("First prompt with error");
		await runner.run("Second prompt clean");

		expect(counter.calls).toBe(1);
	});
});
