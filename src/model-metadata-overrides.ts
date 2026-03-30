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
		const providerOverrides = KNOWN_CONTEXT_WINDOW_OVERRIDES[model.provider];
		if (!providerOverrides) continue;

		const correction = providerOverrides[model.id];
		if (!correction) continue;
		if (model.contextWindow !== correction.stale) continue;

		model.contextWindow = correction.correct;
		applied += 1;
	}

	return applied;
}
