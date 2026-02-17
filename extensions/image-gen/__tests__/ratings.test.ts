/**
 * Tests for image model quality ratings.
 *
 * @module
 */
import { describe, expect, it } from "bun:test";
import { PROVIDERS } from "../providers.js";
import { getQualityRating, IMAGE_GEN_RATINGS } from "../ratings.js";

describe("getQualityRating", () => {
	it("returns known rating for gpt-image-1", () => {
		expect(getQualityRating("gpt-image-1")).toBe(3);
	});

	it("returns known rating for top-tier model", () => {
		expect(getQualityRating("gpt-image-1.5")).toBe(5);
	});

	it("returns known rating for gemini hybrid", () => {
		expect(getQualityRating("gemini-2.5-flash-image")).toBe(4);
	});

	it("returns 2 for unknown models", () => {
		expect(getQualityRating("totally-unknown-model")).toBe(2);
	});

	it("returns 2 for empty string", () => {
		expect(getQualityRating("")).toBe(2);
	});
});

describe("IMAGE_GEN_RATINGS registry", () => {
	it("all tiers are between 1 and 5", () => {
		for (const [modelId, tier] of Object.entries(IMAGE_GEN_RATINGS)) {
			expect(tier).toBeGreaterThanOrEqual(1);
			expect(tier).toBeLessThanOrEqual(5);
			// Also verify it's an integer
			expect(Number.isInteger(tier)).toBe(true);
		}
	});

	it("every provider model ID has a rating entry", () => {
		const missing: string[] = [];
		for (const provider of PROVIDERS) {
			if (!(provider.modelId in IMAGE_GEN_RATINGS)) {
				missing.push(provider.modelId);
			}
		}
		expect(missing).toEqual([]);
	});

	it("orphan ratings are only for known planned models", () => {
		const providerIds = new Set(PROVIDERS.map((p) => p.modelId));
		const orphans: string[] = [];
		for (const modelId of Object.keys(IMAGE_GEN_RATINGS)) {
			if (!providerIds.has(modelId)) {
				orphans.push(modelId);
			}
		}
		// These models have Arena ratings but aren't in the provider registry yet
		// (unreleased or not yet integrated). Update this list when adding providers.
		const knownOrphans = [
			"gpt-image-1.5",
			"gpt-image-1-mini",
			"gemini-3-pro-image",
			"flux-pro-1.1",
		];
		expect(orphans.sort()).toEqual(knownOrphans.sort());
	});
});
