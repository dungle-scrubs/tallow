/**
 * Integration tests for error handling paths:
 * throwing event handlers, malformed tool results, and multi-prompt resilience.
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
 * Extension that throws during a lifecycle event.
 *
 * @param eventName - Event to throw on
 * @param errorMsg - Error message
 * @returns Extension factory
 */
function createThrowingEventExtension(eventName: string, errorMsg: string): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.on(eventName as "turn_start", async () => {
			throw new Error(errorMsg);
		});
	};
}

/**
 * Extension with a tool that returns empty content array.
 *
 * @returns Extension factory
 */
function createEmptyResultToolExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "empty_result",
			label: "Empty Result",
			description: "Returns empty content",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: undefined };
			},
		});
	};
}

/**
 * Extension tracking turn completions for verification.
 *
 * @param log - Mutable array to record turn indices
 * @returns Extension factory
 */
function createTurnTracker(log: number[]): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.on("turn_end", async (event) => {
			log.push(event.turnIndex);
		});
	};
}

// ── Throwing event handlers ──────────────────────────────────────────────────

describe("Throwing event handlers", () => {
	it("session completes despite throw in turn_start handler", async () => {
		const turns: number[] = [];

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "Response despite error" }]),
			extensionFactories: [
				createThrowingEventExtension("turn_start", "Boom in turn_start"),
				createTurnTracker(turns),
			],
		});

		// Should not throw — the framework handles handler errors
		const result = await runner.run("test");
		expect(result.events.length).toBeGreaterThan(0);
	});

	it("session completes despite throw in agent_start handler", async () => {
		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "Still works" }]),
			extensionFactories: [createThrowingEventExtension("agent_start", "Boom in agent_start")],
		});

		const result = await runner.run("test");
		expect(result.events.length).toBeGreaterThan(0);
	});
});

// ── Empty/edge-case tool results ─────────────────────────────────────────────

describe("Edge-case tool results", () => {
	it("handles tool returning empty content array", async () => {
		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "empty_result", arguments: {} }] },
				{ text: "After empty result" },
			]),
			extensionFactories: [createEmptyResultToolExtension()],
		});

		// Should complete without hanging
		const result = await runner.run("test");
		expect(result.events.length).toBeGreaterThan(0);
	});
});

// ── Multi-prompt resilience ──────────────────────────────────────────────────

describe("Multi-prompt resilience", () => {
	it("runs three consecutive prompts successfully", async () => {
		const turns: number[] = [];

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "First" }, { text: "Second" }, { text: "Third" }]),
			extensionFactories: [createTurnTracker(turns)],
		});

		await runner.run("Prompt 1");
		await runner.run("Prompt 2");
		await runner.run("Prompt 3");

		expect(turns).toHaveLength(3);
	});

	it("interleaves tool calls and text responses across prompts", async () => {
		const toolCalls: string[] = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.registerTool({
				name: "track_tool",
				label: "Track",
				description: "Tracks calls",
				parameters: Type.Object({ label: Type.String() }),
				async execute(_id, params) {
					toolCalls.push(params.label);
					return {
						content: [{ type: "text", text: `Tracked: ${params.label}` }],
						details: undefined,
					};
				},
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				// Prompt 1: tool call
				{ toolCalls: [{ name: "track_tool", arguments: { label: "p1" } }] },
				{ text: "Done p1" },
				// Prompt 2: text only
				{ text: "Text only p2" },
				// Prompt 3: tool call
				{ toolCalls: [{ name: "track_tool", arguments: { label: "p3" } }] },
				{ text: "Done p3" },
			]),
			extensionFactories: [tracker],
		});

		await runner.run("First");
		await runner.run("Second");
		await runner.run("Third");

		expect(toolCalls).toEqual(["p1", "p3"]);
	});
});
