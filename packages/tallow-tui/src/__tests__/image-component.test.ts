import { describe, expect, it } from "bun:test";
import { Image, type ImageTheme } from "../components/image.js";
import { withCapabilityEnv } from "../test-utils/capability-env.js";

const IDENTITY_THEME: ImageTheme = {
	fallbackColor: (text) => text,
};

function containsKittySequence(lines: readonly string[]): boolean {
	return lines.some((line) => line.includes("\x1b_G"));
}

describe("Image component", () => {
	it("renders kitty sequences when image support is available", () => {
		withCapabilityEnv({ TERM_PROGRAM: "kitty", TMUX: undefined }, () => {
			const image = new Image(
				"AA==",
				"image/png",
				IDENTITY_THEME,
				{ maxHeightCells: 200 },
				{ widthPx: 1179, heightPx: 2556 }
			);

			for (const width of [8, 12, 20, 30]) {
				const lines = image.render(width);
				expect(lines.length).toBeGreaterThan(0);
				expect(containsKittySequence(lines)).toBe(true);
			}
		});
	});

	it("returns stable output for repeated renders at the same width", () => {
		withCapabilityEnv({ TERM_PROGRAM: "kitty", TMUX: undefined }, () => {
			const image = new Image(
				"AA==",
				"image/png",
				IDENTITY_THEME,
				{ maxHeightCells: 200 },
				{ widthPx: 2400, heightPx: 1200 }
			);
			const first = image.render(12);
			const second = image.render(12);
			expect(second).toEqual(first);
		});
	});

	it("falls back to text when image protocols are unavailable", () => {
		withCapabilityEnv({ TERM_PROGRAM: "unknown", TMUX: "1" }, () => {
			const image = new Image(
				"AA==",
				"image/png",
				IDENTITY_THEME,
				{ filename: "example.png" },
				{ widthPx: 1200, heightPx: 1800 }
			);
			const lines = image.render(12);
			expect(lines).toEqual(["[Image: example.png [image/png] 1200x1800]"]);
		});
	});
});
