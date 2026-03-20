import { describe, expect, it } from "bun:test";
import { type Api, getModels, type Model } from "@mariozechner/pi-ai";
import { applyKnownModelMetadataOverrides } from "../model-metadata-overrides.js";

/**
 * Builds a mutable model registry stub for override testing.
 *
 * @param models - Models to expose through `getAll()`
 * @returns Registry-like object backed by the provided array
 */
function createRegistry(models: Model<Api>[]): { getAll(): Model<Api>[] } {
	return { getAll: () => models };
}

/**
 * Clones a built-in model so tests can mutate it without affecting shared fixtures.
 *
 * @param provider - Provider name containing the built-in model
 * @param id - Model identifier to clone
 * @returns Mutable clone of the requested model
 * @throws {Error} When the built-in model does not exist
 */
function cloneBuiltInModel(provider: string, id: string): Model<Api> {
	const model = getModels(provider).find((entry) => entry.id === id);
	if (!model) {
		throw new Error(`Missing built-in model ${provider}/${id}`);
	}
	return structuredClone(model);
}

describe("applyKnownModelMetadataOverrides", () => {
	it("patches stale OpenAI GPT-5.4 context metadata", () => {
		const openai = cloneBuiltInModel("openai", "gpt-5.4");
		const codex = cloneBuiltInModel("openai-codex", "gpt-5.4");
		const copilot = cloneBuiltInModel("github-copilot", "gpt-5.4");
		const registry = createRegistry([openai, codex, copilot]);

		const applied = applyKnownModelMetadataOverrides(registry);

		expect(applied).toBe(2);
		expect(openai.contextWindow).toBe(1_000_000);
		expect(codex.contextWindow).toBe(1_000_000);
		expect(copilot.contextWindow).toBe(400_000);
	});

	it("does not clobber explicit user overrides", () => {
		const codex = cloneBuiltInModel("openai-codex", "gpt-5.4");
		codex.contextWindow = 1_000_000;
		const registry = createRegistry([codex]);

		const applied = applyKnownModelMetadataOverrides(registry);

		expect(applied).toBe(0);
		expect(codex.contextWindow).toBe(1_000_000);
	});
});
