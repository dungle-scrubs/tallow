import { describe, expect, it } from "bun:test";
import type { AssistantMessageEvent, Context, UserMessage } from "@mariozechner/pi-ai";
import { createEchoStreamFn, createMockModel, createScriptedStreamFn } from "../mock-model.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all events from an async iterable stream. */
async function collectEvents(
	stream: AsyncIterable<AssistantMessageEvent>
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

/** Build a minimal context with a user message. */
function contextWithUserMessage(text: string): Context {
	const msg: UserMessage = { role: "user", content: text, timestamp: Date.now() };
	return { messages: [msg] };
}

// ════════════════════════════════════════════════════════════════
// Mock Model
// ════════════════════════════════════════════════════════════════

describe("createMockModel", () => {
	it("returns a valid Model shape", () => {
		const model = createMockModel();
		expect(model.id).toBe("mock-model");
		expect(model.provider).toBe("mock");
		expect(model.contextWindow).toBeGreaterThan(0);
		expect(model.maxTokens).toBeGreaterThan(0);
		expect(model.input).toContain("text");
	});

	it("accepts overrides", () => {
		const model = createMockModel({ id: "custom-id", reasoning: true });
		expect(model.id).toBe("custom-id");
		expect(model.reasoning).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════
// Scripted Stream
// ════════════════════════════════════════════════════════════════

describe("createScriptedStreamFn", () => {
	const model = createMockModel();

	it("produces correct event sequence for text response", async () => {
		const streamFn = createScriptedStreamFn([{ text: "Hello!" }]);
		const stream = streamFn(model, { messages: [] });
		const events = await collectEvents(stream);

		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent).toBeDefined();
		if (doneEvent?.type === "done") {
			expect(doneEvent.reason).toBe("stop");
			const textContent = doneEvent.message.content.find((c) => c.type === "text");
			expect(textContent).toBeDefined();
			if (textContent?.type === "text") {
				expect(textContent.text).toBe("Hello!");
			}
		}
	});

	it("produces correct event sequence for tool call", async () => {
		const streamFn = createScriptedStreamFn([
			{
				toolCalls: [{ name: "read", arguments: { path: "test.ts" } }],
			},
		]);
		const stream = streamFn(model, { messages: [] });
		const events = await collectEvents(stream);

		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);

		const doneEvent = events.find((e) => e.type === "done");
		if (doneEvent?.type === "done") {
			expect(doneEvent.reason).toBe("toolUse");
			const tc = doneEvent.message.content.find((c) => c.type === "toolCall");
			if (tc?.type === "toolCall") {
				expect(tc.name).toBe("read");
				expect(tc.arguments).toEqual({ path: "test.ts" });
			}
		}
	});

	it("consumes responses in order", async () => {
		const streamFn = createScriptedStreamFn([{ text: "First" }, { text: "Second" }]);

		const events1 = await collectEvents(streamFn(model, { messages: [] }));
		const done1 = events1.find((e) => e.type === "done");
		if (done1?.type === "done") {
			const text1 = done1.message.content.find((c) => c.type === "text");
			if (text1?.type === "text") expect(text1.text).toBe("First");
		}

		const events2 = await collectEvents(streamFn(model, { messages: [] }));
		const done2 = events2.find((e) => e.type === "done");
		if (done2?.type === "done") {
			const text2 = done2.message.content.find((c) => c.type === "text");
			if (text2?.type === "text") expect(text2.text).toBe("Second");
		}
	});

	it("returns fallback when exhausted", async () => {
		const streamFn = createScriptedStreamFn([]);
		const events = await collectEvents(streamFn(model, { messages: [] }));
		const done = events.find((e) => e.type === "done");
		if (done?.type === "done") {
			const text = done.message.content.find((c) => c.type === "text");
			if (text?.type === "text") expect(text.text).toContain("no more");
		}
	});
});

// ════════════════════════════════════════════════════════════════
// Echo Stream
// ════════════════════════════════════════════════════════════════

describe("createEchoStreamFn", () => {
	const model = createMockModel();

	it("echoes back user message text", async () => {
		const streamFn = createEchoStreamFn();
		const context = contextWithUserMessage("Hello, echo!");
		const events = await collectEvents(streamFn(model, context));

		const done = events.find((e) => e.type === "done");
		if (done?.type === "done") {
			const text = done.message.content.find((c) => c.type === "text");
			if (text?.type === "text") expect(text.text).toBe("Hello, echo!");
		}
	});

	it("handles empty context gracefully", async () => {
		const streamFn = createEchoStreamFn();
		const events = await collectEvents(streamFn(model, { messages: [] }));
		const done = events.find((e) => e.type === "done");
		if (done?.type === "done") {
			const text = done.message.content.find((c) => c.type === "text");
			if (text?.type === "text") expect(text.text).toContain("no user message");
		}
	});
});
