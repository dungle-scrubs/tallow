import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
mockScope.module("@mariozechner/pi-ai", () => ({
	getProviders: () => ["anthropic", "opencode", "openrouter", "minimax", "zai"],
	getModels: (provider: string) => mockModels.filter((model) => model.provider === provider),
}));

mockScope.module("../task-classifier.js", () => ({
	classifyTask: async () => ({ complexity: 3, reasoning: "mock classification", type: "code" }),
	findCheapestModel: () => undefined,
}));

let routeModel!: typeof import("../model-router.js").routeModel;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENCODE_API_KEY", "ZAI_API_KEY"] as const;

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
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
		else process.env[key] = ORIGINAL_ENV[key];
	}
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
