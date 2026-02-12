/**
 * Integration tests for extension tool registration and execution.
 *
 * Verifies that tools registered by extensions appear in sessions,
 * can be invoked by the mock model, and produce correct tool_call/tool_result events.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ExtensionHarness } from "../../test-utils/extension-harness.js";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";
import { createSessionRunner, type SessionRunner } from "../../test-utils/session-runner.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let runner: SessionRunner | undefined;

afterEach(() => {
	runner?.dispose();
	runner = undefined;
});

/** Extension that registers a simple echo tool. */
const echoToolExtension: ExtensionFactory = (pi: ExtensionAPI): void => {
	pi.registerTool({
		name: "echo_test",
		label: "Echo Test",
		description: "Echoes back the input for testing",
		parameters: Type.Object({ message: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			return {
				content: [{ type: "text", text: `Echo: ${params.message}` }],
				details: undefined,
			};
		},
	});
};

/** Extension that registers a tool that returns an error. */
const errorToolExtension: ExtensionFactory = (pi: ExtensionAPI): void => {
	pi.registerTool({
		name: "failing_tool",
		label: "Failing Tool",
		description: "Always fails",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			throw new Error("Something went wrong");
		},
	});
};

// ════════════════════════════════════════════════════════════════
// Tool Registration (Harness-level)
// ════════════════════════════════════════════════════════════════

describe("Tool Registration (harness)", () => {
	it("tracks tools registered by extensions", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(echoToolExtension);

		const tool = harness.tools.get("echo_test");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("unreachable");
		expect(tool.label).toBe("Echo Test");
		expect(tool.description).toContain("Echoes back");
	});

	it("tracks multiple tools from different extensions", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(echoToolExtension);
		await harness.loadExtension(errorToolExtension);

		expect(harness.tools.size).toBe(2);
		expect(harness.tools.has("echo_test")).toBe(true);
		expect(harness.tools.has("failing_tool")).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════
// Tool Execution (Session-level)
// ════════════════════════════════════════════════════════════════

describe("Tool Execution (session)", () => {
	it("executes extension-registered tools via mock model", async () => {
		const toolResults: string[] = [];

		const resultTracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "echo_test") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				// First response: call the echo tool
				{ toolCalls: [{ name: "echo_test", arguments: { message: "hello" } }] },
				// Second response after tool result: text response
				{ text: "Got the echo result" },
			]),
			extensionFactories: [echoToolExtension, resultTracker],
		});

		await runner.run("Call echo_test");

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toBe("Echo: hello");
	});

	it("fires tool_call events for extension tools", async () => {
		const toolCallNames: string[] = [];

		const callTracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_call", async (event) => {
				toolCallNames.push(event.toolName);
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "echo_test", arguments: { message: "test" } }] },
				{ text: "Done" },
			]),
			extensionFactories: [echoToolExtension, callTracker],
		});

		await runner.run("test");

		expect(toolCallNames).toContain("echo_test");
	});

	it("handles error tool results", async () => {
		const toolResults: Array<{ name: string; content: string; isError: boolean }> = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "failing_tool") {
					const text = event.content.find((c) => c.type === "text");
					toolResults.push({
						name: event.toolName,
						content: text?.type === "text" ? text.text : "",
						isError: event.isError,
					});
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "failing_tool", arguments: {} }] },
				{ text: "Handled error" },
			]),
			extensionFactories: [errorToolExtension, tracker],
		});

		await runner.run("test");

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].name).toBe("failing_tool");
		expect(toolResults[0].content).toContain("Something went wrong");
	});

	it("can block tool execution via tool_call handler", async () => {
		const blockedTools: string[] = [];

		const blocker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_call", async (event) => {
				if (event.toolName === "echo_test") {
					blockedTools.push(event.toolName);
					return { block: true, reason: "Blocked by test" };
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "echo_test", arguments: { message: "blocked" } }] },
				{ text: "After block" },
			]),
			extensionFactories: [echoToolExtension, blocker],
		});

		await runner.run("test");

		expect(blockedTools).toHaveLength(1);
	});
});
