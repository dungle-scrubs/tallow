import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockScope } from "../../../test-utils/mock-scope.js";

const mockModels = [
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		provider: "anthropic",
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 15 },
	},
	{
		id: "MiniMax-M2.1",
		name: "MiniMax M2.1",
		provider: "minimax",
		cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "minimax/minimax-m2.1",
		name: "MiniMax M2.1 (OpenRouter)",
		provider: "openrouter",
		cost: { input: 0.27, output: 0.95, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "glm-5",
		name: "GLM-5 (ZAI)",
		provider: "zai",
		cost: { input: 1, output: 3.2, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "glm-5",
		name: "GLM-5 (OpenCode)",
		provider: "opencode",
		cost: { input: 0.8, output: 2.56, cacheRead: 0, cacheWrite: 0 },
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
	selectModels: () => [],
}));

mockScope.module("../task-classifier.js", () => ({
	classifyTask: async () => ({ complexity: 3, reasoning: "mock classification", type: "code" }),
	findCheapestModel: () => undefined,
}));

let routeModel!: typeof import("../model-router.js").routeModel;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"OPENCODE_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"TALLOW_CODING_AGENT_DIR",
	"VERCEL_AI_GATEWAY_API_KEY",
	"VERCEL_API_KEY",
	"XAI_API_KEY",
	"ZAI_API_KEY",
] as const;

let isolatedTallowHome: string;

beforeAll(async () => {
	mockScope.install();
	const mod = await import(`../model-router.js?t=${Date.now()}`);
	routeModel = mod.routeModel;
});

afterAll(() => {
	mockScope.teardown();
});

beforeEach(() => {
	for (const key of ENV_KEYS) {
		ORIGINAL_ENV[key] = process.env[key];
		delete process.env[key];
	}
	isolatedTallowHome = mkdtempSync(join(tmpdir(), "subagent-router-explicit-"));
	process.env.TALLOW_CODING_AGENT_DIR = isolatedTallowHome;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
		else process.env[key] = ORIGINAL_ENV[key];
	}
	rmSync(isolatedTallowHome, { force: true, recursive: true });
});
describe("routeModel explicit model resolution", () => {
	it("honors explicit provider/model choices without auto-routing", async () => {
		const result = await routeModel(
			"run this task",
			"minimax/MiniMax-M2.1",
			undefined,
			"claude-opus-4-6"
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.reason).toBe("explicit");
		expect(result.model.provider).toBe("minimax");
		expect(result.model.id).toBe("MiniMax-M2.1");
	});

	it("prefers direct-provider models for shorthand queries when keys are present", async () => {
		process.env.ZAI_API_KEY = "test-zai-key";
		const result = await routeModel("run this task", "glm-5", undefined, "claude-opus-4-6");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.reason).toBe("explicit");
		expect(result.model.provider).toBe("zai");
		expect(result.model.id).toBe("glm-5");
	});

	it("uses direct explicit resolution for agent frontmatter model values", async () => {
		process.env.ZAI_API_KEY = "test-zai-key";
		const result = await routeModel("run this task", undefined, "glm-5", "claude-opus-4-6");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.reason).toBe("agent-frontmatter");
		expect(result.model.provider).toBe("zai");
		expect(result.model.id).toBe("glm-5");
	});
});
