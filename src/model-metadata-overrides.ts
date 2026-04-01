import type { Api, Model } from "@mariozechner/pi-ai";

/** { stale: the wrong value in the registry, correct: the real value } */
interface ContextWindowCorrection {
	readonly stale: number;
	readonly correct: number;
}

/**
 * Per-provider, per-model corrections for known stale context window values in
 * the upstream pi-ai registry. Each entry is only applied when the registry
 * still carries the known wrong `stale` value, so explicit user `models.json`
 * overrides always win.
 */
const KNOWN_CONTEXT_WINDOW_OVERRIDES: Record<string, Record<string, ContextWindowCorrection>> = {
	// gpt-5.4 was shipped with a 272k window; the real documented limit is 1M.
	openai: {
		"gpt-5.4": { stale: 272_000, correct: 1_000_000 },
	},
	"openai-codex": {
		"gpt-5.4": { stale: 272_000, correct: 1_000_000 },
	},
	// claude-sonnet-4-6 is registered at 1M for the anthropic and opencode
	// providers, but the actual limit for standard/Max accounts is 200k.
	anthropic: {
		"claude-sonnet-4-6": { stale: 1_000_000, correct: 200_000 },
	},
	opencode: {
		"claude-sonnet-4-6": { stale: 1_000_000, correct: 200_000 },
	},
};

/**
 * MiniMax models don't properly support the reasoning parameter in
 * completion/summarization calls through OpenRouter. When reasoningEffort
 * is not explicitly provided, pi-ai's OpenRouter handler sends
 * `reasoning: { effort: "none" }`, which MiniMax rejects with:
 * "Reasoning is mandatory for this endpoint and cannot be disabled."
 *
 * Setting `reasoning: false` prevents the OpenRouter handler from sending
 * the reasoning parameter at all, avoiding this error during compaction.
 */
const KNOWN_REASONING_OVERRIDES: Record<string, Record<string, boolean>> = {
	openrouter: {
		// MiniMax models via OpenRouter — reasoning breaks compact/summarization
		"minimax/minimax-m2.7": false,
		"minimax/minimax-m2.7-highspeed": false,
	},
	"amazon-bedrock": {
		// MiniMax models via Bedrock — same reasoning parameter issue
		"minimax.minimax-m2": false,
		"minimax.minimax-m2.1": false,
	},
};

interface ModelRegistryLike {
	getAll(): Model<Api>[];
}

/**
 * Correct known stale upstream model metadata without clobbering explicit user overrides.
 *
 * Each correction is only applied when the registry still carries the known
 * wrong `stale` value. User `models.json` overrides continue to win.
 *
 * @param modelRegistry - Registry containing built-in and user-overridden models
 * @returns Number of models patched in place
 */
export function applyKnownModelMetadataOverrides(modelRegistry: ModelRegistryLike): number {
	let applied = 0;

	for (const model of modelRegistry.getAll()) {
		// Context window corrections
		const providerOverrides = KNOWN_CONTEXT_WINDOW_OVERRIDES[model.provider];
		if (providerOverrides) {
			const correction = providerOverrides[model.id];
			if (correction && model.contextWindow === correction.stale) {
				model.contextWindow = correction.correct;
				applied += 1;
			}
		}

		// Reasoning corrections for MiniMax
		const reasoningOverrides = KNOWN_REASONING_OVERRIDES[model.provider];
		if (reasoningOverrides) {
			const override = reasoningOverrides[model.id];
			if (override !== undefined && model.reasoning !== override) {
				model.reasoning = override;
				applied += 1;
			}
		}
	}

	return applied;
}
