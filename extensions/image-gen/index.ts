/**
 * Image Generation Extension
 *
 * Registers a `generate_image` tool that generates images using the
 * Vercel AI SDK. Supports multiple providers (OpenAI, Google, xAI,
 * BFL, Fal) with automatic model selection based on capabilities,
 * availability, and quality/cost preferences.
 *
 * Two invocation paths:
 * 1. Dedicated image APIs via `generateImage()` (most providers)
 * 2. Hybrid LLMs via `generateText()` with image output (Gemini)
 *
 * Generated images are saved to `~/.tallow/images/` and paths are
 * returned to the LLM.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import { formatToolVerb, renderLines } from "../tool-display/index.js";
import type { CostPreference } from "./selector.js";
import { selectImageModel } from "./selector.js";

/**
 * Format elapsed milliseconds into a human-readable duration string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "12.3s" or "1m 5s"
 */
function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = Math.round(seconds % 60);
	return `${minutes}m ${remainingSeconds}s`;
}

/** Directory where generated images are saved. */
const IMAGES_DIR = path.join(
	process.env.TALLOW_HOME ?? path.join(process.env.HOME ?? "~", ".tallow"),
	"images"
);

/** Supported aspect ratios. */
const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;

/** Map aspect ratio strings to pixel sizes for providers that need them. */
const ASPECT_TO_SIZE: Record<string, `${number}x${number}`> = {
	"1:1": "1024x1024",
	"16:9": "1536x1024",
	"9:16": "1024x1536",
	"4:3": "1024x768",
	"3:4": "768x1024",
	"3:2": "1536x1024",
	"2:3": "1024x1536",
};

/**
 * Generate a unique filename for a saved image.
 *
 * @param index - Image index (0-based) when generating multiple
 * @param mediaType - MIME type of the image (e.g., "image/png")
 * @returns Unique filename with timestamp
 */
function generateFilename(index: number, mediaType: string): string {
	const ext = mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "png";
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const suffix = index > 0 ? `-${index + 1}` : "";
	return `image-${ts}${suffix}.${ext}`;
}

/**
 * Save image data to disk.
 *
 * @param data - Base64-encoded image data or Uint8Array
 * @param mediaType - MIME type of the image
 * @param index - Image index (0-based)
 * @returns Absolute path to the saved file
 */
function saveImage(data: string | Uint8Array, mediaType: string, index: number): string {
	fs.mkdirSync(IMAGES_DIR, { recursive: true });
	const filename = generateFilename(index, mediaType);
	const filePath = path.join(IMAGES_DIR, filename);
	const buffer = typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data);
	fs.writeFileSync(filePath, buffer);
	return filePath;
}

/**
 * Execute image generation via a dedicated image model (generateImage).
 *
 * @param provider - The provider definition
 * @param prompt - Text prompt
 * @param params - Additional generation parameters
 * @param signal - Abort signal
 * @returns Generated image data
 */
async function generateWithDedicatedModel(
	provider: import("./providers.js").DedicatedImageProvider,
	prompt: string,
	params: {
		readonly aspectRatio?: `${number}:${number}`;
		readonly size?: `${number}x${number}`;
		readonly n?: number;
		readonly seed?: number;
		readonly referenceImage?: string;
	},
	signal?: AbortSignal
): Promise<{
	readonly images: ReadonlyArray<{ readonly base64: string; readonly mediaType: string }>;
	readonly revisedPrompt?: string;
}> {
	const { generateImage } = await import("ai");
	const model = provider.createModel();

	// Build prompt — may include reference image
	let promptInput: Parameters<typeof generateImage>[0]["prompt"];
	if (params.referenceImage && fs.existsSync(params.referenceImage)) {
		const refData = fs.readFileSync(params.referenceImage);
		promptInput = {
			text: prompt,
			images: [refData],
		};
	} else {
		promptInput = prompt;
	}

	const result = await generateImage({
		model,
		prompt: promptInput,
		n: params.n ?? 1,
		...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
		...(params.size ? { size: params.size } : {}),
		...(params.seed !== undefined ? { seed: params.seed } : {}),
		abortSignal: signal,
	});

	// Extract revised prompt from provider metadata if available
	const meta = result.providerMetadata as
		| Record<string, { images?: Array<{ revisedPrompt?: string }> }>
		| undefined;
	const revisedPrompt = meta?.openai?.images?.[0]?.revisedPrompt;

	return {
		images: result.images.map((img) => ({
			base64: img.base64,
			mediaType: img.mediaType ?? "image/png",
		})),
		revisedPrompt,
	};
}

/**
 * Execute image generation via a hybrid LLM (generateText with image output).
 *
 * Used for models like Gemini that generate images inline in text responses.
 * Supports thought signatures for iterative refinement — when a previous
 * signature is provided, it's included in the conversation history so the
 * model can maintain reasoning context.
 *
 * @param provider - The provider definition
 * @param prompt - Text prompt
 * @param options - Optional thought signature and abort signal
 * @returns Generated image data with optional thought signature
 */
