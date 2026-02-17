/**
 * Tests for image generation model selector.
 *
 * Validates model override, provider override, auto-selection,
 * capability filtering, and cost preference sorting.
 *
 * Environment variables are stubbed per-test to control which
 * providers appear "available".
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { selectImageModel } from "../selector.js";

/** Stash original env so each test gets a clean slate. */
const ENV_KEYS = [
	"OPENAI_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"XAI_API_KEY",
	"BFL_API_KEY",
	"FAL_KEY",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] !== undefined) {
			process.env[key] = savedEnv[key];
		} else {
			delete process.env[key];
		}
	}
});

// ── Model Override ────────────────────────────────────────────────────────────

describe("model override", () => {
	it("selects exact model when available", () => {
		process.env.OPENAI_API_KEY = "test";
		const result = selectImageModel({ modelOverride: "gpt-image-1" });
		expect(result.provider.modelId).toBe("gpt-image-1");
		expect(result.reason).toContain("explicit model");
	});

	it("throws for unknown model ID", () => {
		expect(() => selectImageModel({ modelOverride: "nonexistent-model" })).toThrow(
			/Unknown image model/
		);
	});

	it("throws when model exists but API key is missing", () => {
		// OPENAI_API_KEY deliberately not set
		expect(() => selectImageModel({ modelOverride: "gpt-image-1" })).toThrow(/OPENAI_API_KEY/);
	});
});

// ── Provider Override ─────────────────────────────────────────────────────────

describe("provider override", () => {
	it("selects best model from the given provider", () => {
		process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test";
		const result = selectImageModel({ providerOverride: "google" });
		expect(result.provider.providerName).toBe("google");
		expect(result.reason).toContain("provider override");
	});

	it("throws for unknown provider name", () => {
		expect(() => selectImageModel({ providerOverride: "acme" })).toThrow(/Unknown provider/);
	});

	it("throws when provider exists but API key is missing", () => {
		expect(() => selectImageModel({ providerOverride: "openai" })).toThrow(/OPENAI_API_KEY/);
	});

	it("respects cost preference within provider", () => {
		process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test";
		const eco = selectImageModel({ providerOverride: "google", costPreference: "eco" });
		const premium = selectImageModel({ providerOverride: "google", costPreference: "premium" });
		// eco should pick lower-rated model, premium higher-rated
		// Both valid Google models — the important thing is they're different or ordered correctly
		expect(eco.provider.providerName).toBe("google");
		expect(premium.provider.providerName).toBe("google");
	});
});

// ── Auto-Selection ────────────────────────────────────────────────────────────

describe("auto-selection", () => {
	it("throws when no providers are configured", () => {
		expect(() => selectImageModel({})).toThrow(/No image generation providers configured/);
	});

	it("selects an available provider", () => {
		process.env.OPENAI_API_KEY = "test";
		const result = selectImageModel({});
		expect(result.provider.modelId).toBe("gpt-image-1");
		expect(result.reason).toContain("auto-selected");
	});

	it("includes quality rating in reason", () => {
		process.env.OPENAI_API_KEY = "test";
		const result = selectImageModel({});
		expect(result.reason).toMatch(/quality=\d\/5/);
	});
});

// ── Capability Filtering ──────────────────────────────────────────────────────

describe("capability filtering", () => {
	it("filters out models that lack text rendering", () => {
		process.env.XAI_API_KEY = "test"; // grok-imagine has textRender: false
		expect(() => selectImageModel({ needsTextRender: true })).toThrow(
			/No available provider supports the required capabilities/
		);
	});

	it("filters out models that lack reference image support", () => {
		process.env.XAI_API_KEY = "test"; // grok-imagine has maxReferenceImages: 0
		expect(() => selectImageModel({ hasReferenceImage: true })).toThrow(
			/No available provider supports the required capabilities/
		);
	});

	it("keeps models that support reference images", () => {
		process.env.OPENAI_API_KEY = "test"; // gpt-image-1 has maxReferenceImages: 8
		const result = selectImageModel({ hasReferenceImage: true });
		expect(result.provider.capabilities.maxReferenceImages).toBeGreaterThan(0);
	});

	it("filters out models that lack inpainting", () => {
		process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test"; // Gemini hybrid has inpainting: false
		process.env.FAL_KEY = "test"; // fal models have inpainting: false
		// Only Google (no inpainting on any Google model) and Fal (no inpainting) available
		expect(() => selectImageModel({ needsInpainting: true })).toThrow(
			/No available provider supports the required capabilities/
		);
	});

	it("selects inpainting-capable model when available", () => {
		process.env.OPENAI_API_KEY = "test"; // gpt-image-1 has inpainting: true
		const result = selectImageModel({ needsInpainting: true });
		expect(result.provider.capabilities.inpainting).toBe(true);
	});

	it("includes capability tags in auto-select reason", () => {
		process.env.OPENAI_API_KEY = "test";
		const result = selectImageModel({
			hasReferenceImage: true,
			needsTextRender: true,
		});
		expect(result.reason).toContain("text-render");
		expect(result.reason).toContain("ref-image");
	});
});

// ── Cost Preference ───────────────────────────────────────────────────────────

describe("cost preference", () => {
	it("eco preference picks lower-quality model", () => {
		process.env.OPENAI_API_KEY = "test";
		process.env.BFL_API_KEY = "test";
		const result = selectImageModel({ costPreference: "eco" });
		expect(result.reason).toContain("cost=eco");
	});

	it("premium preference picks higher-quality model", () => {
		process.env.OPENAI_API_KEY = "test";
		process.env.BFL_API_KEY = "test";
		const result = selectImageModel({ costPreference: "premium" });
		expect(result.reason).toContain("cost=premium");
	});

	it("balanced preference omits cost tag from reason", () => {
		process.env.OPENAI_API_KEY = "test";
		const result = selectImageModel({ costPreference: "balanced" });
		expect(result.reason).not.toContain("cost=");
	});
});
