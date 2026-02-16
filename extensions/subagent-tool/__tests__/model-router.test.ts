import { describe, expect, it, mock } from "bun:test";

/**
 * Tests for the model selection algorithm (selectModels + loadRoutingConfig).
 *
 * Only mocks @mariozechner/pi-ai to provide deterministic model data.
 * Does NOT mock node:fs, model-resolver, or task-classifier — those
 * leaking mocks caused 100+ test failures across the suite.
 */

mock.module("@mariozechner/pi-ai", () => ({
	getProviders: () => ["anthropic", "google"],
	getModels: (provider: string) => {
		const models: Record<string, Array<Record<string, unknown>>> = {
			anthropic: [
				{
					id: "claude-opus-4-6",
					name: "Claude Opus 4.6",
					provider: "anthropic",
					cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 15 },
				},
				{
					id: "claude-sonnet-4-5-20250514",
					name: "Claude Sonnet 4.5",
					provider: "anthropic",
					cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
				},
				{
					id: "claude-haiku-4-5-20250514",
					name: "Claude Haiku 4.5",
					provider: "anthropic",
					cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 0.8 },
				},
			],
			google: [
				{
					id: "gemini-3-flash",
					name: "Gemini 3 Flash",
					provider: "google",
					cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0.15 },
				},
			],
		};
		return models[provider] ?? [];
	},
}));

const { selectModels, loadRoutingConfig } = await import("../model-router.js");

describe("loadRoutingConfig", () => {
	it("returns defaults when settings file is missing", () => {
		const config = loadRoutingConfig();
		expect(config.enabled).toBe(true);
		expect(config.primaryType).toBe("code");
		expect(config.costPreference).toBe("balanced");
	});
});

describe("selectModels", () => {
	it("eco: ranks cheapest models first", () => {
		const ranked = selectModels({ type: "code", complexity: 3, reasoning: "test" }, "eco");
		expect(ranked.length).toBeGreaterThan(0);
		// Gemini 3 Flash has code:5, cheapest → should be first
		expect(ranked[0].id).toBe("gemini-3-flash");
	});

	it("premium: ranks most expensive models first", () => {
		const ranked = selectModels({ type: "code", complexity: 3, reasoning: "test" }, "premium");
		expect(ranked.length).toBeGreaterThan(0);
		expect(ranked[0].id).toBe("claude-opus-4-6");
	});

	it("balanced: prefers exact rating match, then cheapest", () => {
		const ranked = selectModels({ type: "code", complexity: 4, reasoning: "test" }, "balanced");
		expect(ranked.length).toBeGreaterThan(0);
		// Sonnet has code:4, exact match for complexity 4
		expect(ranked[0].id).toContain("sonnet");
	});

	it("filters out models that don't meet complexity requirement", () => {
		// Haiku has code:3, should be filtered for complexity 4+
		const ranked = selectModels({ type: "code", complexity: 4, reasoning: "test" }, "eco");
		expect(ranked.length).toBeGreaterThan(0);
		const ids = ranked.map((m) => m.id);
		expect(ids).not.toContain("claude-haiku-4-5-20250514");
	});

	it("returns multiple fallback candidates", () => {
		const ranked = selectModels({ type: "code", complexity: 3, reasoning: "test" }, "eco");
		// Should have at least 3 candidates (gemini, haiku, sonnet, opus all have code >= 3)
		expect(ranked.length).toBeGreaterThanOrEqual(3);
	});

	it("returns empty array when no model meets requirements", () => {
		// No model has code:6 (max is 5)
		const ranked = selectModels({ type: "code", complexity: 6, reasoning: "test" }, "eco");
		expect(ranked).toEqual([]);
	});

	it("excludes text-only models for vision tasks", () => {
		const ranked = selectModels({ type: "vision", complexity: 3, reasoning: "test" }, "eco");
		// Only models with vision rating >= 3: Opus (3), Sonnet (3), Gemini (5)
		const ids = ranked.map((m) => m.id);
		expect(ids).not.toContain("claude-haiku-4-5-20250514"); // haiku has vision:2
	});
});
