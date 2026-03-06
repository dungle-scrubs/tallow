/**
 * Unit tests for the slash-command-bridge extension.
 *
 * Uses ExtensionHarness for isolated testing of tool registration,
 * command dispatch, context injection, and error handling.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ContextUsage, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import slashCommandBridge from "../index.js";

// ── Setup ────────────────────────────────────────────────────────────────────

let harness: ExtensionHarness;

beforeEach(async () => {
	harness = ExtensionHarness.create();
	await harness.loadExtension(slashCommandBridge);
});

afterEach(async () => {
	await harness.fireEvent("session_before_switch", {
		type: "session_before_switch",
		reason: "switch",
	});
});

// ── Registration ─────────────────────────────────────────────────────────────

describe("registration", () => {
	test("registers run_slash_command tool", () => {
		expect(harness.tools.has("run_slash_command")).toBe(true);
	});

	test("tool has correct label", () => {
		const tool = harness.tools.get("run_slash_command");
		expect(tool?.label).toBe("run_slash_command");
	});

	test("tool description lists available commands", () => {
		const tool = harness.tools.get("run_slash_command");
		expect(tool?.description).toContain("show-system-prompt");
		expect(tool?.description).toContain("context");
		expect(tool?.description).toContain("compact");
	});

	test("registers before_agent_start handler", () => {
		expect(harness.handlers.has("before_agent_start")).toBe(true);
	});
});

// ── Command execution: show-system-prompt ────────────────────────────────────

describe("show-system-prompt", () => {
	test("returns the current system prompt", async () => {
		const systemPrompt = "You are a helpful assistant with custom instructions.";
		const ctx = buildContext({ getSystemPrompt: () => systemPrompt });

		const result = await executeTool({ command: "show-system-prompt" }, ctx);

		expect(result.content[0]).toEqual({ type: "text", text: systemPrompt });
	});

	test("includes prompt length in details", async () => {
		const systemPrompt = "Short prompt.";
		const ctx = buildContext({ getSystemPrompt: () => systemPrompt });

		const result = await executeTool({ command: "show-system-prompt" }, ctx);

		expect(result.details).toEqual({ command: "show-system-prompt", length: systemPrompt.length });
	});

	test("handles empty system prompt", async () => {
		const ctx = buildContext({ getSystemPrompt: () => "" });

		const result = await executeTool({ command: "show-system-prompt" }, ctx);

		expect(result.content[0]).toEqual({ type: "text", text: "" });
		expect(result.isError).toBeUndefined();
	});
});

// ── Command execution: context ───────────────────────────────────────────────

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
			expect(text.text).toContain("155,000"); // free tokens
		}
	});

	test("includes token data in details", async () => {
		const usage: ContextUsage = { tokens: 10000, contextWindow: 100000 };
		const ctx = buildContext({ getContextUsage: () => usage });

		const result = await executeTool({ command: "context" }, ctx);

		expect(result.details).toEqual({
			command: "context",
			tokens: 10000,
			contextWindow: 100000,
		});
	});

	test("returns error when no usage data available", async () => {
		const ctx = buildContext({ getContextUsage: () => undefined });

		const result = await executeTool({ command: "context" }, ctx);

		expect(result.isError).toBe(true);
		const text = result.content[0];
		if (text?.type === "text") {
			expect(text.text).toContain("No context usage data");
		}
	});

	test("returns no-usage error when token count is unknown", async () => {
		const usage: ContextUsage = { tokens: null, contextWindow: 200000, percent: null };
		const ctx = buildContext({ getContextUsage: () => usage });

		const result = await executeTool({ command: "context" }, ctx);

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ command: "context", error: "no_usage_data" });
		const text = result.content[0];
		if (text?.type === "text") {
			expect(text.text).toContain("No context usage data");
			expect(text.text).not.toContain("0 / 200,000");
			expect(text.text).not.toContain("0.0%");
		}
	});

	test("handles zero context window gracefully", async () => {
		const usage: ContextUsage = { tokens: 0, contextWindow: 0 };
		const ctx = buildContext({ getContextUsage: () => usage });

		const result = await executeTool({ command: "context" }, ctx);

		expect(result.isError).toBeUndefined();
	});
});

// ── Command execution: compact ───────────────────────────────────────────────

describe("compact", () => {
	test("does NOT call ctx.compact() immediately — defers to agent_end", async () => {
		let compactCalled = false;
		const ctx = buildContext({
			compact: () => {
				compactCalled = true;
			},
		});

		await executeTool({ command: "compact" }, ctx);

		expect(compactCalled).toBe(false);
	});

	test("returns message instructing model to finish response", async () => {
		const ctx = buildContext({ compact: () => {} });

		const result = await executeTool({ command: "compact" }, ctx);

		expect(result.isError).toBeUndefined();
		const text = result.content[0];
		if (text?.type === "text") {
			expect(text.text).toContain("compaction will begin after this response");
			expect(text.text).toContain("Do NOT call any more tools");
		}
	});

	test("includes command name in details", async () => {
		const ctx = buildContext({ compact: () => {} });

		const result = await executeTool({ command: "compact" }, ctx);

		expect(result.details).toEqual({ command: "compact" });
	});

	test("agent_end hook triggers deferred compact with callbacks", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			compact: (options) => {
				compactOptions = options;
			},
		});

		// Tool sets the deferred flag
		await executeTool({ command: "compact" }, toolCtx);

		// agent_end fires — should trigger compact
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

		expect(compactOptions).toBeDefined();
		expect(typeof compactOptions?.onComplete).toBe("function");
		expect(typeof compactOptions?.onError).toBe("function");

		// Clean up compact progress interval to avoid cross-test leakage.
		compactOptions?.onError?.();
	});

	test("agent_end hook starts compact heartbeat updates with elapsed status", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const workingMessages: Array<string | undefined> = [];
		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: (message?: string) => {
					workingMessages.push(message);
				},
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

		expect(workingMessages[0]).toBe("Compacting session…");
		expect(statusUpdates[0]?.key).toBe("compact");
		expect(statusUpdates[0]?.text).toContain("compacting · 0s");

		await sleep(1100);

		const hasElapsedUpdate = statusUpdates.some((update) =>
			update.text?.includes("compacting · 1s")
		);
		expect(hasElapsedUpdate).toBe(true);

		compactOptions?.onError?.();
	});

	test("onComplete stops compact heartbeat and transitions to resuming", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const workingMessages: Array<string | undefined> = [];
		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: (message?: string) => {
					workingMessages.push(message);
				},
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);
		await sleep(1100);

		compactOptions?.onComplete?.();
		expect(workingMessages.at(-1)).toBe("Resuming task…");
		expect(statusUpdates.at(-1)).toEqual({ key: "compact", text: "⏳ resuming" });

		const updatesAfterComplete = statusUpdates.length;
		await sleep(1200);
		expect(statusUpdates).toHaveLength(updatesAfterComplete);
	});

	test("onComplete sends continuation message when agent is idle and no queued messages", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

		// Trigger onComplete and wait for the setTimeout(200) to fire
		compactOptions?.onComplete?.();
		await new Promise((resolve) => setTimeout(resolve, 300));

		const continuation = harness.sentMessages.find((m) => m.customType === "compact-continue");
		expect(continuation).toBeDefined();
		expect(continuation?.display).toBe(false);
		expect(continuation?.options?.triggerTurn).toBe(true);
		expect(continuation?.content).toContain("compaction is complete");
	});

	test("onComplete always schedules continuation even when compaction queue has messages", async () => {
		// Previously, onComplete short-circuited when hasCompactionQueuedMessages()
		// returned true. This caused orphaned session steering messages because the
		// method's false positive (checking session steering too) prevented the
		// continuation timer from firing. Now the timer always fires — safety nets
		// (turn_start cancellation, isIdle() check) prevent duplicate prompts.
		// See plan 160.
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: () => {},
				setStatus: () => {},
				// Even with hasCompactionQueuedMessages exposed, onComplete
				// no longer checks it.
				hasCompactionQueuedMessages: () => true,
			} as unknown as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

		compactOptions?.onComplete?.();
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Continuation fires regardless — safety nets prevent duplicates
		const continuation = harness.sentMessages.find((m) => m.customType === "compact-continue");
		expect(continuation).toBeDefined();
		expect(continuation?.content).toContain("compaction is complete");
	});

	test("onComplete skips continuation and clears indicators when agent is not idle", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const workingMessages: Array<string | undefined> = [];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: (message?: string) => {
					workingMessages.push(message);
				},
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => false,
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

		compactOptions?.onComplete?.();
		await new Promise((resolve) => setTimeout(resolve, 300));

		const continuation = harness.sentMessages.find((m) => m.customType === "compact-continue");
		expect(continuation).toBeUndefined();

		// When not idle, the !isIdle() branch clears indicators
		expect(statusUpdates.at(-1)).toEqual({ key: "compact", text: undefined });
		expect(workingMessages.at(-1)).toBeUndefined();
	});

	test("onError stops compact heartbeat, clears status, and sends no continuation", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: () => {},
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);
		await sleep(1100);

		compactOptions?.onError?.();
		expect(statusUpdates.at(-1)).toEqual({ key: "compact", text: undefined });

		const updatesAfterError = statusUpdates.length;
		await sleep(1200);
		expect(statusUpdates).toHaveLength(updatesAfterError);

		const continuation = harness.sentMessages.find((m) => m.customType === "compact-continue");
		expect(continuation).toBeUndefined();
	});

	test("agent_end hook is a no-op when no compact is pending", async () => {
		let compactCalled = false;
		const ctx = buildContext({
			compact: () => {
				compactCalled = true;
			},
		});

		// Fire agent_end without a preceding compact tool call
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, ctx);

		expect(compactCalled).toBe(false);
	});

	test("turn_start cancels continuation timer before it fires", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: () => {},
				setStatus: () => {},
			} as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

		// Trigger onComplete — starts the 200ms timer
		compactOptions?.onComplete?.();

		// Fire turn_start before the timer expires (simulates flushCompactionQueue
		// prompting the agent first)
		const turnCtx = buildContext({
			hasUI: true,
			ui: {
				setStatus: () => {},
			} as ExtensionContext["ui"],
		});
		await harness.fireEvent("turn_start", { type: "turn_start" }, turnCtx);

		// Wait longer than the 200ms timeout
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Timer was cancelled — no duplicate continuation message sent
		const continuation = harness.sentMessages.find((m) => m.customType === "compact-continue");
		expect(continuation).toBeUndefined();
	});

	test("turn_start clears footer status when resuming after compact", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: () => {},
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);
		compactOptions?.onComplete?.();

		// Resuming status should be set
		expect(statusUpdates.at(-1)).toEqual({ key: "compact", text: "⏳ resuming" });

		// turn_start fires — should clear the footer status
		const turnCtx = buildContext({
			hasUI: true,
			ui: {
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
		});
		await harness.fireEvent("turn_start", { type: "turn_start" }, turnCtx);

		expect(statusUpdates.at(-1)).toEqual({ key: "compact", text: undefined });
	});

	test("turn_start is a no-op when not resuming after compact", async () => {
		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const turnCtx = buildContext({
			hasUI: true,
			ui: {
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
		});

		// Fire turn_start without any preceding compaction
		await harness.fireEvent("turn_start", { type: "turn_start" }, turnCtx);

		// No status updates should have been made
		expect(statusUpdates).toHaveLength(0);
	});

	test("session_before_switch clears active compact heartbeat state", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: () => {},
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);
		await sleep(1100);

		expect(compactOptions).toBeDefined();
		expect(statusUpdates.some((update) => update.text?.includes("compacting"))).toBe(true);

		const switchCtx = buildContext({
			hasUI: true,
			ui: {
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
		});
		await harness.fireEvent(
			"session_before_switch",
			{ type: "session_before_switch", reason: "switch" },
			switchCtx
		);

		expect(statusUpdates.at(-1)).toEqual({ key: "compact", text: undefined });

		const updatesAfterSwitch = statusUpdates.length;
		await sleep(1200);
		expect(statusUpdates).toHaveLength(updatesAfterSwitch);
	});

	test("session_before_switch clears resuming state and footer status", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: () => {},
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);
		compactOptions?.onComplete?.();

		// Resuming status should be set
		expect(statusUpdates.at(-1)).toEqual({ key: "compact", text: "⏳ resuming" });

		// Session switch fires — should clear resuming state
		const switchCtx = buildContext({
			hasUI: true,
			ui: {
				setStatus: (key: string, text?: string) => {
					statusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
		});
		await harness.fireEvent(
			"session_before_switch",
			{ type: "session_before_switch", reason: "switch" },
			switchCtx
		);

		expect(statusUpdates.at(-1)).toEqual({ key: "compact", text: undefined });

		// Subsequent turn_start should be a no-op (flag was cleared)
		const turnStatusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const turnCtx = buildContext({
			hasUI: true,
			ui: {
				setStatus: (key: string, text?: string) => {
					turnStatusUpdates.push({ key, text });
				},
			} as ExtensionContext["ui"],
		});
		await harness.fireEvent("turn_start", { type: "turn_start" }, turnCtx);

		expect(turnStatusUpdates).toHaveLength(0);
	});

	test("session_before_switch cancels continuation timer", async () => {
		let compactOptions: Parameters<ExtensionContext["compact"]>[0];
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			hasUI: true,
			ui: {
				setWorkingMessage: () => {},
				setStatus: () => {},
			} as ExtensionContext["ui"],
			compact: (options) => {
				compactOptions = options;
			},
			isIdle: () => true,
		});

		await executeTool({ command: "compact" }, toolCtx);
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

		// Trigger onComplete — starts the 200ms timer
		compactOptions?.onComplete?.();

		// Session switch fires before timer expires
		const switchCtx = buildContext({
			hasUI: true,
			ui: {
				setStatus: () => {},
			} as ExtensionContext["ui"],
		});
		await harness.fireEvent(
			"session_before_switch",
			{ type: "session_before_switch", reason: "switch" },
			switchCtx
		);

		// Wait longer than the 200ms timeout
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Timer was cancelled — no continuation message sent
		const continuation = harness.sentMessages.find((m) => m.customType === "compact-continue");
		expect(continuation).toBeUndefined();
	});

	test("repeated compact lifecycle does not leave duplicate heartbeat intervals", async () => {
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		const createdHandles: unknown[] = [];
		const clearedHandles: unknown[] = [];
		let handleIndex = 0;

		globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], _ms?: number) => {
			void callback;
			handleIndex += 1;
			const handle = { id: handleIndex };
			createdHandles.push(handle);
			return handle as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval;
		globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
			clearedHandles.push(handle);
		}) as typeof clearInterval;

		try {
			const toolCtx = buildContext({ compact: () => {} });
			const agentEndCtx = buildContext({
				hasUI: true,
				ui: {
					setWorkingMessage: () => {},
					setStatus: () => {},
				} as ExtensionContext["ui"],
				compact: () => {},
			});

			await executeTool({ command: "compact" }, toolCtx);
			await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

			await executeTool({ command: "compact" }, toolCtx);
			await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

			await harness.fireEvent("session_before_switch", {
				type: "session_before_switch",
				reason: "switch",
			});

			expect(createdHandles).toHaveLength(2);
			expect(clearedHandles).toContain(createdHandles[0]);
			expect(clearedHandles).toContain(createdHandles[1]);
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	test("session_before_switch clears pending compact", async () => {
		let compactCalled = false;
		const toolCtx = buildContext({ compact: () => {} });
		const agentEndCtx = buildContext({
			compact: () => {
				compactCalled = true;
			},
		});

		// Set pending compact
		await executeTool({ command: "compact" }, toolCtx);

		// Session switch fires — should clear the flag
		await harness.fireEvent("session_before_switch", {
			type: "session_before_switch",
			reason: "switch",
		});

		// agent_end should now be a no-op
		await harness.fireEvent("agent_end", { type: "agent_end", messages: [] }, agentEndCtx);

		expect(compactCalled).toBe(false);
	});
});

// ── Error handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
	test("rejects unknown commands", async () => {
		const ctx = buildContext();

		const result = await executeTool({ command: "nonexistent" }, ctx);

		expect(result.isError).toBe(true);
		const text = result.content[0];
		if (text?.type === "text") {
			expect(text.text).toContain("Unknown command");
			expect(text.text).toContain("nonexistent");
			expect(text.text).toContain("show-system-prompt");
			expect(text.text).toContain("context");
			expect(text.text).toContain("compact");
		}
	});

	test("rejects commands with / prefix", async () => {
		const ctx = buildContext();

		const result = await executeTool({ command: "/compact" }, ctx);

		expect(result.isError).toBe(true);
	});

	test("rejects empty command string", async () => {
		const ctx = buildContext();

		const result = await executeTool({ command: "" }, ctx);

		expect(result.isError).toBe(true);
	});
});

// ── Context injection ────────────────────────────────────────────────────────

describe("context injection", () => {
	test("injects hidden message listing bridged commands", async () => {
		const results = await harness.fireEvent("before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "",
		});

		const result = results.find((r) => r != null) as
			| {
					message: { customType: string; content: string; display: boolean };
			  }
			| undefined;

		expect(result).toBeDefined();
		expect(result?.message.customType).toBe("slash-command-bridge-context");
		expect(result?.message.display).toBe(false);
		expect(result?.message.content).toContain("run_slash_command");
	});

	test("context message mentions available commands", async () => {
		const results = await harness.fireEvent("before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "",
		});

		const result = results.find((r) => r != null) as
			| {
					message: { content: string };
			  }
			| undefined;

		expect(result?.message.content).toContain("/show-system-prompt");
		expect(result?.message.content).toContain("/context");
		expect(result?.message.content).toContain("/compact");
	});
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock ExtensionContext with overridable methods.
 *
 * @param overrides - Methods to override on the default stub context
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
 * Waits for a given number of milliseconds.
 *
 * @param milliseconds - Delay duration in milliseconds
 * @returns Promise that resolves after the delay
 */
function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Execute the run_slash_command tool with the given params and context.
 *
 * @param params - Tool parameters
 * @param ctx - Extension context (optional, uses default stub)
 * @returns Tool execution result
 */
async function executeTool(params: { command: string }, ctx?: ExtensionContext) {
	const tool = harness.tools.get("run_slash_command");
	if (!tool) throw new Error("run_slash_command tool not registered");

	return tool.execute("test-call-id", params, undefined, undefined, ctx ?? buildContext());
}