async function generateWithHybridModel(
	provider: import("./providers.js").HybridImageProvider,
	prompt: string,
	options?: {
		readonly thoughtSignature?: string;
		readonly signal?: AbortSignal;
	}
): Promise<{
	readonly images: ReadonlyArray<{ readonly base64: string; readonly mediaType: string }>;
	readonly revisedPrompt?: string;
	readonly thoughtSignature?: string;
}> {
	const { generateText } = await import("ai");
	const model = provider.createModel();

	const result = await generateText({
		model: model as Parameters<typeof generateText>[0]["model"],
		prompt,
		providerOptions: {
			google: {
				responseModalities: ["TEXT", "IMAGE"],
				...(options?.thoughtSignature ? { thoughtSignature: options.thoughtSignature } : {}),
			},
		},
		abortSignal: options?.signal,
	});

	const images: Array<{ base64: string; mediaType: string }> = [];

	if (result.files) {
		for (const file of result.files) {
			if (file.mediaType.startsWith("image/")) {
				images.push({
					base64: file.base64,
					mediaType: file.mediaType,
				});
			}
		}
	}

	if (images.length === 0) {
		throw new Error(
			"Hybrid model did not produce any images. " +
				`Model: ${provider.modelId}. Response text: ${result.text?.slice(0, 200) ?? "(empty)"}`
		);
	}

	// Extract thought signature from provider metadata for future iterations
	const meta = result.providerMetadata as Record<string, { thoughtSignature?: string }> | undefined;
	const thoughtSignature = meta?.google?.thoughtSignature;

	return { images, thoughtSignature };
}

/** Details shape for the tool result. */
interface ImageGenDetails {
	readonly provider: string;
	readonly model: string;
	readonly paths: readonly string[];
	readonly selectionReason: string;
	readonly isError?: boolean;
	readonly error?: string;
	readonly revisedPrompt?: string;
	readonly count: number;
	readonly elapsedMs?: number;
	/** Whether this generation was an iteration on a previous image. */
	readonly isIteration?: boolean;
	/** Thought signature returned by the model for future iterations. */
	readonly thoughtSignature?: string;
}

