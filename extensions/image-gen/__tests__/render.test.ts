/**
 * Tests for image generation renderCall and renderResult.
 *
 * Uses a passthrough theme mock that returns text without ANSI codes,
 * so we can assert on visible content.
 */
import { describe, expect, it } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import imageGenExtension from "../index.js";

// ── Theme Mock ────────────────────────────────────────────────────────────────

/**
 * Passthrough theme: fg/bg/bold/etc all return the input text unchanged.
 * Lets us test render output as plain strings.
 */
const mockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
} as unknown as Theme;

// ── Extract tool definition ───────────────────────────────────────────────────

/** Capture the registered tool definition. */
let toolDef: {
	renderCall: (args: Record<string, unknown>, theme: Theme) => unknown;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown },
		opts: { expanded: boolean; isPartial: boolean },
		theme: Theme
	) => { render(width: number): string[] };
};

const mockPi = {
	registerTool(def: Record<string, unknown>) {
		toolDef = def as typeof toolDef;
	},
};
imageGenExtension(mockPi as never);

/**
 * Render a result component to plain text lines.
 * Mock theme is passthrough so no ANSI stripping needed.
 *
 * @param component - The render component from renderResult
 * @returns Joined lines as plain text
 */
function renderToText(component: { render(width: number): string[] }): string {
	return component.render(120).join("\n");
}

// ── renderCall ────────────────────────────────────────────────────────────────

/**
 * Render a call component to plain text.
 * Text component with paddingX=0, paddingY=0 renders content directly.
 *
 * @param component - The Text component from renderCall
 * @returns Rendered text content
 */
function renderCallToText(component: unknown): string {
	const c = component as { render(w: number): string[] };
	// Wide width to avoid wrapping artifacts
	return c.render(300).join("\n").trim();
}

describe("renderCall", () => {
	it("shows generate_image label with prompt text", () => {
		const text = renderCallToText(
			toolDef.renderCall({ prompt: "a sunset over mountains" }, mockTheme)
		);
		expect(text).toContain("generate_image:");
		expect(text).toContain("Generating");
		expect(text).toContain("a sunset over mountains");
	});

	it("shows Iterating verb when thoughtSignature is present", () => {
		const text = renderCallToText(
			toolDef.renderCall({ prompt: "refine the colors", thoughtSignature: "abc123" }, mockTheme)
		);
		expect(text).toContain("Iterating");
		expect(text).toContain("refine the colors");
		// Should NOT show the normal "Generating" verb
		expect(text).not.toContain("Generating");
	});

	it("shows model override as suffix", () => {
		const text = renderCallToText(
			toolDef.renderCall({ prompt: "a cat", model: "gpt-image-1" }, mockTheme)
		);
		expect(text).toContain("gpt-image-1");
		expect(text).toContain("a cat");
	});

	it("does not show model suffix when no override", () => {
		const text = renderCallToText(toolDef.renderCall({ prompt: "a dog" }, mockTheme));
		expect(text).not.toContain("→");
	});

	it("does not pre-truncate long prompt text", () => {
		const longPrompt = "A very detailed prompt about painting ".repeat(5);
		const text = renderCallToText(toolDef.renderCall({ prompt: longPrompt }, mockTheme));
		// Full prompt should be present — no "..." truncation
		expect(text).toContain("painting");
		expect(text).not.toContain("...");
	});
});

// ── renderResult — partial (progress) ─────────────────────────────────────────

describe("renderResult partial", () => {
	it("shows progress indicator with model name", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generating..." }],
			details: {
				provider: "openai",
				model: "gpt-image-1",
				paths: [],
				selectionReason: "auto-selected: gpt-image-1, quality=3/5",
				count: 0,
			},
		};
		const component = toolDef.renderResult(result, { expanded: false, isPartial: true }, mockTheme);
		const text = renderToText(component);
		expect(text).toContain("gpt-image-1");
		expect(text).toContain("openai");
	});

	it("shows selection reason during progress", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generating..." }],
			details: {
				provider: "google",
				model: "gemini-2.5-flash-image",
				paths: [],
				selectionReason: "auto-selected: gemini-2.5-flash-image, quality=4/5",
				count: 0,
			},
		};
		const component = toolDef.renderResult(result, { expanded: false, isPartial: true }, mockTheme);
		const text = renderToText(component);
		expect(text).toContain("auto-selected");
		expect(text).toContain("quality=4/5");
	});
});

// ── renderResult — completed ──────────────────────────────────────────────────

