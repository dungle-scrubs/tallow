import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ExtensionHarness } from "../extension-harness.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Trivial extension that registers a tool and a command. */
function sampleExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sample_tool",
		label: "Sample",
		description: "A sample tool",
		parameters: Type.Object({ input: Type.String() }),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	});
	pi.registerCommand("sample", {
		description: "A sample command",
		async handler() {},
	});
	pi.registerFlag("verbose", { type: "boolean", default: false, description: "Verbose output" });
}

/** Extension that registers event handlers for lifecycle tracking. */
function lifecycleExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		/* no-op */
	});
	pi.on("turn_start", async () => {
		/* no-op */
	});
	pi.on("context", async (event) => {
		return { messages: event.messages };
	});
}

// ════════════════════════════════════════════════════════════════
// Extension Harness
// ════════════════════════════════════════════════════════════════

describe("ExtensionHarness", () => {
	let harness: ExtensionHarness;

	afterEach(() => {
		harness?.reset();
	});

	describe("registration tracking", () => {
		it("tracks registered tools", async () => {
			harness = ExtensionHarness.create();
			await harness.loadExtension(sampleExtension);
			expect(harness.tools.has("sample_tool")).toBe(true);
			expect(harness.tools.get("sample_tool")?.description).toBe("A sample tool");
		});

		it("tracks registered commands", async () => {
			harness = ExtensionHarness.create();
			await harness.loadExtension(sampleExtension);
			expect(harness.commands.has("sample")).toBe(true);
			expect(harness.commands.get("sample")?.description).toBe("A sample command");
		});

		it("tracks registered flags with defaults", async () => {
			harness = ExtensionHarness.create();
			await harness.loadExtension(sampleExtension);
			expect(harness.flags.has("verbose")).toBe(true);
			expect(harness.flagValues.get("verbose")).toBe(false);
		});

		it("returns flag values via getFlag", async () => {
			harness = ExtensionHarness.create();
			await harness.loadExtension(sampleExtension);
			expect(harness.api.getFlag("verbose")).toBe(false);
			harness.setFlag("verbose", true);
			expect(harness.api.getFlag("verbose")).toBe(true);
		});
	});

	describe("event handling", () => {
		it("fires events and collects handler results", async () => {
			harness = ExtensionHarness.create();
			await harness.loadExtension(lifecycleExtension);

			const results = await harness.fireEvent("session_start", { type: "session_start" });
			expect(results).toHaveLength(1);
		});

		it("fires context event and returns handler result", async () => {
			harness = ExtensionHarness.create();
			await harness.loadExtension(lifecycleExtension);

			const results = await harness.fireEvent("context", {
				type: "context",
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			expect(results).toHaveLength(1);
			expect(results[0]).toHaveProperty("messages");
		});

		it("handles events with no registered handlers", async () => {
			harness = ExtensionHarness.create();
			const results = await harness.fireEvent("session_shutdown", { type: "session_shutdown" });
			expect(results).toHaveLength(0);
		});

		it("invokes multiple handlers in registration order", async () => {
			harness = ExtensionHarness.create();
			const order: number[] = [];

			harness.api.on("session_start", async () => {
				order.push(1);
			});
			harness.api.on("session_start", async () => {
				order.push(2);
			});
			harness.api.on("session_start", async () => {
				order.push(3);
			});

			await harness.fireEvent("session_start", { type: "session_start" });
			expect(order).toEqual([1, 2, 3]);
		});
	});

	describe("message tracking", () => {
		it("tracks sent custom messages", () => {
			harness = ExtensionHarness.create();
			harness.api.sendMessage({ customType: "test", content: "hello", display: "short" });
			expect(harness.sentMessages).toHaveLength(1);
			expect(harness.sentMessages[0].customType).toBe("test");
		});

		it("tracks sent user messages", () => {
			harness = ExtensionHarness.create();
			harness.api.sendUserMessage("hello from user");
			expect(harness.sentUserMessages).toHaveLength(1);
			expect(harness.sentUserMessages[0].content).toBe("hello from user");
		});

		it("tracks appended entries", () => {
			harness = ExtensionHarness.create();
			harness.api.appendEntry("custom_entry", { foo: "bar" });
			expect(harness.appendedEntries).toHaveLength(1);
			expect(harness.appendedEntries[0].data).toEqual({ foo: "bar" });
		});
	});

	describe("session name", () => {
		it("sets and gets session name", () => {
			harness = ExtensionHarness.create();
			expect(harness.api.getSessionName()).toBeUndefined();
			harness.api.setSessionName("Test Session");
			expect(harness.api.getSessionName()).toBe("Test Session");
		});
	});

	describe("tools", () => {
		it("returns all tools via getAllTools", async () => {
			harness = ExtensionHarness.create();
			await harness.loadExtension(sampleExtension);
			const tools = harness.api.getAllTools();
			expect(tools).toHaveLength(1);
			expect(tools[0].name).toBe("sample_tool");
		});

		it("tracks active tools", () => {
			harness = ExtensionHarness.create();
			harness.api.setActiveTools(["read", "bash"]);
			expect(harness.api.getActiveTools()).toEqual(["read", "bash"]);
		});
	});

	describe("providers", () => {
		it("tracks registered providers", () => {
			harness = ExtensionHarness.create();
			harness.api.registerProvider("custom", { baseUrl: "https://example.com" });
			expect(harness.providers).toHaveLength(1);
			expect(harness.providers[0].name).toBe("custom");
		});
	});

	describe("event bus", () => {
		it("supports emit and on", () => {
			harness = ExtensionHarness.create();
			const received: unknown[] = [];
			harness.eventBus.on("test-channel", (data) => received.push(data));
			harness.eventBus.emit("test-channel", { msg: "hello" });
			expect(received).toEqual([{ msg: "hello" }]);
		});
	});

	describe("reset", () => {
		it("clears all tracked state", async () => {
			harness = ExtensionHarness.create();
			await harness.loadExtension(sampleExtension);
			harness.api.sendMessage({ customType: "x", content: "y", display: "z" });
			harness.reset();
			expect(harness.tools.size).toBe(0);
			expect(harness.commands.size).toBe(0);
			expect(harness.sentMessages).toHaveLength(0);
			expect(harness.handlers.size).toBe(0);
		});
	});
});
