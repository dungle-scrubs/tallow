import { describe, expect, it } from "bun:test";
import { Image, type ImageTheme } from "../components/image.js";
import { withCapabilityEnv } from "../test-utils/capability-env.js";

const IDENTITY_THEME: ImageTheme = {
	fallbackColor: (text) => text,
};

/**
 * Extract Kitty `c=<columns>` param from rendered image lines.
 *
 * @param lines - Rendered TUI lines from Image.render
 * @returns Parsed Kitty column count, or null if sequence not present
 */
function getKittyColumns(lines: readonly string[]): number | null {
	for (const line of lines) {
		const start = line.indexOf("\x1b_G");
		if (start < 0) {
			continue;
		}
		const match = line.slice(start).match(/c=(\d+)/);
		if (match) {
			return Number(match[1]);
		}
	}
	return null;
}

describe("Image component narrow-pane rendering", () => {
	it("applies one safe width contract for border and no-border rendering", () => {
		withCapabilityEnv({ TERM_PROGRAM: "kitty" }, () => {
			const dimensions = { widthPx: 4000, heightPx: 2500 };
			const cases = [
				{ border: false, expectedColumns: 1, width: 1 },
				{ border: false, expectedColumns: 6, width: 8 },
				{ border: false, expectedColumns: 18, width: 20 },
				{ border: true, expectedColumns: 1, width: 1 },
				{ border: true, expectedColumns: 2, width: 8 },
				{ border: true, expectedColumns: 14, width: 20 },
			] as const;

			for (const testCase of cases) {
				const image = new Image(
					"AA==",
					"image/png",
					IDENTITY_THEME,
					{ border: testCase.border, maxHeightCells: 200 },
					dimensions
				);
				const lines = image.render(testCase.width);
				expect(lines.length).toBeGreaterThan(0);
				expect(getKittyColumns(lines)).toBe(testCase.expectedColumns);
			}
		});
	});

	it("renders portrait images at narrow widths with valid positive geometry", () => {
		withCapabilityEnv({ TERM_PROGRAM: "kitty" }, () => {
			const image = new Image(
				"AA==",
				"image/png",
				IDENTITY_THEME,
				{ border: false, maxHeightCells: 200 },
				{ widthPx: 1179, heightPx: 2556 }
			);

			for (const width of [8, 12, 20, 30]) {
				const lines = image.render(width);
				expect(lines.some((line) => line.includes("\x1b_G"))).toBe(true);
				const columns = getKittyColumns(lines);
				expect(columns).not.toBeNull();
				expect(columns).toBeGreaterThanOrEqual(1);
			}
		});
	});

	it("renders landscape images in narrow panes for both border modes", () => {
		withCapabilityEnv({ TERM_PROGRAM: "kitty" }, () => {
			const dimensions = { widthPx: 2400, heightPx: 1200 };
			for (const border of [false, true]) {
				const image = new Image(
					"AA==",
					"image/png",
					IDENTITY_THEME,
					{ border, maxHeightCells: 200 },
					dimensions
				);
				const lines = image.render(12);
				expect(lines.length).toBeGreaterThan(0);
				expect(getKittyColumns(lines)).toBeGreaterThanOrEqual(1);
			}
		});
	});

	it("degrades safely for ultra-narrow pane widths", () => {
		withCapabilityEnv({ TERM_PROGRAM: "kitty" }, () => {
			for (const border of [false, true]) {
				const image = new Image(
					"AA==",
					"image/png",
					IDENTITY_THEME,
					{ border, maxHeightCells: 200 },
					{ widthPx: 1200, heightPx: 1800 }
				);

				expect(() => image.render(0)).not.toThrow();
				expect(() => image.render(1)).not.toThrow();
				expect(getKittyColumns(image.render(0))).toBe(1);
				expect(getKittyColumns(image.render(1))).toBe(1);
			}
		});
	});
});
