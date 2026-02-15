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
 * Spinner verbs: Shows a witty verb/phrase with a scramble-decrypt reveal
 * animation. Each word starts fully obfuscated with rapid random characters,
 * then staggers into clarity word by word.
 *
 * Configure via settings.json:
 *   { "spinnerVerbs": ["Pondering the void", "Summoning bytes"] }
 * Or omit for the built-in defaults.
 *
 * Disable this extension to always use the Loader's hardcoded default (dots).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Loader, type MessageTransformContext } from "@mariozechner/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SpinnerPreset {
	interval: number;
	frames: string[];
}

interface SpinnerSettings {
	spinner?: string;
	spinnerVerbs?: string[];
}

// ─── Default Witty Verbs ─────────────────────────────────────────────────────

const DEFAULT_VERBS: string[] = [
	"Thinking",
	"Plotting",
	"Scheming",
	"Manifesting",
	"Brewing",
	"Pondering the void",
	"Consulting the runes",
	"Summoning bytes",
	"Bending logic",
	"Defying entropy",
	"Parsing intentions",
	"Assembling thoughts",
	"Untangling threads",
	"Weaving code",
	"Computing furiously",
	"Hallucinating responsibly",
	"Rethinking everything",
	"Channeling wisdom",
	"Composing chaos",
	"Invoking patterns",
];

// ─── Scramble-Reveal Animation ───────────────────────────────────────────────

/** Characters used for the scramble effect — ASCII-safe, monospace-reliable. */
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&?!";

/** Ticks of pure scramble before the reveal sweep begins. */
const INITIAL_SCRAMBLE_TICKS = 4;

/**
 * Generate a random scramble character.
 * @returns A single random character from the scramble set
 */
function scrambleChar(): string {
	return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
}

/**
 * Create the message transform for the scramble-decrypt reveal effect.
 *
 * How it works:
 * 1. A random phrase is chosen and locked for this Loader's lifetime.
 * 2. Every character position is initialized with a random char (spaces stay).
 * 3. Each render frame, exactly ONE position cycles to a new random char
 *    (round-robin through positions, creating a visible wave).
 * 4. On each progress tick, one more char locks to its real value (right-to-left).
 * 5. Once fully revealed, the phrase stays until the Loader is destroyed.
 *
 * @param verbs - Array of verb/phrase strings to pick from
 * @returns Transform function compatible with Loader.defaultMessageTransform
 */
function createScrambleTransform(verbs: string[]): (ctx: MessageTransformContext) => string {
	/** The full display string (verb + "..."). Fixed per Loader instance. */
	let display = "";
	/** Cached character array — the actual rendered output. */
	let cachedChars: string[] = [];
	/** Indices of non-space positions (candidates for scramble cycling). */
	let nonSpaceIndices: number[] = [];
	/** Whether state has been initialized for the current Loader instance. */
	let initialized = false;
	/** Last seen tick — used to detect new Loader instances (tick goes backwards). */
	let lastTick = -1;
	/** Render frame counter — drives the round-robin single-char cycling. */
	let renderCount = 0;

	return ({ message, tick, isInitialMessage }: MessageTransformContext): string => {
		// Framework status update (e.g., "Reading file...") — show verbatim
		if (!isInitialMessage) return message;

		// Detect new Loader instance: tick went backwards (new Loader resets to 0)
		if (tick < lastTick) initialized = false;

		// Step 1–2: Pick phrase, initialize all slots with random chars
		if (!initialized) {
			const verb = verbs[Math.floor(Math.random() * verbs.length)];
			display = `${verb}...`;
			cachedChars = [...display].map((c) => (c === " " ? " " : scrambleChar()));
			nonSpaceIndices = [];
			for (let i = 0; i < display.length; i++) {
				if (display[i] !== " ") nonSpaceIndices.push(i);
			}
			renderCount = 0;
			initialized = true;
		}

		lastTick = tick;
		renderCount++;

		const len = display.length;
		const totalTicks = INITIAL_SCRAMBLE_TICKS + len;

		// Step 6: Fully revealed — return the real phrase, stable until Loader dies
		if (tick >= totalTicks) return display;

		// Step 4: Lock revealed chars (right-to-left sweep, one per progress tick)
		const revealedFromRight = Math.max(0, tick - INITIAL_SCRAMBLE_TICKS);
		for (let i = 0; i < len; i++) {
			if (display[i] !== " " && i >= len - revealedFromRight) {
				cachedChars[i] = display[i];
			}
		}

		// Step 3: Cycle exactly ONE unrevealed position per render frame (round-robin)
		const unrevealed = nonSpaceIndices.filter((i) => i < len - revealedFromRight);
		if (unrevealed.length > 0) {
			const idx = unrevealed[renderCount % unrevealed.length];
			cachedChars[idx] = scrambleChar();
		}

		return cachedChars.join("");
	};
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
	const settingsPath = path.join(os.homedir(), ".tallow", "settings.json");
	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		return JSON.parse(raw) as SpinnerSettings;
	} catch {
		return {};
	}
}

/**
 * Validate that a spinnerVerbs setting is a non-empty array of strings.
 * @param verbs - The value to validate
 * @returns The validated array, or undefined if invalid
 */
function validateVerbs(verbs: unknown): string[] | undefined {
	if (!Array.isArray(verbs)) return undefined;
	const strings = verbs.filter((v): v is string => typeof v === "string" && v.length > 0);
	return strings.length > 0 ? strings : undefined;
}

// ─── Extension Entry ─────────────────────────────────────────────────────────

/**
 * Random spinner extension.
 * Reads spinner and verb settings on session_start, bridges into Loader defaults.
 * Sets up the scramble-decrypt reveal animation for spinner verbs.
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

		// ── Scramble-reveal verbs ──
		const verbs = validateVerbs(settings.spinnerVerbs) ?? DEFAULT_VERBS;
		Loader.defaultMessageTransform = createScrambleTransform(verbs);
		Loader.defaultTransformIntervalMs = 25;
	});
}