describe("renderResult completed", () => {
	const baseDetails = {
		provider: "openai",
		model: "gpt-image-1",
		paths: ["/home/user/.tallow/images/image-2026-01-01.png"],
		selectionReason: "auto-selected: gpt-image-1, quality=3/5",
		count: 1,
		elapsedMs: 12340,
	};

	it("shows Generated verb and count", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 1 image" }],
			details: baseDetails,
		};
		const component = toolDef.renderResult(
			result,
			{ expanded: false, isPartial: false },
			mockTheme
		);
		const text = renderToText(component);
		expect(text).toContain("Generated");
		expect(text).toContain("1 image");
	});

	it("shows elapsed time", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 1 image" }],
			details: baseDetails,
		};
		const component = toolDef.renderResult(
			result,
			{ expanded: false, isPartial: false },
			mockTheme
		);
		const text = renderToText(component);
		expect(text).toContain("12.3s");
	});

	it("shows model and provider", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 1 image" }],
			details: baseDetails,
		};
		const component = toolDef.renderResult(
			result,
			{ expanded: false, isPartial: false },
			mockTheme
		);
		const text = renderToText(component);
		expect(text).toContain("gpt-image-1");
		expect(text).toContain("openai");
	});

	it("shows Iterated for iteration results", () => {
		const result = {
			content: [{ type: "text" as const, text: "Iterated 1 image" }],
			details: { ...baseDetails, isIteration: true },
		};
		const component = toolDef.renderResult(
			result,
			{ expanded: false, isPartial: false },
			mockTheme
		);
		const text = renderToText(component);
		expect(text).toContain("Iterated");
		expect(text).not.toContain("Generated");
	});

	it("pluralizes image count", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 3 images" }],
			details: {
				...baseDetails,
				count: 3,
				paths: ["/a.png", "/b.png", "/c.png"],
			},
		};
		const component = toolDef.renderResult(
			result,
			{ expanded: false, isPartial: false },
			mockTheme
		);
		const text = renderToText(component);
		expect(text).toContain("3 images");
	});
});

// ── renderResult — expanded ───────────────────────────────────────────────────

describe("renderResult expanded", () => {
	it("shows selection reason when expanded", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 1 image" }],
			details: {
				provider: "openai",
				model: "gpt-image-1",
				paths: ["/home/user/.tallow/images/image.png"],
				selectionReason: "auto-selected: gpt-image-1, quality=3/5",
				count: 1,
				elapsedMs: 5000,
			},
		};
		const component = toolDef.renderResult(result, { expanded: true, isPartial: false }, mockTheme);
		const text = renderToText(component);
		expect(text).toContain("auto-selected");
		expect(text).toContain("quality=3/5");
	});

	it("shows file paths when expanded", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 1 image" }],
			details: {
				provider: "openai",
				model: "gpt-image-1",
				paths: ["/home/user/.tallow/images/image-2026-01-01.png"],
				selectionReason: "explicit model: gpt-image-1",
				count: 1,
				elapsedMs: 5000,
			},
		};
		const component = toolDef.renderResult(result, { expanded: true, isPartial: false }, mockTheme);
		const text = renderToText(component);
		expect(text).toContain("image-2026-01-01.png");
	});

	it("shows thought signature availability when expanded", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 1 image" }],
			details: {
				provider: "google",
				model: "gemini-2.5-flash-image",
				paths: ["/home/user/.tallow/images/image.png"],
				selectionReason: "auto-selected",
				count: 1,
				elapsedMs: 8000,
				thoughtSignature: "encrypted-signature-data",
			},
		};
		const component = toolDef.renderResult(result, { expanded: true, isPartial: false }, mockTheme);
		const text = renderToText(component);
		expect(text).toContain("Thought signature available for iteration");
	});

	it("does not show thought signature line when absent", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 1 image" }],
			details: {
				provider: "openai",
				model: "gpt-image-1",
				paths: ["/home/user/.tallow/images/image.png"],
				selectionReason: "auto-selected",
				count: 1,
				elapsedMs: 5000,
			},
		};
		const component = toolDef.renderResult(result, { expanded: true, isPartial: false }, mockTheme);
		const text = renderToText(component);
		expect(text).not.toContain("Thought signature");
	});

	it("shows revised prompt when expanded", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 1 image" }],
			details: {
				provider: "openai",
				model: "gpt-image-1",
				paths: ["/home/user/.tallow/images/image.png"],
				selectionReason: "auto-selected",
				count: 1,
				elapsedMs: 5000,
				revisedPrompt: "A detailed sunset with warm orange and purple tones",
			},
		};
		const component = toolDef.renderResult(result, { expanded: true, isPartial: false }, mockTheme);
		const text = renderToText(component);
		expect(text).toContain("Revised:");
		expect(text).toContain("detailed sunset");
	});
});

// ── renderResult — error ──────────────────────────────────────────────────────

describe("renderResult error", () => {
	it("shows error message", () => {
		const result = {
			content: [{ type: "text" as const, text: "Image generation failed: rate limited" }],
			details: {
				provider: "unknown",
				model: "unknown",
				paths: [],
				selectionReason: "error",
				isError: true,
				error: "rate limited",
				count: 0,
			},
		};
		const component = toolDef.renderResult(
			result,
			{ expanded: false, isPartial: false },
			mockTheme
		);
		const text = renderToText(component);
		expect(text).toContain("rate limited");
	});

	it("shows fallback when no details", () => {
		const result = {
			content: [{ type: "text" as const, text: "Something went wrong" }],
		};
		const component = toolDef.renderResult(
			result as typeof result & { details?: unknown },
			{ expanded: false, isPartial: false },
			mockTheme
		);
		const text = renderToText(component);
		expect(text).toContain("Something went wrong");
	});
});
