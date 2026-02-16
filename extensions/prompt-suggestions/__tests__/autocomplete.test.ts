/**
 * Tests for autocomplete engine — model resolution, debouncing, cancellation,
 * cost caps, and the full trigger lifecycle.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	AUTOCOMPLETE_FALLBACKS,
	type AutocompleteConfig,
	AutocompleteEngine,
	type CompletionFn,
	type ConversationContext,
	MIN_CHARS,
	type ModelRegistryLike,
	resolveAutocompleteModel,
	tryResolveModel,
} from "../autocomplete.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Create a minimal mock model. */
function mockModel(provider: string, id: string, inputCost = 1): Model<Api> {
	return {
		provider,
		id,
		name: `${provider}/${id}`,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: inputCost, output: inputCost, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
	} as Model<Api>;
}

/** Create a mock registry with configurable models and keys. */
function createMockRegistry(
	models: Model<Api>[] = [],
	keys: Map<string, string> = new Map()
): ModelRegistryLike {
	return {
		find(provider: string, modelId: string) {
			return models.find((m) => m.provider === provider && m.id === modelId);
		},
		async getApiKey(model: Model<Api>) {
			return keys.get(`${model.provider}/${model.id}`);
		},
		getAvailable() {
			return models.filter((m) => keys.has(`${m.provider}/${m.id}`));
		},
		registerProvider() {},
	};
}

/** Default engine config for tests. */
function defaultConfig(overrides: Partial<AutocompleteConfig> = {}): AutocompleteConfig {
	return {
		enabled: true,
		debounceMs: 10, // fast for tests
		maxCalls: 200,
		modelSetting: "test/model",
		...overrides,
	};
}

/** Create an engine with mocks wired up. */
function createTestEngine(opts: {
	config?: Partial<AutocompleteConfig>;
	registry?: ModelRegistryLike;
	completionFn?: CompletionFn;
	currentText?: string;
	conversationContext?: ConversationContext | null;
}) {
	const ghostTexts: (string | null)[] = [];
	let currentText = opts.currentText ?? "";

	const model = mockModel("test", "model");
	const registry =
		opts.registry ?? createMockRegistry([model], new Map([["test/model", "test-key"]]));

	const completionFn = opts.completionFn ?? (async () => "completion result");

	const engine = new AutocompleteEngine(
		defaultConfig(opts.config),
		registry,
		completionFn,
		(text) => ghostTexts.push(text),
		() => currentText,
		() => opts.conversationContext ?? null
	);

	return {
		engine,
		ghostTexts,
		setCurrentText(text: string) {
			currentText = text;
		},
	};
}

