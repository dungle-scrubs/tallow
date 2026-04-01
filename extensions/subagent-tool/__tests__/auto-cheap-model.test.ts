import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
mockScope.module("@dungle-scrubs/synapse", () => ({
	listAvailableModels: () => mockModels.map((model) => `${model.provider}/${model.id}`),
	parseModelMatrixOverrides: () => undefined,
	resolveModelCandidates: (query: string) => {
		const normalized = query.toLowerCase().trim();
		return mockModels
			.filter(
				(model) =>
					model.id.toLowerCase() === normalized ||
					model.name.toLowerCase().includes(normalized) ||
					`${model.provider}/${model.id}`.toLowerCase() === normalized
			)
			.map((model) => ({
				displayName: `${model.provider}/${model.id}`,
				id: model.id,
				provider: model.provider,
			}));
	},
	resolveModelFuzzy: (
		query: string,
		source?: () => Array<{ id: string; name: string; provider: string }>,
		preferredProviders?: string[]
	) => {
		const normalized = query.toLowerCase().trim();
		const candidates = source
			? source().map((model) => ({
					id: model.id,
					name: model.name,
					provider: model.provider,
				}))
			: mockModels;
		const matches = candidates.filter(
			(model) =>
				model.id.toLowerCase() === normalized ||
				model.name.toLowerCase().includes(normalized) ||
				`${model.provider}/${model.id}`.toLowerCase() === normalized
		);
		const ordered = preferredProviders?.length
			? [...matches].sort((left, right) => {
					const leftIndex = preferredProviders.indexOf(left.provider);
					const rightIndex = preferredProviders.indexOf(right.provider);
					const safeLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
					const safeRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
					return safeLeft - safeRight;
				})
			: matches;
		const selected = ordered[0];
		return selected
			? {
					displayName: `${selected.provider}/${selected.id}`,
					id: selected.id,
					provider: selected.provider,
				}
			: undefined;
	},
	selectModels: (_classification: unknown, costPreference: string) => {
		const ordered =
			costPreference === "premium"
				? [mockModels[0], mockModels[1], mockModels[2], mockModels[3]]
				: [mockModels[3], mockModels[2], mockModels[1], mockModels[0]];
		return ordered.map((model) => ({
			displayName: `${model.provider}/${model.id}`,
			id: model.id,
			provider: model.provider,
		}));
	},
}));

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

beforeEach(() => {
	resetIsolatedRoutingSettings();
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

/**
 * Reset isolated routing settings to an empty object.
 * @returns Nothing
 */
function resetIsolatedRoutingSettings(): void {
	writeJson(join(isolatedHomeDir, ".tallow", "settings.json"), {});
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
	it("routes auto-cheap through the auto-routing path", async () => {
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
		expect(result.model.id.length).toBeGreaterThan(0);
	});

	it("routing keyword still forces auto-routing when routing.enabled is false", async () => {
		writeJson(join(isolatedHomeDir, ".tallow", "settings.json"), {
			routing: { enabled: false },
		});
		try {
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
			expect(result.model.id.length).toBeGreaterThan(0);
		} finally {
			resetIsolatedRoutingSettings();
		}
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
		expect(result.model.id.length).toBeGreaterThan(0);
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

	it("returns a valid ranking payload for auto-cheap", async () => {
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
		expect(result.reason).toBe("auto-routed");
		expect(result.model.id.length).toBeGreaterThan(0);
		for (const fallback of result.fallbacks) {
			expect(fallback.id).not.toBe(result.model.id);
		}
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
