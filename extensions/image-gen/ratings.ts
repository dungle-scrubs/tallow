/**
 * Image model quality ratings from Arena text-to-image leaderboard.
 *
 * ELO → tier mapping:
 *   5 = ≥1220 (top tier)
 *   4 = 1140–1219
 *   3 = 1060–1139
 *   2 = 980–1059
 *   1 = <980
 *
 * Source: arena.ai/leaderboard/text-to-image (Feb 2026)
 *
 * @module
 */

/** Quality tier from 1 (lowest) to 5 (highest). */
export type QualityTier = 1 | 2 | 3 | 4 | 5;

/**
 * Arena ELO-derived quality ratings for image generation models.
 * Keys are our canonical model IDs, values are quality tiers.
 */
export const IMAGE_GEN_RATINGS: Readonly<Record<string, QualityTier>> = {
	// OpenAI
	"gpt-image-1.5": 5, // #1  ELO 1248
	"gpt-image-1": 3, // #20 ELO 1115
	"gpt-image-1-mini": 3, // #22 ELO 1100

	// Google — hybrid LLM (generate via generateText)
	"gemini-3-pro-image": 5, // #2-3 ELO 1233-1237
	"gemini-2.5-flash-image": 4, // #8   ELO 1157

	// Google — dedicated image API
	"imagen-ultra-4.0": 4, // #12 ELO 1149
	"imagen-4.0": 3, // #16 ELO 1135

	// xAI
	"grok-imagine": 4, // #4  ELO 1174

	// BFL (Black Forest Labs)
	"flux-kontext-max": 4, // est. ~1160 (Kontext series)
	"flux-kontext-pro": 4, // est. ~1150
	"flux-pro-1.1-ultra": 4, // #5  ELO 1169
	"flux-pro-1.1": 4, // #9  ELO 1156

	// Fal (various models)
	"fal-flux-dev": 3, // Flux dev via Fal
	"fal-flux-schnell": 2, // Fast/cheap Flux
};

/**
 * Look up the quality rating for a model.
 *
 * @param modelId - Canonical model ID
 * @returns Quality tier, or 2 (below average) for unknown models
 */
export function getQualityRating(modelId: string): QualityTier {
	return (IMAGE_GEN_RATINGS[modelId] as QualityTier | undefined) ?? 2;
}
