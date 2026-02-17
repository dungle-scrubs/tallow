/**
 * Tests for the formatElapsed helper.
 *
 * formatElapsed is a private function in index.ts, so we test it indirectly
 * through renderResult — the elapsed time appears in the completion footer.
 *
 * @module
 */
import { describe, expect, it } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import imageGenExtension from "../index.js";

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
} as unknown as Theme;

/** Capture the registered tool definition. */
let toolDef: {
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
 * Render a completion result with a given elapsedMs and extract the elapsed text.
 *
 * @param elapsedMs - Duration in milliseconds
 * @returns The rendered text for inspection
 */
function renderWithElapsed(elapsedMs: number): string {
	const result = {
		content: [{ type: "text" as const, text: "Generated 1 image" }],
		details: {
			provider: "openai",
			model: "gpt-image-1",
			paths: ["/tmp/test.png"],
			selectionReason: "test",
			count: 1,
			elapsedMs,
		},
	};
	return toolDef
		.renderResult(result, { expanded: false, isPartial: false }, mockTheme)
		.render(120)
		.join("\n");
}

describe("formatElapsed via renderResult", () => {
	it("shows milliseconds for sub-second durations", () => {
		expect(renderWithElapsed(450)).toContain("450ms");
	});

	it("shows milliseconds at exactly 999ms", () => {
		expect(renderWithElapsed(999)).toContain("999ms");
	});

	it("shows seconds with one decimal at 1000ms", () => {
		expect(renderWithElapsed(1000)).toContain("1.0s");
	});

	it("shows seconds with one decimal for typical duration", () => {
		expect(renderWithElapsed(12340)).toContain("12.3s");
	});

	it("shows seconds for just under a minute", () => {
		expect(renderWithElapsed(59900)).toContain("59.9s");
	});

	it("shows minutes and seconds at 60s", () => {
		expect(renderWithElapsed(60000)).toContain("1m 0s");
	});

	it("shows minutes and seconds for longer durations", () => {
		expect(renderWithElapsed(125000)).toContain("2m 5s");
	});

	it("omits elapsed when not provided", () => {
		const result = {
			content: [{ type: "text" as const, text: "Generated 1 image" }],
			details: {
				provider: "openai",
				model: "gpt-image-1",
				paths: ["/tmp/test.png"],
				selectionReason: "test",
				count: 1,
			},
		};
		const text = toolDef
			.renderResult(result, { expanded: false, isPartial: false }, mockTheme)
			.render(120)
			.join("\n");
		// Should not contain " in " duration pattern
		expect(text).not.toMatch(/in \d/);
	});
});
