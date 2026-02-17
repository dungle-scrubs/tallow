/**
 * Provider registry for image generation.
 *
 * Maps canonical model IDs to Vercel AI SDK model instances.
 * Handles two invocation paths:
 *
 * 1. **Dedicated image APIs** — `generateImage()` from Vercel AI SDK
 *    (OpenAI, Google Imagen, xAI, BFL, Fal)
 *
 * 2. **Hybrid LLMs** — `generateText()` with image output
 *    (Gemini 3 Pro Image, Gemini 2.5 Flash Image)
 *
 * API keys are resolved from environment variables at call time,
 * matching Vercel AI SDK conventions.
 *
 * @module
 */

import type { ImageModel, LanguageModel } from "ai";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Capabilities that a model may support. */
export interface ModelCapabilities {
	/** Can render legible text within the image. */
	readonly textRender: boolean;
	/**
	 * Max reference images accepted per request.
	 * 0 = no reference image support.
	 */
	readonly maxReferenceImages: number;
	/** Can perform masked inpainting/editing. */
	readonly inpainting: boolean;
	/**
	 * Returns thought signatures for iterative refinement across calls.
	 * Gemini models return an encrypted reasoning context that, when passed
	 * back, preserves consistency for iterative edits.
	 */
	readonly thoughtSignature: boolean;
}

/** A dedicated image generation model (uses generateImage). */
export interface DedicatedImageProvider {
	readonly kind: "dedicated";
	readonly modelId: string;
	readonly providerName: string;
	readonly capabilities: ModelCapabilities;
	/** Env var that must be set for this provider to be available. */
	readonly envKey: string;
	/** Factory that lazily creates the Vercel AI SDK image model. */
	readonly createModel: () => ImageModel;
}

/** A hybrid LLM that generates images via generateText. */
export interface HybridImageProvider {
	readonly kind: "hybrid";
	readonly modelId: string;
	readonly providerName: string;
	readonly capabilities: ModelCapabilities;
	/** Env var that must be set for this provider to be available. */
	readonly envKey: string;
	/** Factory that lazily creates the Vercel AI SDK language model. */
	readonly createModel: () => LanguageModel;
}

/** Union of provider types. */
export type ImageProvider = DedicatedImageProvider | HybridImageProvider;

// ─── Provider Definitions ────────────────────────────────────────────────────

/**
 * All known image generation providers.
 *
 * Models are lazily imported to avoid loading provider SDKs
 * until they're actually needed (and their API key is present).
 */
