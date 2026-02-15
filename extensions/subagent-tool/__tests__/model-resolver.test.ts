import { describe, expect, it, mock } from "bun:test";

/**
 * Tests for fuzzy model resolution.
 *
 * Mocks the pi-ai registry to test resolution cascade tiers
 * in isolation without requiring real provider configs.
 */

// Mock pi-ai module before imports
const mockProviders = ["anthropic", "openai", "google"];
const mockModels: Record<string, Array<{ id: string; name: string; provider: string }>> = {
	anthropic: [
		{ id: "claude-opus-4-5-20250514", name: "Claude Opus 4.5", provider: "anthropic" },
		{ id: "claude-sonnet-4-5-20250514", name: "Claude Sonnet 4.5", provider: "anthropic" },
		{ id: "claude-haiku-4-5-20250514", name: "Claude Haiku 4.5", provider: "anthropic" },
	],
	openai: [
		{ id: "gpt-5.2", name: "GPT-5.2", provider: "openai" },
		{ id: "gpt-5.1-codex", name: "GPT-5.1 Codex", provider: "openai" },
	],
	google: [{ id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google" }],
};

mock.module("@mariozechner/pi-ai", () => ({
	getProviders: () => mockProviders,
	getModels: (provider: string) => mockModels[provider] ?? [],
}));

// Import after mocking
const { resolveModelFuzzy, listAvailableModels } = await import("../model-resolver.js");

describe("resolveModelFuzzy", () => {
	it("returns undefined for empty query", () => {
		expect(resolveModelFuzzy("")).toBeUndefined();
		expect(resolveModelFuzzy("  ")).toBeUndefined();
	});

	it("tier 1: exact ID match", () => {
		const result = resolveModelFuzzy("claude-opus-4-5-20250514");
		expect(result).toBeDefined();
		expect(result?.id).toBe("claude-opus-4-5-20250514");
		expect(result?.provider).toBe("anthropic");
	});

	it("tier 2: case-insensitive ID match", () => {
		const result = resolveModelFuzzy("Claude-Opus-4-5-20250514");
		expect(result).toBeDefined();
		expect(result?.id).toBe("claude-opus-4-5-20250514");
	});

	it("tier 2.5: normalized match — strips separators", () => {
		// "gpt5.1codex" should match "gpt-5.1-codex" after stripping separators
		const result = resolveModelFuzzy("gpt5.1codex");
		expect(result).toBeDefined();
		expect(result?.id).toBe("gpt-5.1-codex");
	});

	it("tier 3: provider/id format", () => {
		const result = resolveModelFuzzy("anthropic/claude-opus-4-5-20250514");
		expect(result).toBeDefined();
		expect(result?.id).toBe("claude-opus-4-5-20250514");
		expect(result?.provider).toBe("anthropic");
	});

	it("tier 4: token overlap — 'opus' matches Opus model", () => {
		const result = resolveModelFuzzy("opus");
		expect(result).toBeDefined();
		expect(result?.id).toContain("opus");
	});

	it("tier 4: token overlap — 'sonnet 4.5' matches Sonnet 4.5", () => {
		const result = resolveModelFuzzy("sonnet 4.5");
		expect(result).toBeDefined();
		expect(result?.id).toContain("sonnet");
	});

	it("tier 4: tiebreak prefers shorter ID", () => {
		// "gpt" matches multiple OpenAI models — shorter ID should win
		const result = resolveModelFuzzy("gpt 5.2");
		expect(result).toBeDefined();
		expect(result?.id).toBe("gpt-5.2");
	});

	it("tier 5: substring match", () => {
		const result = resolveModelFuzzy("gemini");
		expect(result).toBeDefined();
		expect(result?.id).toBe("gemini-3-pro");
	});

	it("returns undefined for no match", () => {
		expect(resolveModelFuzzy("nonexistent-model-xyz")).toBeUndefined();
	});
});

describe("listAvailableModels", () => {
	it("lists all models from all providers", () => {
		const models = listAvailableModels();
		expect(models.length).toBe(6);
		expect(models).toContain("anthropic/claude-opus-4-5-20250514");
		expect(models).toContain("openai/gpt-5.2");
		expect(models).toContain("google/gemini-3-pro");
	});
});