/**
 * Registers the generate_image tool.
 *
 * @param pi - Extension API for registering tools and events
 */
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		label: "generate_image",
		description: `Generate images from text prompts. Auto-selects the best available provider based on capabilities and quality.

Supports: OpenAI (gpt-image-1), Google (Gemini image, Imagen 4), xAI (Grok), BFL (Flux), Fal.

WHEN TO USE:
- User asks to create, generate, or draw an image
- Need to visualize a concept, design, or scene
- Creating diagrams, illustrations, or visual content

WHEN NOT TO USE:
- Analyzing or describing existing images (use vision/read tool)
- Simple text descriptions suffice`,
		parameters: Type.Object({
			prompt: Type.String({ description: "Text description of the image to generate" }),
			aspectRatio: Type.Optional(
				Type.Union(
					ASPECT_RATIOS.map((r) => Type.Literal(r)),
					{ description: 'Aspect ratio. Default: "1:1"' }
				)
			),
			size: Type.Optional(
				Type.String({
					description: "Size in pixels (e.g., '1024x1024'). Alternative to aspectRatio",
				})
			),
			quality: Type.Optional(
				Type.Union(
					[Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("auto")],
					{ description: 'Quality vs cost tradeoff. Default: "auto"' }
				)
			),
			n: Type.Optional(
				Type.Number({
					description: "Number of images to generate. Default: 1",
					minimum: 1,
					maximum: 4,
				})
			),
			provider: Type.Optional(
				Type.String({
					description: 'Explicit provider override (e.g., "openai", "google", "bfl", "xai", "fal")',
				})
			),
			model: Type.Optional(
				Type.String({
					description:
						'Explicit model override (e.g., "gpt-image-1", "imagen-4.0", "flux-kontext-max")',
				})
			),
			referenceImage: Type.Optional(
				Type.String({
					description: "Path to a reference image for editing or style guidance",
				})
			),
			seed: Type.Optional(
				Type.Number({ description: "Seed for reproducibility (if supported by model)" })
			),
			thoughtSignature: Type.Optional(
				Type.String({
					description:
						"Thought signature from a previous generation. Pass this back to maintain " +
						"reasoning context for iterative refinement (Gemini models only).",
				})
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const startedAt = Date.now();
			try {
				// ── Map quality to cost preference ────────────────────────
				const costMap: Record<string, CostPreference> = {
					low: "eco",
					medium: "balanced",
					high: "premium",
					auto: "balanced",
				};
				const costPreference = costMap[params.quality ?? "auto"] ?? "balanced";

				// ── Select model ─────────────────────────────────────────
				const { provider, reason } = selectImageModel({
					modelOverride: params.model,
					providerOverride: params.provider,
					hasReferenceImage: !!params.referenceImage,
					costPreference,
				});

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Generating with ${provider.modelId} (${provider.providerName})...`,
						},
					],
					details: {
						provider: provider.providerName,
						model: provider.modelId,
						paths: [],
						selectionReason: reason,
						count: 0,
					} satisfies ImageGenDetails,
				});

				// ── Resolve size ─────────────────────────────────────────
				const aspectRatio = (params.aspectRatio ?? "1:1") as `${number}:${number}`;
				const size = (params.size ?? ASPECT_TO_SIZE[aspectRatio]) as
					| `${number}x${number}`
					| undefined;

				// ── Detect iteration ──────────────────────────────────────
				const isIteration = !!params.thoughtSignature;

				// ── Generate ─────────────────────────────────────────────
				let result: {
					readonly images: ReadonlyArray<{
						readonly base64: string;
						readonly mediaType: string;
					}>;
					readonly revisedPrompt?: string;
					readonly thoughtSignature?: string;
				};

				if (provider.kind === "hybrid") {
					result = await generateWithHybridModel(provider, params.prompt, {
						thoughtSignature: params.thoughtSignature,
						signal: signal ?? undefined,
					});
				} else {
					result = await generateWithDedicatedModel(
						provider,
						params.prompt,
						{
							aspectRatio,
							size,
							n: params.n,
							seed: params.seed,
							referenceImage: params.referenceImage,
						},
						signal ?? undefined
					);
				}

				// ── Save images to disk ──────────────────────────────────
				const savedPaths: string[] = [];
				for (let i = 0; i < result.images.length; i++) {
					const img = result.images[i];
					const filePath = saveImage(img.base64, img.mediaType, i);
					savedPaths.push(filePath);
				}

				// ── Build result ─────────────────────────────────────────
				const details: ImageGenDetails = {
					provider: provider.providerName,
					model: provider.modelId,
					paths: savedPaths,
					selectionReason: reason,
					count: savedPaths.length,
					revisedPrompt: result.revisedPrompt,
					elapsedMs: Date.now() - startedAt,
					isIteration,
					thoughtSignature: result.thoughtSignature,
				};

				const action = isIteration ? "Iterated" : "Generated";
				const textParts: string[] = [
					`${action} ${savedPaths.length} image${savedPaths.length > 1 ? "s" : ""} ` +
						`with ${provider.modelId}:`,
					...savedPaths.map((p) => `  ${p}`),
				];

				if (result.revisedPrompt) {
					textParts.push("", `Revised prompt: ${result.revisedPrompt}`);
				}

				if (result.thoughtSignature) {
					textParts.push(
						"",
						`Thought signature (pass back for iterative refinement): ${result.thoughtSignature}`
					);
				}

				return {
					content: [{ type: "text", text: textParts.join("\n") }],
					details,
				};
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Image generation failed: ${msg}` }],
					details: {
						provider: "unknown",
						model: "unknown",
						paths: [],
						selectionReason: "error",
						isError: true,
						error: msg,
						count: 0,
					} satisfies ImageGenDetails,
				};
			}
		},

		renderCall(args, theme) {
			const isIteration = !!args.thoughtSignature;
			const verb = isIteration
				? "generate_image: Iterating…"
				: formatToolVerb("generate_image", false);
			const model = args.model ? ` → ${args.model}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`${verb} `)) +
					theme.fg("accent", args.prompt) +
					theme.fg("dim", model),
				0,
				0
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ImageGenDetails | undefined;

			if (!details) {
				const text = result.content[0];
				return renderLines([text?.type === "text" ? text.text : "(no output)"]);
			}

			// Progress indicator while generating
			if (isPartial) {
				const model = details.model || "model";
				const provider = details.provider || "";
				const via = provider ? ` (${provider})` : "";
				const reason = details.selectionReason
					? theme.fg("dim", ` · ${details.selectionReason}`)
					: "";
				return renderLines([
					theme.fg("muted", `${getIcon("in_progress")} ${model}${via}`) + reason,
				]);
			}

			if (details.isError) {
				const footer = theme.fg(
					"error",
					`${getIcon("error")} ${details.error ?? "Generation failed"}`
				);
				return renderLines([footer]);
			}

			// Completion summary
			const icon = getIcon("success");
			const action = details.isIteration ? "Iterated" : formatToolVerb("generate_image", true);
			const count = `${details.count} image${details.count > 1 ? "s" : ""}`;
			const elapsed = details.elapsedMs ? ` in ${formatElapsed(details.elapsedMs)}` : "";
			const footer =
				theme.fg("success", `${icon} `) +
				theme.fg("dim", `${action} ${count} via `) +
				theme.fg("accent", details.model) +
				theme.fg("muted", ` (${details.provider})`) +
				theme.fg("dim", elapsed);

			if (expanded) {
				const lines: string[] = [];
				// Selection reason
				if (details.selectionReason) {
					lines.push(theme.fg("dim", `  ${details.selectionReason}`));
				}
				// File paths
				for (const p of details.paths) {
					lines.push(theme.fg("dim", `  ${p}`));
				}
				if (details.revisedPrompt) {
					lines.push(theme.fg("muted", `  Revised: ${details.revisedPrompt.slice(0, 80)}…`));
				}
				if (details.thoughtSignature) {
					lines.push(theme.fg("dim", `  Thought signature available for iteration`));
				}
				lines.push(footer);
				return renderLines(lines);
			}

			return renderLines([footer]);
		},
	});
}
