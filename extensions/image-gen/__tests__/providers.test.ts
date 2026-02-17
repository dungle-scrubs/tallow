/**
 * Tests for image generation provider registry.
 *
 * Validates lookup helpers and capability declarations.
 * Does NOT instantiate actual SDK models (env-dependent, network-bound).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	findProviderByModel,
	findProvidersByName,
	getAvailableProviders,
	isProviderAvailable,
	PROVIDERS,
} from "../providers.js";

const ENV_KEYS = [
	"OPENAI_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"XAI_API_KEY",
	"BFL_API_KEY",
	"FAL_KEY",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] !== undefined) {
			process.env[key] = savedEnv[key];
		} else {
			delete process.env[key];
		}
	}
});

// ── Registry Integrity ────────────────────────────────────────────────────────

describe("provider registry", () => {
	it("has unique model IDs", () => {
		const ids = PROVIDERS.map((p) => p.modelId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every provider has a non-empty envKey", () => {
		for (const p of PROVIDERS) {
			expect(p.envKey).toBeTruthy();
		}
	});

	it("every provider has a valid kind", () => {
		for (const p of PROVIDERS) {
			expect(["dedicated", "hybrid"]).toContain(p.kind);
		}
	});

	it("maxReferenceImages is a non-negative integer for all providers", () => {
		for (const p of PROVIDERS) {
			expect(p.capabilities.maxReferenceImages).toBeGreaterThanOrEqual(0);
			expect(Number.isInteger(p.capabilities.maxReferenceImages)).toBe(true);
		}
	});

	it("thoughtSignature is only true for hybrid providers", () => {
		for (const p of PROVIDERS) {
			if (p.capabilities.thoughtSignature) {
				expect(p.kind).toBe("hybrid");
			}
		}
	});
});

// ── Lookup Helpers ────────────────────────────────────────────────────────────

describe("findProviderByModel", () => {
	it("finds known model", () => {
		const p = findProviderByModel("gpt-image-1");
		expect(p).toBeDefined();
		expect(p!.providerName).toBe("openai");
	});

	it("returns undefined for unknown model", () => {
		expect(findProviderByModel("nonexistent")).toBeUndefined();
	});
});

describe("findProvidersByName", () => {
	it("finds all models for a provider", () => {
		const google = findProvidersByName("google");
		expect(google.length).toBeGreaterThanOrEqual(2);
		for (const p of google) {
			expect(p.providerName).toBe("google");
		}
	});

	it("is case-insensitive", () => {
		expect(findProvidersByName("OpenAI")).toEqual(findProvidersByName("openai"));
	});

	it("returns empty for unknown provider", () => {
		expect(findProvidersByName("acme")).toHaveLength(0);
	});
});

describe("getAvailableProviders", () => {
	it("returns empty when no env vars are set", () => {
		expect(getAvailableProviders()).toHaveLength(0);
	});

	it("returns only providers whose env var is set", () => {
		process.env.FAL_KEY = "test";
		const available = getAvailableProviders();
		expect(available.length).toBeGreaterThan(0);
		for (const p of available) {
			expect(p.providerName).toBe("fal");
		}
	});

	it("returns multiple providers when multiple keys are set", () => {
		process.env.OPENAI_API_KEY = "test";
		process.env.FAL_KEY = "test";
		const available = getAvailableProviders();
		const providers = new Set(available.map((p) => p.providerName));
		expect(providers.has("openai")).toBe(true);
		expect(providers.has("fal")).toBe(true);
	});
});

describe("isProviderAvailable", () => {
	it("returns false when env var is not set", () => {
		const p = findProviderByModel("gpt-image-1")!;
		expect(isProviderAvailable(p)).toBe(false);
	});

	it("returns true when env var is set", () => {
		process.env.OPENAI_API_KEY = "test";
		const p = findProviderByModel("gpt-image-1")!;
		expect(isProviderAvailable(p)).toBe(true);
	});
});

// ── Specific Capability Values ────────────────────────────────────────────────

describe("capability values", () => {
	it("gemini hybrid supports thought signatures", () => {
		const p = findProviderByModel("gemini-2.5-flash-image")!;
		expect(p.capabilities.thoughtSignature).toBe(true);
		expect(p.kind).toBe("hybrid");
	});

	it("openai does not support thought signatures", () => {
		const p = findProviderByModel("gpt-image-1")!;
		expect(p.capabilities.thoughtSignature).toBe(false);
	});

	it("gemini hybrid accepts up to 14 reference images", () => {
		const p = findProviderByModel("gemini-2.5-flash-image")!;
		expect(p.capabilities.maxReferenceImages).toBe(14);
	});

	it("openai accepts up to 8 reference images", () => {
		const p = findProviderByModel("gpt-image-1")!;
		expect(p.capabilities.maxReferenceImages).toBe(8);
	});

	it("imagen has no reference image support", () => {
		const p = findProviderByModel("imagen-4.0")!;
		expect(p.capabilities.maxReferenceImages).toBe(0);
	});
});
