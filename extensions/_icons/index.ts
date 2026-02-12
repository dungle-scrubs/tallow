/**
 * Icon Registry Extension
 *
 * Provides user-configurable TUI glyphs via settings.json.
 * Extensions call getIcon(key) instead of hardcoding literals.
 *
 * Architecture:
 *   - Reads `icons` from ~/.tallow/settings.json on session_start
 *   - Merges user overrides with ICON_DEFAULTS
 *   - Stores resolved map on globalThis.__tallowIcons
 *   - getIcon() / getSpinner() read from the global (zero overhead)
 *   - Spinner accepts named presets from cli-spinners or "random"
 *
 * Underscore prefix (_icons) ensures this extension loads before
 * others that depend on it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Loader } from "@mariozechner/pi-tui";
import cliSpinners from "cli-spinners";

// ─── Types ───────────────────────────────────────────────────────────────────

/** All recognized icon keys. */
export type IconKey =
	| "success"
	| "error"
	| "pending"
	| "in_progress"
	| "idle"
	| "waiting"
	| "active"
	| "blocked"
	| "unavailable"
	| "spinner"
	| "plan_mode"
	| "task_list"
	| "comment";

/** Icon values — single glyph, array of frames, or named preset for spinners. */
export type IconValue = string | string[];

/** User overrides from settings.json `icons` field. */
export type IconOverrides = Partial<Record<IconKey, IconValue>>;

/** Resolved icon registry — defaults merged with user overrides. */
export interface IconRegistry {
	/** Get an icon value by key. Returns undefined for unknown keys. */
	get(key: IconKey): IconValue | undefined;
	/** Get a string icon, falling back to the provided default. */
	getString(key: IconKey, fallback?: string): string;
	/** Get spinner frames array. */
	getSpinner(): string[];
	/** Get the resolved spinner interval in ms (from cli-spinners preset or default 80). */
	getSpinnerInterval(): number;
}

// ─── cli-spinners helpers ────────────────────────────────────────────────────

/** All valid preset names from cli-spinners (excludes module metadata keys). */
const SPINNER_NAMES = (Object.keys(cliSpinners) as (keyof typeof cliSpinners)[]).filter(
	(k) => {
		const val = cliSpinners[k];
		return val && typeof val === "object" && "frames" in val;
	},
);

/**
 * Pick a random spinner from the full cli-spinners library.
 * @returns Spinner definition with frames and interval
 */
function pickRandomSpinner(): { frames: string[]; interval: number } {
	const pick = SPINNER_NAMES[Math.floor(Math.random() * SPINNER_NAMES.length)];
	return cliSpinners[pick];
}

/**
 * Resolve a spinner by name from cli-spinners.
 * @param name - Preset name (e.g. "dots", "arc", "random")
 * @returns Spinner definition with frames and interval, or undefined
 */
function resolveSpinnerPreset(name: string): { frames: string[]; interval: number } | undefined {
	if (name === "random") return pickRandomSpinner();
	const preset = cliSpinners[name as keyof typeof cliSpinners];
	return preset ?? undefined;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * Default spinner preset name. "random" picks a new one each session.
 * Users can override with any cli-spinners name or "random".
 */
const DEFAULT_SPINNER_PRESET = "random";

/** Hardcoded fallback when preset resolution fails (ora's default). */
const FALLBACK_SPINNER = cliSpinners.dots;

/** Default icon glyphs — matches the hardcoded values across all extensions. */
export const ICON_DEFAULTS: Record<IconKey, IconValue> = {
	success: "✓",
	error: "✗",
	pending: "☐",
	in_progress: "●",
	idle: "○",
	waiting: "⏳",
	active: "⚡",
	blocked: "◇",
	unavailable: "⊘",
	spinner: DEFAULT_SPINNER_PRESET,
	plan_mode: "⏸",
	task_list: "📋",
	comment: "💬",
};

// ─── Registry Factory ────────────────────────────────────────────────────────

/**
 * Create an icon registry by merging user overrides with defaults.
 * Spinner values are resolved: string → cli-spinners preset, array → raw frames.
 *
 * @param overrides - User icon overrides from settings.json
 * @returns Resolved icon registry
 */
export function createIconRegistry(overrides: IconOverrides): IconRegistry {
	const resolved = new Map<string, IconValue>();

	// Start with defaults
	for (const [key, value] of Object.entries(ICON_DEFAULTS)) {
		resolved.set(key, value);
	}

	// Apply user overrides (only valid keys)
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined && value !== null) {
			resolved.set(key, value);
		}
	}

	// Resolve spinner — "random" re-rolls on every call, others resolve once
	const spinnerVal = resolved.get("spinner");
	const isRandom = spinnerVal === "random";

	/** Resolve a fixed spinner from a named preset or raw frames. */
	function resolveFixed(): { frames: string[]; interval: number } {
		if (typeof spinnerVal === "string") {
			return resolveSpinnerPreset(spinnerVal) ?? FALLBACK_SPINNER;
		}
		if (Array.isArray(spinnerVal) && spinnerVal.length > 0) {
			return { frames: spinnerVal, interval: 80 };
		}
		return FALLBACK_SPINNER;
	}

	// Pre-resolve for non-random mode (zero overhead per call)
	const fixed = isRandom ? undefined : resolveFixed();

	return {
		get(key: IconKey): IconValue | undefined {
			return resolved.get(key);
		},

		getString(key: IconKey, fallback = ""): string {
			const val = resolved.get(key);
			if (typeof val === "string") return val;
			return fallback;
		},

		getSpinner(): string[] {
			return (isRandom ? pickRandomSpinner() : fixed!).frames;
		},

		getSpinnerInterval(): number {
			return (isRandom ? pickRandomSpinner() : fixed!).interval;
		},
	};
}