export const PROVIDERS: readonly ImageProvider[] = [
	// ── OpenAI ────────────────────────────────────────────────────────────
	{
		kind: "dedicated",
		modelId: "gpt-image-1",
		providerName: "openai",
		envKey: "OPENAI_API_KEY",
		capabilities: {
			textRender: true,
			maxReferenceImages: 8,
			inpainting: true,
			thoughtSignature: false,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { openai } = require("@ai-sdk/openai") as typeof import("@ai-sdk/openai");
			return openai.image("gpt-image-1");
		},
	},

	// ── Google — Hybrid LLMs ──────────────────────────────────────────────
	{
		kind: "hybrid",
		modelId: "gemini-2.5-flash-image",
		providerName: "google",
		envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
		capabilities: {
			textRender: true,
			maxReferenceImages: 14,
			inpainting: false,
			thoughtSignature: true,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { google } = require("@ai-sdk/google") as typeof import("@ai-sdk/google");
			return google("gemini-2.5-flash-preview-image-generation") as unknown as LanguageModel;
		},
	},

	// ── Google — Dedicated Imagen ─────────────────────────────────────────
	{
		kind: "dedicated",
		modelId: "imagen-4.0",
		providerName: "google",
		envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
		capabilities: {
			textRender: true,
			maxReferenceImages: 0,
			inpainting: false,
			thoughtSignature: false,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { google } = require("@ai-sdk/google") as typeof import("@ai-sdk/google");
			return google.image("imagen-4.0-generate-001");
		},
	},
	{
		kind: "dedicated",
		modelId: "imagen-ultra-4.0",
		providerName: "google",
		envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
		capabilities: {
			textRender: true,
			maxReferenceImages: 0,
			inpainting: false,
			thoughtSignature: false,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { google } = require("@ai-sdk/google") as typeof import("@ai-sdk/google");
			return google.image("imagen-4.0-ultra-generate-001");
		},
	},

	// ── xAI ───────────────────────────────────────────────────────────────
	{
		kind: "dedicated",
		modelId: "grok-imagine",
		providerName: "xai",
		envKey: "XAI_API_KEY",
		capabilities: {
			textRender: false,
			maxReferenceImages: 0,
			inpainting: false,
			thoughtSignature: false,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { xai } = require("@ai-sdk/xai") as typeof import("@ai-sdk/xai");
			return xai.image("grok-2-image");
		},
	},

	// ── Black Forest Labs ─────────────────────────────────────────────────
	{
		kind: "dedicated",
		modelId: "flux-kontext-max",
		providerName: "bfl",
		envKey: "BFL_API_KEY",
		capabilities: {
			textRender: false,
			maxReferenceImages: 4,
			inpainting: true,
			thoughtSignature: false,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { blackForestLabs } =
				require("@ai-sdk/black-forest-labs") as typeof import("@ai-sdk/black-forest-labs");
			return blackForestLabs.image("flux-kontext-max");
		},
	},
	{
		kind: "dedicated",
		modelId: "flux-kontext-pro",
		providerName: "bfl",
		envKey: "BFL_API_KEY",
		capabilities: {
			textRender: false,
			maxReferenceImages: 4,
			inpainting: true,
			thoughtSignature: false,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { blackForestLabs } =
				require("@ai-sdk/black-forest-labs") as typeof import("@ai-sdk/black-forest-labs");
			return blackForestLabs.image("flux-kontext-pro");
		},
	},
	{
		kind: "dedicated",
		modelId: "flux-pro-1.1-ultra",
		providerName: "bfl",
		envKey: "BFL_API_KEY",
		capabilities: {
			textRender: false,
			maxReferenceImages: 0,
			inpainting: false,
			thoughtSignature: false,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { blackForestLabs } =
				require("@ai-sdk/black-forest-labs") as typeof import("@ai-sdk/black-forest-labs");
			return blackForestLabs.image("flux-pro-1.1-ultra");
		},
	},

	// ── Fal ───────────────────────────────────────────────────────────────
	{
		kind: "dedicated",
		modelId: "fal-flux-dev",
		providerName: "fal",
		envKey: "FAL_KEY",
		capabilities: {
			textRender: false,
			maxReferenceImages: 0,
			inpainting: false,
			thoughtSignature: false,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { fal } = require("@ai-sdk/fal") as typeof import("@ai-sdk/fal");
			return fal.image("fal-ai/flux/dev");
		},
	},
	{
		kind: "dedicated",
		modelId: "fal-flux-schnell",
		providerName: "fal",
		envKey: "FAL_KEY",
		capabilities: {
			textRender: false,
			maxReferenceImages: 0,
			inpainting: false,
			thoughtSignature: false,
		},
		createModel() {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { fal } = require("@ai-sdk/fal") as typeof import("@ai-sdk/fal");
			return fal.image("fal-ai/flux/schnell");
		},
	},
];

// ─── Lookup Helpers ──────────────────────────────────────────────────────────

/**
 * Find a provider by its canonical model ID.
 *
 * @param modelId - The model ID to look up (e.g., "gpt-image-1")
 * @returns The provider definition, or undefined if not found
 */
export function findProviderByModel(modelId: string): ImageProvider | undefined {
	return PROVIDERS.find((p) => p.modelId === modelId);
}

/**
 * Find all providers for a given provider name.
 *
 * @param providerName - The provider name (e.g., "openai", "google")
 * @returns Array of matching providers
 */
export function findProvidersByName(providerName: string): readonly ImageProvider[] {
	return PROVIDERS.filter((p) => p.providerName === providerName.toLowerCase());
}

/**
 * Get all providers whose API key is currently configured.
 *
 * @returns Array of available providers
 */
export function getAvailableProviders(): readonly ImageProvider[] {
	return PROVIDERS.filter((p) => !!process.env[p.envKey]);
}

/**
 * Check if a specific provider's API key is configured.
 *
 * @param provider - The provider to check
 * @returns True if the required env var is set
 */
export function isProviderAvailable(provider: ImageProvider): boolean {
	return !!process.env[provider.envKey];
}
