/**
 * Autocomplete engine — model resolution, debouncing, and completion lifecycle.
 *
 * Extracted from the extension entry point for testability. All state is
 * encapsulated in the AutocompleteEngine class, making it easy to construct
 * with mock dependencies.
 */

import type { Api, Model } from "@mariozechner/pi-ai";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Minimal model registry interface for autocomplete resolution. */
export interface ModelRegistryLike {
	/** Find a model by provider and ID. */
	find(provider: string, modelId: string): Model<Api> | undefined;
	/** Get API key for a model. */
	getApiKey(model: Model<Api>): Promise<string | undefined>;
	/** Get all models that have auth configured. */
	getAvailable(): Model<Api>[];
	/** Register a provider dynamically. */
	registerProvider(name: string, config: Record<string, unknown>): void;
}

/** Recent conversation context for autocomplete relevance. */
export interface ConversationContext {
	/** Formatted recent exchanges (user + assistant text, no tool calls). */
	recentExchanges: string;
}

/** Function that calls the LLM and returns completion text. */
export type CompletionFn = (
	model: Model<Api>,
	apiKey: string,
	partialInput: string,
	signal: AbortSignal,
	context: ConversationContext | null
) => Promise<string | null>;

/** Callback to set ghost text on the editor. */
export type SetGhostTextFn = (text: string | null) => void;

/** Callback to get current editor text. */
export type GetTextFn = () => string;

/** Callback to get recent conversation context for autocomplete. */
export type GetConversationContextFn = () => ConversationContext | null;

/** Configuration for the autocomplete engine. */
export interface AutocompleteConfig {
	/** Whether autocomplete is enabled. */
	enabled: boolean;
	/** Debounce interval in ms before calling the model. */
	debounceMs: number;
	/** Max API calls per session. */
	maxCalls: number;
	/** Provider/model string (e.g. "groq/llama-3.1-8b-instant"). */
	modelSetting: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Preferred fallback models for autocomplete, cheapest first. */
export const AUTOCOMPLETE_FALLBACKS = [
	"groq/llama-3.1-8b-instant",
	"anthropic/claude-haiku-4-5",
	"anthropic/claude-3-5-haiku-latest",
	"openai/gpt-4o-mini",
];

/** Minimum characters before autocomplete triggers. */
export const MIN_CHARS = 4;

// ─── Model resolution ────────────────────────────────────────────────────────

/**
 * Try to resolve a specific provider/model string from the registry.
 *
 * @param registry - Model registry to search
 * @param modelStr - "provider/model" string
 * @returns Resolved model and API key, or null
 */
export async function tryResolveModel(
	registry: ModelRegistryLike,
	modelStr: string
): Promise<{ model: Model<Api>; apiKey: string } | null> {
	const slashIdx = modelStr.indexOf("/");
	if (slashIdx === -1) return null;

	const provider = modelStr.slice(0, slashIdx);
	const modelId = modelStr.slice(slashIdx + 1);

	const model = registry.find(provider, modelId);
	if (!model) return null;

	const apiKey = await registry.getApiKey(model);
	if (!apiKey) return null;

	return { model, apiKey };
}

/**
 * Resolve the best autocomplete model via fallback chain.
 *
 * 1. Configured model
 * 2. Preferred cheap fallbacks
 * 3. Cheapest available model in registry
 *
 * @param registry - Model registry to search
 * @param modelSetting - Preferred model string
 * @returns Resolved model and API key, or null if nothing available
 */
export async function resolveAutocompleteModel(
	registry: ModelRegistryLike,
	modelSetting: string
): Promise<{ model: Model<Api>; apiKey: string } | null> {
	const result = await tryResolveModel(registry, modelSetting);
	if (result) return result;

	for (const fallback of AUTOCOMPLETE_FALLBACKS) {
		if (fallback === modelSetting) continue;
		const fbResult = await tryResolveModel(registry, fallback);
		if (fbResult) return fbResult;
	}

	const available = registry.getAvailable();
	const sorted = [...available].sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0));
	for (const model of sorted) {
		const apiKey = await registry.getApiKey(model);
		if (apiKey) return { model, apiKey };
	}

	return null;
}

// ─── Autocomplete engine ─────────────────────────────────────────────────────

/**
 * Manages debounced autocomplete requests with cancellation and cost caps.
 *
 * Testable in isolation — no framework dependencies, only callbacks.
 */
export class AutocompleteEngine {
	private config: AutocompleteConfig;
	private completionFn: CompletionFn;
	private setGhostText: SetGhostTextFn;
	private getText: GetTextFn;
	private getConversationContext: GetConversationContextFn;
	private registry: ModelRegistryLike;

	private timer: ReturnType<typeof setTimeout> | null = null;
	private abortController: AbortController | null = null;
	private resolvedModel: { model: Model<Api>; apiKey: string } | null | undefined;
	private _callCount = 0;
	private _busy = false;

	/**
	 * @param config - Autocomplete configuration
	 * @param registry - Model registry for resolution
	 * @param completionFn - Function that calls the LLM
	 * @param setGhostText - Callback to display ghost text
	 * @param getText - Callback to read current editor text
	 * @param getConversationContext - Callback to get recent conversation for relevance
	 */
	constructor(
		config: AutocompleteConfig,
		registry: ModelRegistryLike,
		completionFn: CompletionFn,
		setGhostText: SetGhostTextFn,
		getText: GetTextFn,
		getConversationContext: GetConversationContextFn = () => null
	) {
		this.config = config;
		this.registry = registry;
		this.completionFn = completionFn;
		this.setGhostText = setGhostText;
		this.getText = getText;
		this.getConversationContext = getConversationContext;
	}

	/** Number of API calls made this session. */
	get callCount(): number {
		return this._callCount;
	}

	/** Whether the agent is busy (suppresses autocomplete). */
	get busy(): boolean {
		return this._busy;
	}

	set busy(value: boolean) {
		this._busy = value;
		if (value) this.cancel();
	}

	/**
	 * Determine whether a partial input should trigger autocomplete.
	 *
	 * @param input - Current editor text
	 * @returns true if autocomplete should be scheduled
	 */
	shouldTrigger(input: string): boolean {
		if (!this.config.enabled) return false;
		if (this._busy) return false;
		if (this._callCount >= this.config.maxCalls) return false;
		if (input.startsWith("/")) return false;
		if (input.trim().length < MIN_CHARS) return false;
		return true;
	}

	/**
	 * Schedule a debounced autocomplete request.
	 * Cancels any pending/in-flight request first.
	 *
	 * @param partialInput - Current editor text
	 */
	trigger(partialInput: string): void {
		this.cancel();
		if (!this.shouldTrigger(partialInput)) return;

		this.timer = setTimeout(async () => {
			try {
				if (this.resolvedModel === undefined) {
					this.resolvedModel =
						(await resolveAutocompleteModel(this.registry, this.config.modelSetting)) ?? null;
				}
				if (!this.resolvedModel) return;

				this.abortController = new AbortController();
				this._callCount++;

				const conversationContext = this.getConversationContext();

				const completion = await this.completionFn(
					this.resolvedModel.model,
					this.resolvedModel.apiKey,
					partialInput,
					this.abortController.signal,
					conversationContext
				);

				this.abortController = null;

				if (this.getText() === partialInput && completion) {
					this.setGhostText(completion);
				}
			} catch {
				// Silently swallow errors (network, abort, model failure)
				this.abortController = null;
			}
		}, this.config.debounceMs);
	}

	/** Cancel any pending timer or in-flight request. */
	cancel(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	/** Clean up all resources. */
	dispose(): void {
		this.cancel();
	}
}