/** Wait for debounce + async model resolution to complete. */
function waitForDebounce(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── tryResolveModel ─────────────────────────────────────────────────────────

describe("tryResolveModel", () => {
	test("resolves a valid provider/model with key", async () => {
		const model = mockModel("groq", "llama-3.1-8b-instant");
		const registry = createMockRegistry(
			[model],
			new Map([["groq/llama-3.1-8b-instant", "gsk_abc"]])
		);
		const result = await tryResolveModel(registry, "groq/llama-3.1-8b-instant");
		expect(result).not.toBeNull();
		expect(result?.model.id).toBe("llama-3.1-8b-instant");
		expect(result?.apiKey).toBe("gsk_abc");
	});

	test("returns null for missing model", async () => {
		const registry = createMockRegistry([], new Map());
		const result = await tryResolveModel(registry, "groq/llama-3.1-8b-instant");
		expect(result).toBeNull();
	});

	test("returns null for model without API key", async () => {
		const model = mockModel("groq", "llama-3.1-8b-instant");
		const registry = createMockRegistry([model], new Map());
		const result = await tryResolveModel(registry, "groq/llama-3.1-8b-instant");
		expect(result).toBeNull();
	});

	test("returns null for string without slash", async () => {
		const registry = createMockRegistry([], new Map());
		const result = await tryResolveModel(registry, "no-slash");
		expect(result).toBeNull();
	});
});

// ─── resolveAutocompleteModel ────────────────────────────────────────────────

describe("resolveAutocompleteModel", () => {
	test("uses configured model when available", async () => {
		const model = mockModel("custom", "fast-model");
		const registry = createMockRegistry([model], new Map([["custom/fast-model", "key-123"]]));
		const result = await resolveAutocompleteModel(registry, "custom/fast-model");
		expect(result).not.toBeNull();
		expect(result?.model.id).toBe("fast-model");
	});

	test("falls back through AUTOCOMPLETE_FALLBACKS", async () => {
		const haiku = mockModel("anthropic", "claude-haiku-4-5");
		const registry = createMockRegistry(
			[haiku],
			new Map([["anthropic/claude-haiku-4-5", "sk-ant"]])
		);
		// Configured model doesn't exist; should find haiku in fallbacks
		const result = await resolveAutocompleteModel(registry, "groq/nonexistent");
		expect(result).not.toBeNull();
		expect(result?.model.id).toBe("claude-haiku-4-5");
	});

	test("falls back to cheapest available model", async () => {
		const expensive = mockModel("provider", "expensive", 10);
		const cheap = mockModel("provider", "cheap", 0.01);
		const registry = createMockRegistry(
			[expensive, cheap],
			new Map([
				["provider/expensive", "key-e"],
				["provider/cheap", "key-c"],
			])
		);
		const result = await resolveAutocompleteModel(registry, "missing/model");
		expect(result).not.toBeNull();
		expect(result?.model.id).toBe("cheap");
	});

	test("returns null when no models available", async () => {
		const registry = createMockRegistry([], new Map());
		const result = await resolveAutocompleteModel(registry, "groq/llama-3.1-8b-instant");
		expect(result).toBeNull();
	});

	test("skips configured model in fallback list to avoid duplicate attempts", async () => {
		const findCalls: string[] = [];
		const registry: ModelRegistryLike = {
			find(provider, modelId) {
				findCalls.push(`${provider}/${modelId}`);
				return undefined;
			},
			async getApiKey() {
				return undefined;
			},
			getAvailable() {
				return [];
			},
			registerProvider() {},
		};
		await resolveAutocompleteModel(registry, AUTOCOMPLETE_FALLBACKS[0]!);
		// The configured model is also the first fallback — should only be tried once
		const firstFallback = AUTOCOMPLETE_FALLBACKS[0]!;
		const attempts = findCalls.filter((c) => c === firstFallback);
		expect(attempts.length).toBe(1);
	});
});

// ─── AutocompleteEngine.shouldTrigger ────────────────────────────────────────

describe("AutocompleteEngine.shouldTrigger", () => {
	test("returns true for valid input", () => {
		const { engine } = createTestEngine({});
		expect(engine.shouldTrigger("refactor the auth module")).toBe(true);
	});

	test("rejects input shorter than MIN_CHARS", () => {
		const { engine } = createTestEngine({});
		expect(engine.shouldTrigger("ab")).toBe(false);
		expect(engine.shouldTrigger("   ")).toBe(false);
		expect(engine.shouldTrigger("a".repeat(MIN_CHARS))).toBe(true);
	});

	test("rejects slash commands", () => {
		const { engine } = createTestEngine({});
		expect(engine.shouldTrigger("/help")).toBe(false);
	});

	test("rejects when disabled", () => {
		const { engine } = createTestEngine({ config: { enabled: false } });
		expect(engine.shouldTrigger("valid input here")).toBe(false);
	});

	test("rejects when busy", () => {
		const { engine } = createTestEngine({});
		engine.busy = true;
		expect(engine.shouldTrigger("valid input here")).toBe(false);
	});

	test("rejects when call limit reached", () => {
		const { engine } = createTestEngine({ config: { maxCalls: 0 } });
		expect(engine.shouldTrigger("valid input here")).toBe(false);
	});
});

// ─── AutocompleteEngine lifecycle ────────────────────────────────────────────

describe("AutocompleteEngine lifecycle", () => {
	let engine: AutocompleteEngine;

	afterEach(() => {
		engine?.dispose();
	});

	test("trigger calls completion after debounce and sets ghost text", async () => {
		const calls: string[] = [];
		const result = createTestEngine({
			config: { debounceMs: 10 },
			completionFn: async (_m, _k, input) => {
				calls.push(input);
				return "suggested completion";
			},
			currentText: "refactor",
		});
		engine = result.engine;
		result.setCurrentText("refactor");

		engine.trigger("refactor");
		expect(calls.length).toBe(0); // not called yet
		await waitForDebounce();
		expect(calls).toEqual(["refactor"]);
		expect(result.ghostTexts).toEqual(["suggested completion"]);
		expect(engine.callCount).toBe(1);
	});

	test("cancel prevents debounced call from firing", async () => {
		const calls: string[] = [];
		const result = createTestEngine({
			config: { debounceMs: 50 },
			completionFn: async (_m, _k, input) => {
				calls.push(input);
				return "completion";
			},
		});
		engine = result.engine;

		engine.trigger("test input");
		engine.cancel();
		await waitForDebounce(100);
		expect(calls.length).toBe(0);
	});

	test("rapid triggers only fire the last one", async () => {
		const calls: string[] = [];
		const result = createTestEngine({
			config: { debounceMs: 10 },
			completionFn: async (_m, _k, input) => {
				calls.push(input);
				return `complete: ${input}`;
			},
		});
		engine = result.engine;
		result.setCurrentText("final");

		engine.trigger("first");
		engine.trigger("second");
		engine.trigger("final");
		await waitForDebounce();
		// Only the last one should fire
		expect(calls).toEqual(["final"]);
		expect(engine.callCount).toBe(1);
	});

	test("does not set ghost text if editor text changed since trigger", async () => {
		const result = createTestEngine({
			config: { debounceMs: 10 },
			completionFn: async () => {
				// Simulate user typing more while completion is in-flight
				result.setCurrentText("changed");
				return "stale completion";
			},
			currentText: "original",
		});
		engine = result.engine;

		engine.trigger("original");
		await waitForDebounce();
		// Ghost text should NOT be set because editor text changed
		expect(result.ghostTexts.length).toBe(0);
	});

	test("setting busy cancels pending autocomplete", async () => {
		const calls: string[] = [];
		const result = createTestEngine({
			config: { debounceMs: 50 },
			completionFn: async (_m, _k, input) => {
				calls.push(input);
				return "completion";
			},
		});
		engine = result.engine;

		engine.trigger("test input");
		engine.busy = true; // agent starts processing
		await waitForDebounce(100);
		expect(calls.length).toBe(0);
	});

	test("respects call count limit", async () => {
		const calls: string[] = [];
		const result = createTestEngine({
			config: { debounceMs: 5, maxCalls: 2 },
			completionFn: async (_m, _k, input) => {
				calls.push(input);
				return "done";
			},
		});
		engine = result.engine;
		result.setCurrentText("call1");

		engine.trigger("call1");
		await waitForDebounce();
		result.setCurrentText("call2");
		engine.trigger("call2");
		await waitForDebounce();
		result.setCurrentText("call3");
		engine.trigger("call3");
		await waitForDebounce();

		expect(calls.length).toBe(2);
		expect(engine.callCount).toBe(2);
	});

	test("null completion does not set ghost text", async () => {
		const result = createTestEngine({
			config: { debounceMs: 5 },
			completionFn: async () => null,
			currentText: "test input",
		});
		engine = result.engine;

		engine.trigger("test input");
		await waitForDebounce();
		expect(result.ghostTexts.length).toBe(0);
	});

	test("model resolution failure degrades gracefully", async () => {
		const result = createTestEngine({
			config: { debounceMs: 5 },
			registry: createMockRegistry([], new Map()), // no models
			currentText: "test input",
		});
		engine = result.engine;

		engine.trigger("test input");
		await waitForDebounce();
		// No crash, no ghost text
		expect(result.ghostTexts.length).toBe(0);
		// Call count NOT incremented (model resolution failed before API call)
		expect(engine.callCount).toBe(0);
	});

	test("completion error is swallowed gracefully", async () => {
		const result = createTestEngine({
			config: { debounceMs: 5 },
			completionFn: async () => {
				throw new Error("network error");
			},
			currentText: "test input",
		});
		engine = result.engine;

		// Should not throw
		engine.trigger("test input");
		await waitForDebounce();
		expect(result.ghostTexts.length).toBe(0);
	});

	test("abort signal is passed to completion function", async () => {
		let receivedSignal: AbortSignal | null = null;
		const result = createTestEngine({
			config: { debounceMs: 5 },
			completionFn: async (_m, _k, _input, signal) => {
				receivedSignal = signal;
				return "done";
			},
			currentText: "test input",
		});
		engine = result.engine;

		engine.trigger("test input");
		await waitForDebounce();
		expect(receivedSignal).not.toBeNull();
		expect(receivedSignal?.aborted).toBe(false);
	});

	test("dispose cleans up timers", async () => {
		const calls: string[] = [];
		const result = createTestEngine({
			config: { debounceMs: 50 },
			completionFn: async (_m, _k, input) => {
				calls.push(input);
				return "done";
			},
		});
		engine = result.engine;

		engine.trigger("test input");
		engine.dispose();
		await waitForDebounce(100);
		expect(calls.length).toBe(0);
	});
});

// ─── Conversation context passthrough ────────────────────────────────────────

describe("AutocompleteEngine conversation context", () => {
	let engine: AutocompleteEngine;

	afterEach(() => {
		engine?.dispose();
	});

	test("passes conversation context to completion function", async () => {
		let receivedContext: ConversationContext | null = null;
		const context: ConversationContext = {
			recentExchanges: "User: fix the auth bug\n\nAssistant: I found the issue in auth.ts",
		};

		const result = createTestEngine({
			config: { debounceMs: 5 },
			completionFn: async (_m, _k, _input, _signal, ctx) => {
				receivedContext = ctx;
				return "done";
			},
			currentText: "now also",
			conversationContext: context,
		});
		engine = result.engine;

		engine.trigger("now also");
		await waitForDebounce();
		expect(receivedContext).not.toBeNull();
		expect(receivedContext?.recentExchanges).toContain("fix the auth bug");
		expect(receivedContext?.recentExchanges).toContain("auth.ts");
	});

	test("passes null context when no conversation history", async () => {
		let receivedContext: ConversationContext | null | undefined = undefined;

		const result = createTestEngine({
			config: { debounceMs: 5 },
			completionFn: async (_m, _k, _input, _signal, ctx) => {
				receivedContext = ctx;
				return "done";
			},
			currentText: "hello",
			conversationContext: null,
		});
		engine = result.engine;

		engine.trigger("hello");
		await waitForDebounce();
		expect(receivedContext).toBeNull();
	});
});
