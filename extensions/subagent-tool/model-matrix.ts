/** LLM task types for routing. */
export type TaskType = "code" | "vision" | "text";

/**
 * Per-type capability ratings. Scale: 1 (basic) to 5 (frontier).
 * Missing key = model doesn't support that type.
 */
export type ModelRatings = Partial<Record<TaskType, number>>;

/**
 * Multi-dimensional model capability matrix.
 *
 * Source: Arena leaderboards (arena.ai/leaderboard/*), Feb 2026.
 *
 * ELO → tier mapping per leaderboard (each has different ELO scale):
 *   Code:   5=≥1440  4=1370-1439  3=1280-1369  2=1180-1279  1=<1180
 *   Vision: 5=≥1250  4=1200-1249  3=1150-1199  2=1100-1149  1=<1100
 *   Text:   5=≥1460  4=1410-1459  3=1370-1409  2=1320-1369  1=<1320
 *
 * Ratings use base model scores — no thinking, default effort.
 */
export const MODEL_MATRIX: Record<string, ModelRatings> = {
	// Anthropic
	"claude-opus-4-6": { code: 5, vision: 3, text: 5 },
	"claude-opus-4-5": { code: 5, vision: 3, text: 5 },
	"claude-opus-4-1": { code: 4, vision: 3, text: 4 },
	"claude-sonnet-4-5": { code: 4, vision: 3, text: 4 },
	"claude-haiku-4-5": { code: 3, vision: 2, text: 3 },
	// OpenAI
	"gpt-5.2": { code: 4, vision: 4, text: 4 },
	"gpt-5": { code: 4, vision: 4, text: 4 },
	"gpt-5.1": { code: 3, vision: 4, text: 4 },
	"gpt-5.2-codex": { code: 3, text: 3 },
	"gpt-5.1-codex": { code: 3, text: 3 },
	"gpt-5.1-codex-mini": { code: 2, text: 2 },
	// Google
	"gemini-3-pro": { code: 5, vision: 5, text: 5 },
	"gemini-3-flash": { code: 5, vision: 5, text: 5 },
	"gemini-2.5-pro": { code: 2, vision: 4, text: 4 },
	"gemini-2.5-flash": { vision: 4, text: 4 },
	// Z.ai (Zhipu)
	"glm-5": { code: 5, text: 5 },
	"glm-4.7": { code: 5, text: 4 },
	"glm-4.6": { code: 3, vision: 3, text: 4 },
	// DeepSeek
	"deepseek-reasoner": { code: 4, text: 4 },
	"deepseek-chat": { code: 3, text: 4 },
	// MiniMax
	"minimax-m2.1": { code: 4, text: 3 },
	"minimax-m2": { code: 3, text: 2 },
	// Moonshot (Kimi)
	"kimi-k2.5": { code: 4, text: 4 },
	"kimi-k2": { code: 3, text: 4 },
	// Qwen (Alibaba)
	"qwen3-coder": { code: 3, text: 3 },
	"qwen3-max": { text: 4 },
	// xAI
	"grok-4.1": { code: 2, text: 5 },
	"grok-4": { code: 1, text: 4 },
	// Mistral
	"mistral-large-3": { code: 2, text: 4 },
	"devstral-2": { code: 2 },
	"devstral-medium": { code: 1 },
};

/** Sorted keys longest-first for prefix matching. */
const SORTED_KEYS = Object.keys(MODEL_MATRIX).sort((a, b) => b.length - a.length);

/**
 * Get capability ratings for a model by its ID.
 *
 * Uses longest-prefix matching: strips provider prefix (e.g. "anthropic/"),
 * then finds the longest key in MODEL_MATRIX that the model ID starts with.
 * E.g., "claude-sonnet-4-5-20250929" matches "claude-sonnet-4-5".
 *
 * @param modelId - Full model ID (may include date suffixes)
 * @returns Capability ratings, or undefined if model not in matrix
 */
export function getModelRatings(modelId: string): ModelRatings | undefined {
	const bare = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
	const key = SORTED_KEYS.find((k) => bare.startsWith(k));
	return key ? MODEL_MATRIX[key] : undefined;
}

/**
 * Check if a model supports a given task type at the required complexity level.
 *
 * @param modelId - Full model ID
 * @param type - Required task type
 * @param minRating - Minimum required rating (1-5)
 * @returns true if the model has a rating for the type >= minRating
 */
export function modelSupportsTask(modelId: string, type: TaskType, minRating: number): boolean {
	const ratings = getModelRatings(modelId);
	if (!ratings) return false;
	const rating = ratings[type];
	return rating !== undefined && rating >= minRating;
}
