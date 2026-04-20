import { describe, expect, it } from "bun:test";
import { Image, type ImageTheme } from "../components/image.js";
import { resetCapabilitiesCache } from "../terminal-image.js";

const IDENTITY_THEME: ImageTheme = {
	fallbackColor: (text) => text,
};

type CapabilityEnvOverrides = Readonly<Record<string, string | undefined>>;

function withCapabilityEnv<T>(overrides: CapabilityEnvOverrides, run: () => T): T {
	const keys = [
		"COLORTERM",
		"GHOSTTY_RESOURCES_DIR",
		"ITERM_SESSION_ID",
		"KITTY_WINDOW_ID",
		"TERM",
		"TERM_PROGRAM",
		"TMUX",
		"WEZTERM_PANE",
	] as const;
	const previous: Partial<Record<(typeof keys)[number], string | undefined>> = {};
	for (const key of keys) {
		previous[key] = process.env[key];
		if (Object.hasOwn(overrides, key)) {
			const value = overrides[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		} else {
			delete process.env[key];
		}
	}
	resetCapabilitiesCache();
	try {
		return run();
	} finally {
		for (const key of keys) {
			const value = previous[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		resetCapabilitiesCache();
	}
}

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
		withCapabilityEnv({ TERM: "tmux-256color", TERM_PROGRAM: "unknown", TMUX: "1" }, () => {
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
