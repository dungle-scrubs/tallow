/**
 * Tests for upstream terminal-image primitives kept in the fork.
 */
import { describe, expect, it } from "bun:test";
import {
	calculateImageRows,
	getGifDimensions,
	getImageDimensions,
	getPngDimensions,
	getWebpDimensions,
	type ImageDimensions,
	renderImage,
} from "../terminal-image.js";
import { withCapabilityEnv } from "../test-utils/capability-env.js";

const DEFAULT_CELL = { heightPx: 18, widthPx: 9 };

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W2fkAAAAASUVORK5CYII=";
const GIF_BASE64 = "R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=";
const WEBP_BASE64 =
	"UklGRiYAAABXRUJQVlA4IBoAAAAQAgCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9LgAAA=";

function kittyResult(maxWidthCells: number, imageDimensions: ImageDimensions) {
	return withCapabilityEnv({ TERM_PROGRAM: "kitty" }, () =>
		renderImage("AA==", imageDimensions, { maxWidthCells })
	);
}

describe("terminal-image", () => {
	it("calculates image rows from target width and cell size", () => {
		const rows = calculateImageRows({ heightPx: 900, widthPx: 1800 }, 60, DEFAULT_CELL);
		expect(rows).toBe(15);
	});

	it("parses PNG dimensions", () => {
		expect(getPngDimensions(TINY_PNG_BASE64)).toEqual({ heightPx: 1, widthPx: 1 });
	});

	it("parses GIF dimensions", () => {
		expect(getGifDimensions(GIF_BASE64)).toEqual({ heightPx: 1, widthPx: 1 });
	});

	it("parses WEBP dimensions", () => {
		const dims = getWebpDimensions(WEBP_BASE64);
		expect(dims).not.toBeNull();
		expect(dims?.widthPx).toBeGreaterThanOrEqual(1);
		expect(dims?.heightPx).toBeGreaterThanOrEqual(1);
	});

	it("dispatches getImageDimensions by mime type", () => {
		expect(getImageDimensions(TINY_PNG_BASE64, "image/png")).toEqual({ heightPx: 1, widthPx: 1 });
		expect(getImageDimensions(GIF_BASE64, "image/gif")).toEqual({ heightPx: 1, widthPx: 1 });
	});

	it("renders kitty images with rows derived from the image size", () => {
		const result = kittyResult(8, { heightPx: 2556, widthPx: 1179 });
		expect(result).not.toBeNull();
		expect(result?.sequence).toContain("\x1b_G");
		expect(result?.rows).toBe(calculateImageRows({ heightPx: 2556, widthPx: 1179 }, 8));
	});

	it("renders iTerm images with auto height", () => {
		const result = withCapabilityEnv({ TERM_PROGRAM: "iTerm.app" }, () =>
			renderImage("AA==", { heightPx: 1080, widthPx: 1920 }, { maxWidthCells: 30 })
		);
		expect(result).not.toBeNull();
		expect(result?.sequence).toContain("\x1b]1337;File=");
		expect(result?.sequence).toContain("height=auto");
	});

	it("returns null when image protocols are unavailable", () => {
		const result = withCapabilityEnv({ TERM_PROGRAM: "unknown", TMUX: "1" }, () =>
			renderImage("AA==", { heightPx: 1080, widthPx: 1920 }, { maxWidthCells: 30 })
		);
		expect(result).toBeNull();
	});
});
