/**
 * Auto-selection algorithm for image generation models.
 *
 * When the user doesn't specify a provider or model, the selector
 * picks the best available model based on:
 *
 * 1. Capability requirements (text rendering, ref images, inpainting)
 * 2. API key availability
 * 3. Quality/cost preference sorting
 *
 * @module
 */

import {
	findProviderByModel,
	findProvidersByName,
	getAvailableProviders,
	type ImageProvider,
	isProviderAvailable,
} from "./providers.js";
import { getQualityRating } from "./ratings.js";

/** Cost preference for model selection. */
export type CostPreference = "eco" | "balanced" | "premium";

/** Parameters that affect model selection. */
export interface SelectionCriteria {
	/** Does the image need legible text rendered? */
	readonly needsTextRender?: boolean;
	/** Is a reference image being provided? */
	readonly hasReferenceImage?: boolean;
	/** Is inpainting/editing requested? */
	readonly needsInpainting?: boolean;
	/** Explicit provider name override (e.g., "openai"). */
	readonly providerOverride?: string;
	/** Explicit model ID override (e.g., "gpt-image-1"). */
	readonly modelOverride?: string;
	/** Quality/cost tradeoff. Default: "balanced". */
	readonly costPreference?: CostPreference;
}

/** Result of model selection. */
export interface SelectedModel {
	readonly provider: ImageProvider;
	readonly reason: string;
}

/**
 * Select the best image generation model for the given criteria.
 *
 * Selection flow:
 * 1. If model override → use that exact model (error if unavailable)
 * 2. If provider override → pick best model from that provider
 * 3. Otherwise → filter by capabilities, availability, sort by quality
 *
 * @param criteria - What the image generation needs
 * @returns The selected provider and reason for selection
 * @throws {Error} When no suitable provider is available
 */
export function selectImageModel(criteria: SelectionCriteria): SelectedModel {
	// ── Explicit model override ──────────────────────────────────────────
	if (criteria.modelOverride) {
		const provider = findProviderByModel(criteria.modelOverride);
		if (!provider) {
			throw new Error(
				`Unknown image model: "${criteria.modelOverride}". ` +
					`Run without a model override to auto-select.`
			);
		}
		if (!isProviderAvailable(provider)) {
			throw new Error(
				`Model "${criteria.modelOverride}" requires ${provider.envKey} to be set. ` +
					`Add it to ~/.tallow/.env or your environment.`
			);
		}
		return { provider, reason: `explicit model: ${criteria.modelOverride}` };
	}

	// ── Explicit provider override ───────────────────────────────────────
	if (criteria.providerOverride) {
		const providerModels = findProvidersByName(criteria.providerOverride);
		if (providerModels.length === 0) {
			throw new Error(
				`Unknown provider: "${criteria.providerOverride}". ` +
					`Available: openai, google, xai, bfl, fal.`
			);
		}

		const available = providerModels.filter((p) => isProviderAvailable(p));
		if (available.length === 0) {
			const envKeys = [...new Set(providerModels.map((p) => p.envKey))];
			throw new Error(
				`Provider "${criteria.providerOverride}" requires ${envKeys.join(" or ")} to be set.`
			);
		}

		const sorted = sortByCostPreference(available, criteria.costPreference ?? "balanced");
		return {
			provider: sorted[0],
			reason: `provider override: ${criteria.providerOverride} → ${sorted[0].modelId}`,
		};
	}

	// ── Auto-select ──────────────────────────────────────────────────────
	let candidates = getAvailableProviders();

	if (candidates.length === 0) {
		throw new Error(
			"No image generation providers configured. " +
				"Set at least one API key: OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, " +
				"XAI_API_KEY, BFL_API_KEY, or FAL_KEY."
		);
	}

	// Filter by capability requirements
	candidates = filterByCapabilities(candidates, criteria);

	if (candidates.length === 0) {
		throw new Error(
			"No available provider supports the required capabilities. " +
				"Try a different provider or remove capability constraints."
		);
	}

	const sorted = sortByCostPreference([...candidates], criteria.costPreference ?? "balanced");

	return {
		provider: sorted[0],
		reason: buildAutoSelectReason(sorted[0], criteria),
	};
}

/**
 * Filter providers by required capabilities.
 *
 * @param providers - Candidate providers
 * @param criteria - Capability requirements
 * @returns Providers that meet all requirements
 */
function filterByCapabilities(
	providers: readonly ImageProvider[],
	criteria: SelectionCriteria
): readonly ImageProvider[] {
	return providers.filter((p) => {
		if (criteria.needsTextRender && !p.capabilities.textRender) return false;
		if (criteria.hasReferenceImage && p.capabilities.maxReferenceImages < 1) return false;
		if (criteria.needsInpainting && !p.capabilities.inpainting) return false;
		return true;
	});
}

/**
 * Sort providers by quality/cost preference.
 *
 * - "eco": ascending quality (cheapest viable model first)
 * - "premium": descending quality (best quality first)
 * - "balanced": quality ≥ 3 first, then ascending (good + affordable)
 *
 * @param providers - Providers to sort (mutated in place)
 * @param preference - Cost preference
 * @returns Sorted array (same reference as input)
 */
function sortByCostPreference(
	providers: ImageProvider[],
	preference: CostPreference
): ImageProvider[] {
	return providers.sort((a, b) => {
		const ratingA = getQualityRating(a.modelId);
		const ratingB = getQualityRating(b.modelId);

		switch (preference) {
			case "eco":
				// Cheapest first (lowest quality = presumably cheapest)
				return ratingA - ratingB;

			case "premium":
				// Best quality first
				return ratingB - ratingA;

			case "balanced": {
				// Prefer quality ≥ 3, then sort ascending within tiers
				const aGood = ratingA >= 3 ? 0 : 1;
				const bGood = ratingB >= 3 ? 0 : 1;
				if (aGood !== bGood) return aGood - bGood;
				// Within the same tier preference, prefer higher quality
				// but not the most expensive (prefer 3-4 over 5)
				if (ratingA <= 4 && ratingB > 4) return -1;
				if (ratingA > 4 && ratingB <= 4) return 1;
				return ratingB - ratingA;
			}
		}
		return 0;
	});
}

/**
 * Build a human-readable reason for the auto-selection.
 *
 * @param provider - The selected provider
 * @param criteria - Selection criteria used
 * @returns Reason string
 */
function buildAutoSelectReason(provider: ImageProvider, criteria: SelectionCriteria): string {
	const parts: string[] = [`auto-selected: ${provider.modelId}`];
	const rating = getQualityRating(provider.modelId);
	parts.push(`quality=${rating}/5`);

	if (criteria.needsTextRender) parts.push("text-render");
	if (criteria.hasReferenceImage) parts.push("ref-image");
	if (criteria.needsInpainting) parts.push("inpainting");

	const pref = criteria.costPreference ?? "balanced";
	if (pref !== "balanced") parts.push(`cost=${pref}`);

	return parts.join(", ");
}
