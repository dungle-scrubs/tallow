/**
 * Tests for image layout calculations.
 *
 * Verifies calculateImageLayout produces correct aspect-ratio-preserving
 * dimensions, and that the Image component uses full terminal width
 * (ignoring the hardcoded maxWidthCells from upstream).
 *
 * @module
 */
import { describe, expect, it } from "bun:test";
import { calculateImageLayout } from "@mariozechner/pi-tui";

/** Standard cell dimensions: 9px wide, 18px tall (2:1 aspect). */
const CELLS = { widthPx: 9, heightPx: 18 };

describe("calculateImageLayout", () => {
	it("fills available width for wide images", () => {
		const layout = calculateImageLayout({ widthPx: 1536, heightPx: 1024 }, 94, CELLS);
		// Image is wider than 94 cols (171 natural cols), so should clamp to 94
		expect(layout.columns).toBe(94);
	});

	it("does not upscale small images beyond natural width", () => {
		// Small 200px image: natural cols = ceil(200/9) = 23
		const layout = calculateImageLayout({ widthPx: 200, heightPx: 200 }, 94, CELLS);
		expect(layout.columns).toBe(23);
		expect(layout.columns).toBeLessThan(94);
	});

	it("preserves landscape aspect ratio", () => {
		// 3:2 image at full width
		const layout = calculateImageLayout({ widthPx: 1536, heightPx: 1024 }, 94, CELLS);
		// columns/rows should reflect landscape (wider than tall in cell space)
		// With 2:1 cell aspect, a 3:2 image needs ratio > 1 in cells
		const cellRatio = layout.columns / layout.rows;
		expect(cellRatio).toBeGreaterThan(1);
	});

	it("preserves portrait aspect ratio", () => {
		// 2:3 image (1024×1536). With 2:1 cell aspect (9×18px), portrait images
		// have more rows than columns only when accounting for cell proportions.
		// The pixel ratio should be maintained: (cols * cellW) / (rows * cellH) ≈ imgW / imgH
		const layout = calculateImageLayout({ widthPx: 1024, heightPx: 1536 }, 94, CELLS);
		const renderedRatio = (layout.columns * CELLS.widthPx) / (layout.rows * CELLS.heightPx);
		const imageRatio = 1024 / 1536;
		// Allow 5% tolerance for rounding
		expect(Math.abs(renderedRatio - imageRatio)).toBeLessThan(0.05);
	});

	it("height-clamps tall images and reduces columns proportionally", () => {
		// Very tall image: 500x2000 at 94 max width
		const layout = calculateImageLayout({ widthPx: 500, heightPx: 2000 }, 94, CELLS, 25);
		expect(layout.rows).toBe(25);
		// Columns should be reduced from natural width (ceil(500/9)=56)
		expect(layout.columns).toBeLessThan(56);
		expect(layout.columns).toBeGreaterThan(0);
	});

	it("does not height-clamp when rows fit", () => {
		// Wide landscape image: 1536x400
		const layout = calculateImageLayout({ widthPx: 1536, heightPx: 400 }, 94, CELLS, 25);
		// rows = ceil((94*9/1536) * 400 / 18) = ceil(12.2) = 13
		expect(layout.rows).toBeLessThan(25);
		expect(layout.columns).toBe(94);
	});

	it("returns at least 1 row and 1 column", () => {
		const layout = calculateImageLayout({ widthPx: 1, heightPx: 1 }, 1, CELLS, 1);
		expect(layout.rows).toBeGreaterThanOrEqual(1);
		expect(layout.columns).toBeGreaterThanOrEqual(1);
	});
});

describe("landscape image at full terminal width", () => {
	it("3:2 image uses more columns after height clamping than at 60 cols", () => {
		// This is the core fix: with maxWidthCells=60 (upstream), the image
		// gets squashed. With maxWidthCells=94 (full width), it's wider.
		const squashed = calculateImageLayout({ widthPx: 1536, heightPx: 1024 }, 60, CELLS, 25);
		const full = calculateImageLayout({ widthPx: 1536, heightPx: 1024 }, 94, CELLS, 25);

		// At 60 cols: rows=20, no height clamp needed, columns=60
		// At 94 cols: rows=32 → clamped to 25, columns reduced proportionally
		// Full width should still give more columns
		expect(full.columns).toBeGreaterThan(squashed.columns);
	});

	it("16:9 image benefits significantly from full width", () => {
		const squashed = calculateImageLayout({ widthPx: 1920, heightPx: 1080 }, 60, CELLS, 25);
		const full = calculateImageLayout({ widthPx: 1920, heightPx: 1080 }, 94, CELLS, 25);

		expect(full.columns).toBeGreaterThan(squashed.columns);
		// 16:9 should still be landscape in cell space at full width
		expect(full.columns / full.rows).toBeGreaterThan(1);
	});

	it("square image is similar at both widths", () => {
		const squashed = calculateImageLayout({ widthPx: 1024, heightPx: 1024 }, 60, CELLS, 25);
		const full = calculateImageLayout({ widthPx: 1024, heightPx: 1024 }, 94, CELLS, 25);

		// Both should height-clamp at 25 rows
		expect(squashed.rows).toBe(25);
		expect(full.rows).toBe(25);
		// Square: columns should equal half the rows (due to 2:1 cell aspect)
		// So both end up at similar column counts
		expect(squashed.columns).toBe(full.columns);
	});
});
