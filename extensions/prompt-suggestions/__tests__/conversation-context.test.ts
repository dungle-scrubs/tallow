/**
 * Tests for conversation context extraction and autocomplete prompt building.
 *
 * Verifies that recent session messages are correctly extracted, truncated,
 * and formatted into context for the autocomplete model.
 */
import { describe, expect, test } from "bun:test";
import type { ConversationContext } from "../autocomplete.js";
import {
	buildAutocompleteSystemPrompt,
	buildConversationContext,
	extractMessageText,
} from "../index.js";

// ─── extractMessageText ──────────────────────────────────────────────────────

describe("extractMessageText", () => {
	test("extracts string content directly", () => {
		const result = extractMessageText({ role: "user", content: "fix the bug" });
		expect(result).toBe("fix the bug");
	});

	test("extracts text from content array", () => {
		const result = extractMessageText({
			role: "assistant",
			content: [
				{ type: "text", text: "I found the issue " },
				{ type: "text", text: "in auth.ts" },
			],
		});
		expect(result).toBe("I found the issue  in auth.ts");
	});

	test("filters non-text content blocks (tool calls, thinking)", () => {
		const result = extractMessageText({
			role: "assistant",
			content: [
				{ type: "thinking", text: "Let me think..." },
				{ type: "text", text: "Here is the fix" },
				{ type: "tool_call", id: "tc_1", name: "edit", input: {} },
			],
		});
		expect(result).toBe("Here is the fix");
	});

	test("returns null for empty content array", () => {
		const result = extractMessageText({ role: "assistant", content: [] });
		expect(result).toBeNull();
	});

	test("returns null for array with no text blocks", () => {
		const result = extractMessageText({
			role: "assistant",
			content: [{ type: "tool_call", id: "tc_1", name: "bash", input: {} }],
		});
		expect(result).toBeNull();
	});

	test("returns null for non-string non-array content", () => {
		const result = extractMessageText({ role: "user", content: 42 });
		expect(result).toBeNull();
	});
});

// ─── buildConversationContext ─────────────────────────────────────────────────

/** Create a mock session manager that returns the given entries from getBranch(). */
function mockSessionManager(entries: unknown[]) {
	return {
		getBranch: () => entries,
		getCwd: () => "/tmp",
		getSessionDir: () => "/tmp/sessions",
		getSessionId: () => "test-session",
		getSessionFile: () => "/tmp/sessions/test.jsonl",
		getLeafId: () => "leaf-1",
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getHeader: () => null,
		getEntries: () => entries,
		getTree: () => [],
		getSessionName: () => undefined,
	} as Parameters<typeof buildConversationContext>[0];
}

describe("buildConversationContext", () => {
	test("extracts user and assistant messages", () => {
		const entries = [
			{
				type: "message",
				message: { role: "user", content: "fix the auth bug" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I found the issue in auth.ts" }],
				},
			},
		];

		const result = buildConversationContext(mockSessionManager(entries));
		expect(result).not.toBeNull();
		expect(result?.recentExchanges).toContain("User: fix the auth bug");
		expect(result?.recentExchanges).toContain("Assistant: I found the issue in auth.ts");
	});

	test("skips toolResult messages", () => {
		const entries = [
			{
				type: "message",
				message: { role: "user", content: "run tests" },
			},
			{
				type: "message",
				message: { role: "toolResult", content: "3 tests passed" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "All tests pass" }],
				},
			},
		];

		const result = buildConversationContext(mockSessionManager(entries));
		expect(result).not.toBeNull();
		expect(result?.recentExchanges).not.toContain("toolResult");
		expect(result?.recentExchanges).not.toContain("3 tests passed");
		expect(result?.recentExchanges).toContain("User: run tests");
		expect(result?.recentExchanges).toContain("Assistant: All tests pass");
	});

	test("skips non-message entries (model_change, compaction, etc.)", () => {
		const entries = [
			{ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5" },
			{
				type: "message",
				message: { role: "user", content: "hello" },
			},
			{ type: "compaction", summary: "compacted stuff" },
		];

		const result = buildConversationContext(mockSessionManager(entries));
		expect(result).not.toBeNull();
		expect(result?.recentExchanges).toBe("User: hello");
	});

	test("returns null for empty session", () => {
		const result = buildConversationContext(mockSessionManager([]));
		expect(result).toBeNull();
	});

	test("returns null when no user/assistant text messages exist", () => {
		const entries = [
			{ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5" },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "tool_call", id: "tc_1", name: "bash", input: {} }],
				},
			},
		];

		const result = buildConversationContext(mockSessionManager(entries));
		expect(result).toBeNull();
	});

	test("truncates long messages to 500 chars", () => {
		const longText = "x".repeat(800);
		const entries = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: longText }] },
			},
		];

		const result = buildConversationContext(mockSessionManager(entries));
		expect(result).not.toBeNull();
		// 500 chars + "…" + "Assistant: " prefix
		expect(result?.recentExchanges.length).toBeLessThan(520);
		expect(result?.recentExchanges).toContain("…");
	});

	test("limits to MAX_EXCHANGES (6) most recent", () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({
			type: "message",
			message: { role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` },
		}));

		const result = buildConversationContext(mockSessionManager(entries));
		expect(result).not.toBeNull();
		// Should contain messages 4-9 (last 6), not 0-3
		expect(result?.recentExchanges).toContain("message 4");
		expect(result?.recentExchanges).toContain("message 9");
		expect(result?.recentExchanges).not.toContain("message 3");
	});

	test("preserves chronological order (oldest first)", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "first" } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "second" }] },
			},
			{ type: "message", message: { role: "user", content: "third" } },
		];

		const result = buildConversationContext(mockSessionManager(entries));
		expect(result).not.toBeNull();
		const firstIdx = result?.recentExchanges.indexOf("first");
		const secondIdx = result?.recentExchanges.indexOf("second");
		const thirdIdx = result?.recentExchanges.indexOf("third");
		expect(firstIdx).toBeLessThan(secondIdx);
		expect(secondIdx).toBeLessThan(thirdIdx);
	});

	test("stops adding when char budget exhausted", () => {
		// Each message ~400 chars, budget is 2000, so max ~5 fit
		const entries = Array.from({ length: 10 }, (_, i) => ({
			type: "message",
			message: { role: "user", content: `${"a".repeat(390)} msg${i}` },
		}));

		const result = buildConversationContext(mockSessionManager(entries));
		expect(result).not.toBeNull();
		expect(result?.recentExchanges.length).toBeLessThanOrEqual(2200); // some label overhead
	});
});

// ─── buildAutocompleteSystemPrompt ───────────────────────────────────────────

describe("buildAutocompleteSystemPrompt", () => {
	test("without context: instructs developer voice prediction", () => {
		const prompt = buildAutocompleteSystemPrompt(null);
		expect(prompt).toContain("developer");
		expect(prompt).toContain("DEVELOPER's words");
		expect(prompt).toContain("not responding as an AI assistant");
		expect(prompt).not.toContain("recent conversation");
	});

	test("with context: includes conversation history", () => {
		const context: ConversationContext = {
			recentExchanges: "User: fix the auth\n\nAssistant: Found it in auth.ts",
		};
		const prompt = buildAutocompleteSystemPrompt(context);
		expect(prompt).toContain("DEVELOPER's words");
		expect(prompt).toContain("recent conversation");
		expect(prompt).toContain("fix the auth");
		expect(prompt).toContain("Found it in auth.ts");
	});
});