// ─── Global Access ───────────────────────────────────────────────────────────

declare global {
	// biome-ignore lint: globalThis augmentation requires var
	var __tallowIcons: IconRegistry | undefined;
}

/**
 * Get an icon by key. Reads from the global registry populated at session_start.
 * Falls back to ICON_DEFAULTS if the registry hasn't been initialized yet.
 *
 * @param key - Icon key to look up
 * @returns The icon glyph string
 */
export function getIcon(key: IconKey): string {
	const registry = globalThis.__tallowIcons;
	if (registry) {
		return registry.getString(key);
	}
	// Fallback before session_start
	const def = ICON_DEFAULTS[key];
	return typeof def === "string" ? def : "";
}

/**
 * Get spinner animation frames. Reads from the global registry.
 * Falls back to default spinner if registry hasn't been initialized.
 *
 * @returns Array of spinner frame glyphs
 */
export function getSpinner(): string[] {
	const registry = globalThis.__tallowIcons;
	if (registry) {
		return registry.getSpinner();
	}
	return FALLBACK_SPINNER.frames;
}

// ─── Settings Reader ─────────────────────────────────────────────────────────

/**
 * Read icon overrides from ~/.tallow/settings.json.
 * Returns empty object if file doesn't exist or has no icons field.
 *
 * @returns User icon overrides
 */
function readIconSettings(): IconOverrides {
	const settingsPath = path.join(os.homedir(), ".tallow", "settings.json");
	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { icons?: IconOverrides };
		return settings.icons ?? {};
	} catch {
		return {};
	}
}

// ─── Extension Entry ─────────────────────────────────────────────────────────

/**
 * Icon registry extension factory.
 * Reads user overrides on session_start and populates the global registry.
 *
 * @param pi - Extension API
 */
export default function iconRegistryExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const overrides = readIconSettings();
		const registry = createIconRegistry(overrides);
		globalThis.__tallowIcons = registry;

		// Bridge into Loader so the "Working..." loader uses the icon registry's spinner.
		// When random, a getter re-rolls on every Loader construction.
		const spinnerVal = registry.get("spinner");
		if (spinnerVal === "random") {
			// Cache one roll so both getters return values from the same spinner.
			// Re-rolls on the next defaultFrames access (i.e. next Loader construction).
			let cached: { frames: string[]; interval: number } | undefined;
			const roll = () => (cached ??= pickRandomSpinner());
			Object.defineProperty(Loader, "defaultFrames", {
				get: () => {
					cached = undefined; // invalidate so this roll is fresh
					return roll().frames;
				},
				configurable: true,
			});
			Object.defineProperty(Loader, "defaultIntervalMs", {
				get: () => roll().interval, // reuses same roll from defaultFrames
				configurable: true,
			});
		} else {
			Loader.defaultFrames = registry.getSpinner();
			Loader.defaultIntervalMs = registry.getSpinnerInterval();
		}
	});
}
