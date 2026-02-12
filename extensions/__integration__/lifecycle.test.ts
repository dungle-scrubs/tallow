/**
 * Integration tests for extension lifecycle event ordering.
 *
 * Verifies that session events fire in the correct order when
 * extensions are loaded into a real (headless) tallow session.
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
// Event Ordering
// ════════════════════════════════════════════════════════════════

describe("Extension Lifecycle", () => {
	it("fires agent lifecycle events in correct order during a prompt", async () => {
		const events: string[] = [];

		const tracker = (pi: ExtensionAPI): void => {
			pi.on("before_agent_start", async () => {
				events.push("before_agent_start");
			});
			pi.on("agent_start", async () => {
				events.push("agent_start");
			});
			pi.on("turn_start", async () => {
				events.push("turn_start");
			});
			pi.on("turn_end", async () => {
				events.push("turn_end");
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "Done" }]),
			extensionFactories: [tracker],
		});

		await runner.run("test");

		expect(events).toEqual(["before_agent_start", "agent_start", "turn_start", "turn_end"]);
	});

	// NOTE: session_start fires during AgentSession.bindExtensions(), which is
	// called by interactive/print modes, not by createAgentSession(). The headless
	// session runner doesn't invoke bindExtensions, so session_start is not
	// testable via this runner. It can be tested with the ExtensionHarness instead.

	it("fires turn events for each model response", async () => {
		const turnStarts: number[] = [];
		const turnEnds: number[] = [];

		const tracker = (pi: ExtensionAPI): void => {
			pi.on("turn_start", async (event) => {
				turnStarts.push(event.turnIndex);
			});
			pi.on("turn_end", async (event) => {
				turnEnds.push(event.turnIndex);
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "Response" }]),
			extensionFactories: [tracker],
		});

		await runner.run("prompt");

		expect(turnStarts).toHaveLength(1);
		expect(turnEnds).toHaveLength(1);
		expect(turnStarts[0]).toBe(turnEnds[0]);
	});

	it("fires events for multiple extensions in registration order", async () => {
		const order: string[] = [];

		const ext1 = (pi: ExtensionAPI): void => {
			pi.on("agent_start", async () => {
				order.push("ext1:agent_start");
			});
		};
		const ext2 = (pi: ExtensionAPI): void => {
			pi.on("agent_start", async () => {
				order.push("ext2:agent_start");
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "ok" }]),
			extensionFactories: [ext1, ext2],
		});

		await runner.run("hi");

		expect(order).toEqual(["ext1:agent_start", "ext2:agent_start"]);
	});

	it("supports multiple sequential prompts", async () => {
		let turnCount = 0;

		const counter = (pi: ExtensionAPI): void => {
			pi.on("turn_start", async () => {
				turnCount++;
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "First" }, { text: "Second" }]),
			extensionFactories: [counter],
		});

		await runner.run("prompt 1");
		await runner.run("prompt 2");

		expect(turnCount).toBe(2);
	});
});
