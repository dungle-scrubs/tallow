import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createMockScope } from "../../../test-utils/mock-scope.js";

/**
 * Tests for auto-cheap/auto-premium routing keywords.
 *
 * Verifies that agent frontmatter `model: auto-cheap` correctly forces
 * eco routing, and that per-call hints can override the keyword.
 */

const mockModels = [
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
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		provider: "google",
		cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0.15 },
	},
];

const mockScope = createMockScope(import.meta.url);
mockScope.module("@mariozechner/pi-ai", () => ({
	getProviders: () => ["anthropic", "google"],
	getModels: (provider: string) => mockModels.filter((m) => m.provider === provider),
}));

// NOTE: Do NOT mock ../model-resolver.js — it leaks across test files in bun.
// The pi-ai mock above provides model data that resolveModelFuzzy uses.

mockScope.module("../task-classifier.js", () => ({
	classifyTask: async (_task: string, primaryType: string) => ({
		type: primaryType,
		complexity: 3,
		reasoning: "mock classification",
	}),
	findCheapestModel: () => "claude-haiku-4-5-20250514",
}));

let parseRoutingKeyword!: typeof import("../model-router.js").parseRoutingKeyword;
let routeModel!: typeof import("../model-router.js").routeModel;
let isolatedCwdDir = "";
let isolatedHomeDir = "";
const originalHome = process.env.HOME;

beforeAll(async () => {
	isolatedCwdDir = mkdtempSync(join(tmpdir(), "tallow-route-keyword-cwd-"));
	isolatedHomeDir = mkdtempSync(join(tmpdir(), "tallow-route-keyword-home-"));
	mkdirSync(join(isolatedHomeDir, ".tallow"), { recursive: true });
	process.env.HOME = isolatedHomeDir;
	mockScope.install();
	const mod = await import(`../model-router.js?t=${Date.now()}`);
	parseRoutingKeyword = mod.parseRoutingKeyword;
	routeModel = mod.routeModel;
});

afterAll(() => {
	mockScope.teardown();
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (isolatedCwdDir) {
		rmSync(isolatedCwdDir, { force: true, recursive: true });
	}
	if (isolatedHomeDir) {
		rmSync(isolatedHomeDir, { force: true, recursive: true });
	}
});

/**
 * Write a JSON file, creating parent directories when needed.
 *
 * @param filePath - Destination path
 * @param value - JSON value to serialize
 * @returns Nothing
 */
function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("parseRoutingKeyword", () => {
	it("returns 'eco' for auto-cheap", () => {
		expect(parseRoutingKeyword("auto-cheap")).toBe("eco");
	});

	it("returns 'eco' for auto-eco", () => {
		expect(parseRoutingKeyword("auto-eco")).toBe("eco");
	});

	it("returns 'balanced' for auto-balanced", () => {
		expect(parseRoutingKeyword("auto-balanced")).toBe("balanced");
	});

	it("returns 'premium' for auto-premium", () => {
		expect(parseRoutingKeyword("auto-premium")).toBe("premium");
	});

	it("is case-insensitive", () => {
		expect(parseRoutingKeyword("AUTO-CHEAP")).toBe("eco");
		expect(parseRoutingKeyword("Auto-Premium")).toBe("premium");
	});

	it("returns undefined for non-keywords", () => {
		expect(parseRoutingKeyword("claude-opus-4-6")).toBeUndefined();
		expect(parseRoutingKeyword("auto-turbo")).toBeUndefined();
		expect(parseRoutingKeyword("")).toBeUndefined();
	});
});

describe("routeModel with auto-cheap", () => {
	it("routes to cheapest capable model", async () => {
		const result = await routeModel(
			"find all API routes in src/",
			undefined,
			"auto-cheap",
			"claude-opus-4-6",
			undefined,
			undefined,
			isolatedCwdDir
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Gemini 3 Flash: cheapest model with code >= 3
		expect(result.model.id).toBe("gemini-3-flash");
		expect(result.reason).toBe("auto-routed");
	});

	it("routing keyword still forces auto-routing when routing.enabled is false", async () => {
		writeJson(join(isolatedHomeDir, ".tallow", "settings.json"), {
			routing: { enabled: false },
		});
		const result = await routeModel(
			"find all API routes in src/",
			undefined,
			"auto-cheap",
			"claude-opus-4-6",
			undefined,
			undefined,
			isolatedCwdDir
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.reason).toBe("auto-routed");
		expect(result.model.id).toBe("gemini-3-flash");

		writeJson(join(isolatedHomeDir, ".tallow", "settings.json"), {});
	});

	it("auto-premium routes in premium mode", async () => {
		const result = await routeModel(
			"design system architecture",
			undefined,
			"auto-premium",
			"claude-opus-4-6",
			undefined,
			undefined,
			isolatedCwdDir
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.reason).toBe("auto-routed");
		expect(result.fallbacks.length).toBeGreaterThan(0);
	});

	it("per-call hints override routing keyword", async () => {
		const result = await routeModel(
			"complex task",
			undefined,
			"auto-cheap",
			"claude-opus-4-6",
			undefined,
			{ costPreference: "premium" },
			isolatedCwdDir
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const premiumResult = await routeModel(
			"complex task",
			undefined,
			"auto-premium",
			"claude-opus-4-6",
			undefined,
			undefined,
			isolatedCwdDir
		);
		expect(premiumResult.ok).toBe(true);
		if (!premiumResult.ok) return;
		// Per-call premium hint should behave the same as auto-premium
		expect(result.model.id).toBe(premiumResult.model.id);
	});

	it("explicit model override takes precedence over routing keyword", async () => {
		const result = await routeModel(
			"some task",
			"claude-haiku-4-5-20250514",
			"auto-premium",
			"claude-opus-4-6",
			undefined,
			undefined,
			isolatedCwdDir
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Explicit model override (step 1) wins over agent frontmatter keyword (step 2)
		expect(result.model.id).toBe("claude-haiku-4-5-20250514");
		expect(result.reason).toBe("explicit");
	});

	it("provides fallback candidates in ranking order", async () => {
		const result = await routeModel(
			"find files",
			undefined,
			"auto-cheap",
			"claude-opus-4-6",
			undefined,
			undefined,
			isolatedCwdDir
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Should have fallbacks after the top pick
		expect(result.fallbacks.length).toBeGreaterThan(0);
		// First fallback should be more expensive than the top pick
		expect(result.model.id).toBe("gemini-3-flash");
	});

	it("regular model name still resolves via fuzzy matching", async () => {
		const result = await routeModel(
			"some task",
			undefined,
			"claude-haiku-4-5-20250514",
			"claude-opus-4-6",
			undefined,
			undefined,
			isolatedCwdDir
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.model.id).toBe("claude-haiku-4-5-20250514");
		expect(result.reason).toBe("agent-frontmatter");
	});
});
