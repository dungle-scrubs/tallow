/**
 * Integration tests for extension event hook composition.
 *
 * Verifies that multiple extensions can register handlers for the same event
 * and that their results compose correctly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";
import { createSessionRunner, type SessionRunner } from "../../test-utils/session-runner.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let runner: SessionRunner | undefined;

afterEach(() => {
	runner?.dispose();
	runner = undefined;
});

// ════════════════════════════════════════════════════════════════
// Context Hook Composition
// ════════════════════════════════════════════════════════════════

describe("Context Hooks", () => {
	it("invokes multiple context handlers", async () => {
		let contextCallCount = 0;

		const ext1 = (pi: ExtensionAPI): void => {
			pi.on("context", async () => {
				contextCallCount++;
			});
		};
		const ext2 = (pi: ExtensionAPI): void => {
			pi.on("context", async () => {
				contextCallCount++;
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "ok" }]),
			extensionFactories: [ext1, ext2],
		});

		await runner.run("test");
		expect(contextCallCount).toBe(2);
	});
});

// ════════════════════════════════════════════════════════════════
// Before Agent Start
// ════════════════════════════════════════════════════════════════

describe("Before Agent Start Hooks", () => {
	it("receives user prompt in before_agent_start", async () => {
		let capturedPrompt = "";

		const tracker = (pi: ExtensionAPI): void => {
			pi.on("before_agent_start", async (event) => {
				capturedPrompt = event.prompt;
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "ok" }]),
			extensionFactories: [tracker],
		});

		await runner.run("Hello, world!");
		expect(capturedPrompt).toBe("Hello, world!");
	});

	it("can modify system prompt via before_agent_start", async () => {
		let observedSystemPrompt = "";

		const modifier = (pi: ExtensionAPI): void => {
			pi.on("before_agent_start", async () => {
				return { systemPrompt: "Custom system prompt for testing" };
			});
		};
		const observer = (pi: ExtensionAPI): void => {
			pi.on("context", async (_event, ctx) => {
				observedSystemPrompt = ctx.getSystemPrompt();
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "ok" }]),
			extensionFactories: [modifier, observer],
		});

		await runner.run("test");
		expect(observedSystemPrompt).toContain("Custom system prompt for testing");
	});
});

// ════════════════════════════════════════════════════════════════
// Input Hooks
// ════════════════════════════════════════════════════════════════

describe("Input Hooks", () => {
	it("receives input events", async () => {
		let capturedInput = "";

		const tracker = (pi: ExtensionAPI): void => {
			pi.on("input", async (event) => {
				capturedInput = event.text;
				return { action: "continue" as const };
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "ok" }]),
			extensionFactories: [tracker],
		});

		await runner.run("Hello from input!");
		expect(capturedInput).toBe("Hello from input!");
	});

	it("can transform input text", async () => {
		let receivedPrompt = "";

		const transformer = (pi: ExtensionAPI): void => {
			pi.on("input", async () => {
				return { action: "transform" as const, text: "Transformed input" };
			});
		};
		const observer = (pi: ExtensionAPI): void => {
			pi.on("before_agent_start", async (event) => {
				receivedPrompt = event.prompt;
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "ok" }]),
			extensionFactories: [transformer, observer],
		});

		await runner.run("Original input");
		expect(receivedPrompt).toBe("Transformed input");
	});
});
