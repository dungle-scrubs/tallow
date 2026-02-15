import { describe, expect, it } from "bun:test";
import { getModelRatings, MODEL_MATRIX, modelSupportsTask } from "../model-matrix.js";

describe("getModelRatings", () => {
	it("returns exact match for known model", () => {
		const ratings = getModelRatings("claude-sonnet-4-5");
		expect(ratings).toEqual({ code: 4, vision: 3, text: 4 });
	});

	it("matches model IDs with date suffixes via prefix matching", () => {
		const ratings = getModelRatings("claude-sonnet-4-5-20250929");
		expect(ratings).toEqual({ code: 4, vision: 3, text: 4 });
	});

	it("strips provider prefix before matching", () => {
		const ratings = getModelRatings("anthropic/claude-opus-4-6");
		expect(ratings).toEqual({ code: 5, vision: 3, text: 5 });
	});

	it("returns undefined for unknown model", () => {
		expect(getModelRatings("unknown-model-xyz")).toBeUndefined();
	});

	it("matches longest prefix (claude-haiku-4-5 not claude-haiku-4)", () => {
		// "claude-haiku-4-5-20250514" should match "claude-haiku-4-5", not something shorter
		const ratings = getModelRatings("claude-haiku-4-5-20250514");
		expect(ratings).toEqual({ code: 3, vision: 2, text: 3 });
	});

	it("handles models with only partial type coverage", () => {
		const ratings = getModelRatings("devstral-2");
		expect(ratings).toEqual({ code: 2 });
		expect(ratings?.vision).toBeUndefined();
		expect(ratings?.text).toBeUndefined();
	});

	it("handles models without code rating", () => {
		const ratings = getModelRatings("gemini-2.5-flash");
		expect(ratings).toEqual({ vision: 4, text: 4 });
		expect(ratings?.code).toBeUndefined();
	});
});

describe("modelSupportsTask", () => {
	it("returns true when rating meets minimum", () => {
		expect(modelSupportsTask("claude-opus-4-6", "code", 5)).toBe(true);
		expect(modelSupportsTask("claude-opus-4-6", "code", 3)).toBe(true);
	});

	it("returns false when rating is below minimum", () => {
		expect(modelSupportsTask("claude-haiku-4-5", "code", 4)).toBe(false);
	});

	it("returns false when type is not supported", () => {
		expect(modelSupportsTask("devstral-2", "vision", 1)).toBe(false);
		expect(modelSupportsTask("qwen3-max", "code", 1)).toBe(false);
	});

	it("returns false for unknown model", () => {
		expect(modelSupportsTask("unknown-model", "code", 1)).toBe(false);
	});

	it("cross-modality: vision task excludes text-only models", () => {
		expect(modelSupportsTask("glm-5", "vision", 1)).toBe(false);
		expect(modelSupportsTask("gemini-3-pro", "vision", 5)).toBe(true);
	});
});

describe("MODEL_MATRIX completeness", () => {
	it("has entries for all major providers", () => {
		const keys = Object.keys(MODEL_MATRIX);
		expect(keys.some((k) => k.startsWith("claude-"))).toBe(true);
		expect(keys.some((k) => k.startsWith("gpt-"))).toBe(true);
		expect(keys.some((k) => k.startsWith("gemini-"))).toBe(true);
		expect(keys.some((k) => k.startsWith("grok-"))).toBe(true);
	});

	it("all ratings are between 1 and 5", () => {
		for (const [_modelId, ratings] of Object.entries(MODEL_MATRIX)) {
			for (const [_type, rating] of Object.entries(ratings)) {
				expect(rating).toBeGreaterThanOrEqual(1);
				expect(rating).toBeLessThanOrEqual(5);
			}
		}
	});
});
