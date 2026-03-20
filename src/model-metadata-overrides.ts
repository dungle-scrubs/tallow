import type { Api, Model } from "@mariozechner/pi-ai";

const KNOWN_CONTEXT_WINDOW_OVERRIDES = {
	openai: {
		"gpt-5.4": 1_000_000,
	},
	"openai-codex": {
		"gpt-5.4": 1_000_000,
	},
} as const;

const STALE_CONTEXT_WINDOW = 272_000;

interface ModelRegistryLike {
	getAll(): Model<Api>[];
}

/**
 * Correct known stale upstream model metadata without clobbering explicit user overrides.
 *
 * The upstream pi-ai registry currently ships `gpt-5.4` with a 272k context
 * window for the OpenAI and OpenAI Codex providers, while current OpenAI docs
 * advertise a 1M context window. User `models.json` overrides should continue
 * to win, so this patch only rewrites entries that still carry the known stale
 * 272k value.
 *
 * @param modelRegistry - Registry containing built-in and user-overridden models
 * @returns Number of models patched in place
 */
export function applyKnownModelMetadataOverrides(modelRegistry: ModelRegistryLike): number {
	let applied = 0;

	for (const model of modelRegistry.getAll()) {
		const providerOverrides =
			KNOWN_CONTEXT_WINDOW_OVERRIDES[model.provider as keyof typeof KNOWN_CONTEXT_WINDOW_OVERRIDES];
		if (!providerOverrides) continue;

		const contextWindow = providerOverrides[model.id as keyof typeof providerOverrides];
		if (!contextWindow) continue;
		if (model.contextWindow !== STALE_CONTEXT_WINDOW) continue;

		model.contextWindow = contextWindow;
		applied += 1;
	}

	return applied;
}
