/**
 * Tests for image layout calculations: maxHeightCells clamping,
 * natural width clamping, and aspect ratio preservation.
 */
import { describe, expect, it } from "bun:test";
import {
	calculateImageLayout,
	detectImageFormat,
	type ImageDimensions,
	imageFormatToMime,
} from "../terminal-image.js";

const DEFAULT_CELL = { widthPx: 9, heightPx: 18 };

// ── calculateImageLayout ─────────────────────────────────────────────────────

describe("calculateImageLayout", () => {
	describe("basic layout", () => {
		it("calculates rows and columns for a standard image", () => {
			const dims: ImageDimensions = { widthPx: 1800, heightPx: 900 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL);
			expect(layout.columns).toBe(60);
			// 60 cols × 9px = 540px wide, scale = 540/1800 = 0.3
			// 900 × 0.3 = 270px tall, 270/18 = 15 rows
			expect(layout.rows).toBe(15);
		});

		it("returns at least 1 row for tiny images", () => {
			const dims: ImageDimensions = { widthPx: 100, heightPx: 1 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL);
			expect(layout.rows).toBeGreaterThanOrEqual(1);
		});
	});

	describe("natural width clamping", () => {
		it("clamps small images to their natural column count", () => {
			const dims: ImageDimensions = { widthPx: 100, heightPx: 100 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL);
			// Natural cols = ceil(100/9) = 12 — should NOT stretch to 60
			expect(layout.columns).toBe(12);
			expect(layout.columns).toBeLessThan(60);
		});

		it("does not clamp images wider than maxWidth", () => {
			const dims: ImageDimensions = { widthPx: 3000, heightPx: 2000 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL);
			expect(layout.columns).toBe(60);
		});

		it("uses natural width when it equals maxWidth", () => {
			// 540px / 9px = 60 cols exactly
			const dims: ImageDimensions = { widthPx: 540, heightPx: 270 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL);
			expect(layout.columns).toBe(60);
		});
	});

	describe("maxHeightCells clamping", () => {
		it("clamps portrait images to maxHeightCells but keeps full width", () => {
			const dims: ImageDimensions = { widthPx: 1000, heightPx: 2000 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL, 25);
			expect(layout.rows).toBe(25);
			// Width stays at natural cols (ceil(1000/9) = 112 > 60, so capped at 60)
			expect(layout.columns).toBe(60);
		});

		it("does not clamp landscape images below maxHeightCells", () => {
			const dims: ImageDimensions = { widthPx: 2000, heightPx: 1000 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL, 25);
			// Landscape at 60 cols: rows = ceil(1000 * (540/2000) / 18) = 15
			expect(layout.rows).toBe(15);
			expect(layout.columns).toBe(60);
		});

		it("clamps tall portrait rows but preserves full width", () => {
			const dims: ImageDimensions = { widthPx: 500, heightPx: 3000 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL, 25);
			expect(layout.rows).toBe(25);
			// Width stays at natural cols: ceil(500/9) = 56
			expect(layout.columns).toBe(56);
		});

		it("keeps full width when clamping height on square images", () => {
			const dims: ImageDimensions = { widthPx: 1024, heightPx: 1024 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL, 25);
			expect(layout.rows).toBe(25);
			// Width stays at 60 (natural = ceil(1024/9) = 114 > 60)
			expect(layout.columns).toBe(60);
		});

		it("does nothing when maxHeightCells is undefined", () => {
			const dims: ImageDimensions = { widthPx: 500, heightPx: 3000 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL);
			// No clamp — natural cols = ceil(500/9) = 56, rows = ceil(3000*(56*9/500)/18) = 168
			expect(layout.rows).toBeGreaterThan(100);
		});

		it("columns never exceed maxWidthCells", () => {
			const dims: ImageDimensions = { widthPx: 4000, heightPx: 4001 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL, 25);
			expect(layout.columns).toBeLessThanOrEqual(60);
		});

		it("columns are at least 1 after clamping", () => {
			// Extremely tall, narrow image
			const dims: ImageDimensions = { widthPx: 10, heightPx: 10000 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL, 5);
			expect(layout.columns).toBeGreaterThanOrEqual(1);
			expect(layout.rows).toBe(5);
		});
	});

	describe("combined natural width + height clamping", () => {
		it("clamps width first, then height", () => {
			// Small AND tall: 100×1000
			const dims: ImageDimensions = { widthPx: 100, heightPx: 1000 };
			const layout = calculateImageLayout(dims, 60, DEFAULT_CELL, 25);
			// Natural cols = ceil(100/9) = 12 (clamped from 60)
			// At 12 cols: rows = ceil(1000 * (12*9/100) / 18) = ceil(60) = 60
			// Then clamped to 25 rows, back-calc columns
			expect(layout.rows).toBe(25);
			expect(layout.columns).toBeLessThanOrEqual(12);
		});
	});
});

// ── detectImageFormat ────────────────────────────────────────────────────────

describe("detectImageFormat", () => {
	it("detects PNG from magic bytes", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		expect(detectImageFormat(png)).toBe("png");
	});

	it("detects JPEG from magic bytes", () => {
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(detectImageFormat(jpeg)).toBe("jpeg");
	});

	it("detects JPEG with EXIF marker", () => {
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(detectImageFormat(jpeg)).toBe("jpeg");
	});

	it("detects GIF87a", () => {
		// "GIF87a" = 47 49 46 38 37 61
		const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0, 0, 0, 0, 0, 0]);
		expect(detectImageFormat(gif)).toBe("gif");
	});

	it("detects GIF89a", () => {
		const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
		expect(detectImageFormat(gif)).toBe("gif");
	});

	it("detects WebP from RIFF...WEBP header", () => {
		// "RIFF" + 4 bytes size + "WEBP"
		const webp = Buffer.from([
			0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
		]);
		expect(detectImageFormat(webp)).toBe("webp");
	});

	it("returns null for text content", () => {
		const text = Buffer.from("Hello, world! This is plain text.");
		expect(detectImageFormat(text)).toBeNull();
	});

	it("returns null for empty buffer", () => {
		expect(detectImageFormat(Buffer.alloc(0))).toBeNull();
	});

	it("returns null for buffer too short for any format", () => {
		expect(detectImageFormat(Buffer.from([0xff, 0xd8]))).toBeNull();
	});

	it("returns null for partial PNG header", () => {
		// Only 4 bytes of PNG header (needs 8)
		expect(detectImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
	});

	it("returns null for RIFF without WEBP marker", () => {
		// RIFF + size + "AVI " instead of "WEBP"
		const avi = Buffer.from([
			0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
		]);
		expect(detectImageFormat(avi)).toBeNull();
	});
});

// ── imageFormatToMime ────────────────────────────────────────────────────────

describe("imageFormatToMime", () => {
	it("maps png to image/png", () => {
		expect(imageFormatToMime("png")).toBe("image/png");
	});

	it("maps jpeg to image/jpeg", () => {
		expect(imageFormatToMime("jpeg")).toBe("image/jpeg");
	});

	it("maps gif to image/gif", () => {
		expect(imageFormatToMime("gif")).toBe("image/gif");
	});

	it("maps webp to image/webp", () => {
		expect(imageFormatToMime("webp")).toBe("image/webp");
	});
});
