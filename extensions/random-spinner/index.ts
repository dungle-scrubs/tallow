/**
 * Random Spinner Extension
 *
 * Replaces the default Loader spinner with a randomly-picked preset
 * on each session start. All presets are inlined — no external dependency.
 *
 * Users can pin a specific spinner via settings.json:
 *   { "spinner": "arc" }
 * Or keep the default "random" behavior.
 *
 * Disable this extension to always use the Loader's hardcoded default (dots).
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Loader } from "@mariozechner/pi-tui";
import { getTallowSettingsPath } from "../_shared/tallow-paths.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SpinnerPreset {
	interval: number;
	frames: string[];
}

interface SpinnerSettings {
	spinner?: string;
}

// ─── Curated Presets ─────────────────────────────────────────────────────────
// Source: cli-spinners, filtered to glyphs that render reliably in common
// monospace terminal fonts. Only frames using well-supported Unicode blocks:
// ASCII, Latin-1, General Punctuation, Arrows, Math Operators, Misc Technical,
// Box Drawing, Block Elements, Geometric Shapes, Misc Symbols, Dingbats, Braille.

/* eslint-disable @stylistic/max-len */
const SPINNERS: Record<string, SpinnerPreset> = {
	dots: { interval: 80, frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] },
	dots2: { interval: 80, frames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] },
	dots3: { interval: 80, frames: ["⠋", "⠙", "⠚", "⠞", "⠖", "⠦", "⠴", "⠲", "⠳", "⠓"] },
	dots4: {
		interval: 80,
		frames: ["⠄", "⠆", "⠇", "⠋", "⠙", "⠸", "⠰", "⠠", "⠰", "⠸", "⠙", "⠋", "⠇", "⠆"],
	},
	dots5: {
		interval: 80,
		frames: ["⠋", "⠙", "⠚", "⠒", "⠂", "⠂", "⠒", "⠲", "⠴", "⠦", "⠖", "⠒", "⠐", "⠐", "⠒", "⠓", "⠋"],
	},
	dots6: {
		interval: 80,
		frames: [
			"⠁",
			"⠉",
			"⠙",
			"⠚",
			"⠒",
			"⠂",
			"⠂",
			"⠒",
			"⠲",
			"⠴",
			"⠤",
			"⠄",
			"⠄",
			"⠤",
			"⠴",
			"⠲",
			"⠒",
			"⠂",
			"⠂",
			"⠒",
			"⠚",
			"⠙",
			"⠉",
			"⠁",
		],
	},
	dots7: {
		interval: 80,
		frames: [
			"⠈",
			"⠉",
			"⠋",
			"⠓",
			"⠒",
			"⠐",
			"⠐",
			"⠒",
			"⠖",
			"⠦",
			"⠤",
			"⠠",
			"⠠",
			"⠤",
			"⠦",
			"⠖",
			"⠒",
			"⠐",
			"⠐",
			"⠒",
			"⠓",
			"⠋",
			"⠉",
			"⠈",
		],
	},
	dots8: {
		interval: 80,
		frames: [
			"⠁",
			"⠁",
			"⠉",
			"⠙",
			"⠚",
			"⠒",
			"⠂",
			"⠂",
			"⠒",
			"⠲",
			"⠴",
			"⠤",
			"⠄",
			"⠄",
			"⠤",
			"⠠",
			"⠠",
			"⠤",
			"⠦",
			"⠖",
			"⠒",
			"⠐",
			"⠐",
			"⠒",
			"⠓",
			"⠋",
			"⠉",
			"⠈",
			"⠈",
		],
	},
	dots9: { interval: 80, frames: ["⢹", "⢺", "⢼", "⣸", "⣇", "⡧", "⡗", "⡏"] },
	dots10: { interval: 80, frames: ["⢄", "⢂", "⢁", "⡁", "⡈", "⡐", "⡠"] },
	dots11: { interval: 100, frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"] },
	dots12: {
		interval: 80,
		frames: [
			"⢀⠀",
			"⡀⠀",
			"⠄⠀",
			"⢂⠀",
			"⡂⠀",
			"⠅⠀",
			"⢃⠀",
			"⡃⠀",
			"⠍⠀",
			"⢋⠀",
			"⡋⠀",
			"⠍⠁",
			"⢋⠁",
			"⡋⠁",
			"⠍⠉",
			"⠋⠉",
			"⠋⠉",
			"⠉⠙",
			"⠉⠙",
			"⠉⠩",
			"⠈⢙",
			"⠈⡙",
			"⢈⠩",
			"⡀⢙",
			"⠄⡙",
			"⢂⠩",
			"⡂⢘",
			"⠅⡘",
			"⢃⠨",
			"⡃⢐",
			"⠍⡐",
			"⢋⠠",
			"⡋⢀",
			"⠍⡁",
			"⢋⠁",
			"⡋⠁",
			"⠍⠉",
			"⠋⠉",
			"⠋⠉",
			"⠉⠙",
			"⠉⠙",
			"⠉⠩",
			"⠈⢙",
			"⠈⡙",
			"⠈⠩",
			"⠀⢙",
			"⠀⡙",
			"⠀⠩",
			"⠀⢘",
			"⠀⡘",
			"⠀⠨",
			"⠀⢐",
			"⠀⡐",
			"⠀⠠",
			"⠀⢀",
			"⠀⡀",
		],
	},
	dots13: { interval: 80, frames: ["⣼", "⣹", "⢻", "⠿", "⡟", "⣏", "⣧", "⣶"] },
	dots14: {
		interval: 80,
		frames: ["⠉⠉", "⠈⠙", "⠀⠹", "⠀⢸", "⠀⣰", "⢀⣠", "⣀⣀", "⣄⡀", "⣆⠀", "⡇⠀", "⠏⠀", "⠋⠁"],
	},
	dots8Bit: {
		interval: 80,
		frames: [
			"⠀",
			"⠁",
			"⠂",
			"⠃",
			"⠄",
			"⠅",
			"⠆",
			"⠇",
			"⡀",
			"⡁",
			"⡂",
			"⡃",
			"⡄",
			"⡅",
			"⡆",
			"⡇",
			"⠈",
			"⠉",
			"⠊",
			"⠋",
			"⠌",
			"⠍",
			"⠎",
			"⠏",
			"⡈",
			"⡉",
			"⡊",
			"⡋",
			"⡌",
			"⡍",
			"⡎",
			"⡏",
			"⠐",
			"⠑",
			"⠒",
			"⠓",
			"⠔",
			"⠕",
			"⠖",
			"⠗",
			"⡐",
			"⡑",
			"⡒",
			"⡓",
			"⡔",
			"⡕",
			"⡖",
			"⡗",
			"⠘",
			"⠙",
			"⠚",
			"⠛",
			"⠜",
			"⠝",
			"⠞",
			"⠟",
			"⡘",
			"⡙",
			"⡚",
			"⡛",
			"⡜",
			"⡝",
			"⡞",
			"⡟",
			"⠠",
			"⠡",
			"⠢",
			"⠣",
			"⠤",
			"⠥",
			"⠦",
			"⠧",
			"⡠",
			"⡡",
			"⡢",
			"⡣",
			"⡤",
			"⡥",
			"⡦",
			"⡧",
			"⠨",
			"⠩",
			"⠪",
			"⠫",
			"⠬",
			"⠭",
			"⠮",
			"⠯",
			"⡨",
			"⡩",
			"⡪",
			"⡫",
			"⡬",
			"⡭",
			"⡮",
			"⡯",
			"⠰",
			"⠱",
			"⠲",
			"⠳",
			"⠴",
			"⠵",
			"⠶",
			"⠷",
			"⡰",
			"⡱",
			"⡲",
			"⡳",
			"⡴",
			"⡵",
			"⡶",
			"⡷",
			"⠸",
			"⠹",
			"⠺",
			"⠻",
			"⠼",
			"⠽",
			"⠾",
			"⠿",
			"⡸",
			"⡹",
			"⡺",
			"⡻",
			"⡼",
			"⡽",
			"⡾",
			"⡿",
			"⢀",
			"⢁",
			"⢂",
			"⢃",
			"⢄",
			"⢅",
			"⢆",
			"⢇",
			"⣀",
			"⣁",
			"⣂",
			"⣃",
			"⣄",
			"⣅",
			"⣆",
			"⣇",
			"⢈",
			"⢉",
			"⢊",
			"⢋",
			"⢌",
			"⢍",
			"⢎",
			"⢏",
			"⣈",
			"⣉",
			"⣊",
			"⣋",
			"⣌",
			"⣍",
			"⣎",
			"⣏",
			"⢐",
			"⢑",
			"⢒",
			"⢓",
			"⢔",
			"⢕",
			"⢖",
			"⢗",
			"⣐",
			"⣑",
			"⣒",
			"⣓",
			"⣔",
			"⣕",
			"⣖",
			"⣗",
			"⢘",
			"⢙",
			"⢚",
			"⢛",
			"⢜",
			"⢝",
			"⢞",
			"⢟",
			"⣘",
			"⣙",
			"⣚",
			"⣛",
			"⣜",
			"⣝",
			"⣞",
			"⣟",
			"⢠",
			"⢡",
			"⢢",
			"⢣",
			"⢤",
			"⢥",
			"⢦",
			"⢧",
			"⣠",
			"⣡",
			"⣢",
			"⣣",
			"⣤",
			"⣥",
			"⣦",
			"⣧",
			"⢨",
			"⢩",
			"⢪",
			"⢫",
			"⢬",
			"⢭",
			"⢮",
			"⢯",
			"⣨",
			"⣩",
			"⣪",
			"⣫",
			"⣬",
			"⣭",
			"⣮",
			"⣯",
			"⢰",
			"⢱",
			"⢲",
			"⢳",
			"⢴",
			"⢵",
			"⢶",
			"⢷",
			"⣰",
			"⣱",
			"⣲",
			"⣳",
			"⣴",
			"⣵",
			"⣶",
			"⣷",
			"⢸",
			"⢹",
			"⢺",
			"⢻",
			"⢼",
			"⢽",
			"⢾",
			"⢿",
			"⣸",
			"⣹",
			"⣺",
			"⣻",
			"⣼",
			"⣽",
			"⣾",
			"⣿",
		],
	},
	dotsCircle: { interval: 80, frames: ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"] },
	sand: {
		interval: 80,
		frames: [
			"⠁",
			"⠂",
			"⠄",
			"⡀",
			"⡈",
			"⡐",
			"⡠",
			"⣀",
			"⣁",
			"⣂",
			"⣄",
			"⣌",
			"⣔",
			"⣤",
			"⣥",
			"⣦",
			"⣮",
			"⣶",
			"⣷",
			"⣿",
			"⡿",
			"⠿",
			"⢟",
			"⠟",
			"⡛",
			"⠛",
			"⠫",
			"⢋",
			"⠋",
			"⠍",
			"⡉",
			"⠉",
			"⠑",
			"⠡",
			"⢁",
		],
	},
	line: { interval: 130, frames: ["-", "\\", "|", "/"] },
	line2: { interval: 100, frames: ["⠂", "-", "–", "—", "–", "-"] },
	rollingLine: { interval: 80, frames: ["/  ", " - ", " \\ ", "  |", "  |", " \\ ", " - ", "/  "] },
	pipe: { interval: 100, frames: ["┤", "┘", "┴", "└", "├", "┌", "┬", "┐"] },
	simpleDots: { interval: 400, frames: [".  ", ".. ", "...", "   "] },
	simpleDotsScrolling: { interval: 200, frames: [".  ", ".. ", "...", " ..", "  .", "   "] },
	star: { interval: 70, frames: ["✶", "✸", "✹", "✺", "✹", "✷"] },
	star2: { interval: 80, frames: ["+", "x", "*"] },
	flip: { interval: 70, frames: ["_", "_", "_", "-", "`", "`", "'", "´", "-", "_", "_", "_"] },
	hamburger: { interval: 100, frames: ["☱", "☲", "☴"] },
	growVertical: { interval: 120, frames: ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"] },
	growHorizontal: {
		interval: 120,
		frames: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "▊", "▋", "▌", "▍", "▎"],
	},
	balloon: { interval: 140, frames: [" ", ".", "o", "O", "@", "*", " "] },
	balloon2: { interval: 120, frames: [".", "o", "O", "°", "O", "o", "."] },
	noise: { interval: 100, frames: ["▓", "▒", "░"] },
	bounce: { interval: 120, frames: ["⠁", "⠂", "⠄", "⠂"] },
	boxBounce: { interval: 120, frames: ["▖", "▘", "▝", "▗"] },
	boxBounce2: { interval: 100, frames: ["▌", "▀", "▐", "▄"] },
	triangle: { interval: 50, frames: ["◢", "◣", "◤", "◥"] },
	arc: { interval: 100, frames: ["◜", "◠", "◝", "◞", "◡", "◟"] },
	circle: { interval: 120, frames: ["◡", "⊙", "◠"] },
	squareCorners: { interval: 180, frames: ["◰", "◳", "◲", "◱"] },
	circleQuarters: { interval: 120, frames: ["◴", "◷", "◶", "◵"] },
	circleHalves: { interval: 50, frames: ["◐", "◓", "◑", "◒"] },
	squish: { interval: 100, frames: ["╫", "╪"] },
	toggle: { interval: 250, frames: ["⊶", "⊷"] },
	toggle2: { interval: 80, frames: ["▫", "▪"] },
	toggle3: { interval: 120, frames: ["□", "■"] },
	toggle4: { interval: 100, frames: ["■", "□", "▪", "▫"] },
	toggle5: { interval: 100, frames: ["▮", "▯"] },
	toggle8: { interval: 100, frames: ["◍", "◌"] },
	toggle9: { interval: 100, frames: ["◉", "◎"] },
	toggle12: { interval: 120, frames: ["☗", "☖"] },
	toggle13: { interval: 80, frames: ["=", "*", "-"] },
	arrow: { interval: 100, frames: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"] },
	dqpb: { interval: 100, frames: ["d", "q", "p", "b"] },
	point: { interval: 125, frames: ["∙∙∙", "●∙∙", "∙●∙", "∙∙●", "∙∙∙"] },
	layer: { interval: 150, frames: ["-", "=", "≡"] },
	centipede: {
		interval: 180,
		frames: [
			"🍕😊😊😊😊😊  ",
			"🍕😊😊😊😊😊  ",
			"🍕😊😊😊😊😊  ",
			"  😊😊😊😊😊  ",
			"  😐😊😊😊😊  ",
			"  😣😐😊😊😊  ",
			"  😣😣😐😊😊  ",
			"  😣😣😣😐😊  ",
			"  😣😣😣😣😐  ",
			"  😣😣😣😣😣  ",
			"  😣😣😣😣😣💩",
			"  😣😣😣😣😣💩",
			"  😣😣😣😣😣💩",
		],
	},
};
/* eslint-enable @stylistic/max-len */

const SPINNER_NAMES = Object.keys(SPINNERS);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pick a random spinner preset.
 * @returns Spinner definition with frames and interval
 */
function pickRandom(): SpinnerPreset {
	return SPINNERS[SPINNER_NAMES[Math.floor(Math.random() * SPINNER_NAMES.length)]];
}

/**
 * Resolve a spinner by name.
 * @param name - Preset name (e.g. "dots", "arc") or "random"
 * @returns Spinner preset, or undefined if name not found
 */
function resolve(name: string): SpinnerPreset | undefined {
	if (name === "random") return pickRandom();
	return SPINNERS[name];
}

/**
 * Read spinner settings from ~/.tallow/settings.json.
 * @returns Parsed spinner settings with defaults
 */
function readSettings(): SpinnerSettings {
	const settingsPath = getTallowSettingsPath();
	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		return JSON.parse(raw) as SpinnerSettings;
	} catch {
		return {};
	}
}

// ─── Extension Entry ─────────────────────────────────────────────────────────

/**
 * Random spinner extension.
 * Reads spinner settings on session_start, bridges into Loader defaults.
 *
 * @param pi - Extension API
 */
export default function randomSpinnerExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const settings = readSettings();
		const spinnerSetting = settings.spinner ?? "random";
		const isRandom = spinnerSetting === "random";

		// ── Spinner frames ──
		if (isRandom) {
			let cached: SpinnerPreset | undefined;
			const roll = (): SpinnerPreset => {
				if (!cached) cached = pickRandom();
				return cached;
			};
			Object.defineProperty(Loader, "defaultFrames", {
				get: () => {
					cached = undefined;
					return roll().frames;
				},
				configurable: true,
			});
			Object.defineProperty(Loader, "defaultIntervalMs", {
				get: () => roll().interval,
				configurable: true,
			});
		} else {
			const preset = resolve(spinnerSetting);
			if (preset) {
				Loader.defaultFrames = preset.frames;
				Loader.defaultIntervalMs = preset.interval;
			}
		}
	});
}
