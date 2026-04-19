import { describe, expect, test } from "bun:test";
import {
	createImageMetadata,
	detectImageFormat,
	formatImageDimensions,
	imageFormatToMime,
} from "../image-metadata.js";

describe("image-metadata", () => {
	test("detectImageFormat detects png and jpeg", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
		expect(detectImageFormat(png)).toBe("png");
		expect(detectImageFormat(jpeg)).toBe("jpeg");
	});

	test("imageFormatToMime maps format to mime type", () => {
		expect(imageFormatToMime("gif")).toBe("image/gif");
		expect(imageFormatToMime("webp")).toBe("image/webp");
	});

	test("createImageMetadata and formatImageDimensions handle resized images", () => {
		const meta = createImageMetadata(
			{ heightPx: 2160, widthPx: 3840 },
			{ heightPx: 450, widthPx: 800 },
			"png",
			123
		);
		expect(meta.resized).toBe(true);
		expect(meta.sizeBytes).toBe(123);
		expect(formatImageDimensions(meta)).toBe("3840×2160 → 800×450");
	});
});
