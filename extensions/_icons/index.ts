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
 *
 * Underscore prefix (_icons) ensures this extension loads before
 * others that depend on it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

/** Icon values — single glyph or array of frames (for spinners). */
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
}

// ─── Defaults ────────────────────────────────────────────────────────────────

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
	spinner: ["◐", "◓", "◑", "◒"],
	plan_mode: "⏸",
	task_list: "📋",
	comment: "💬",
};

// ─── Registry Factory ────────────────────────────────────────────────────────

/**
 * Create an icon registry by merging user overrides with defaults.
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
			const val = resolved.get("spinner");
			if (Array.isArray(val) && val.length > 0) return val;
			return ICON_DEFAULTS.spinner as string[];
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
	return ICON_DEFAULTS.spinner as string[];
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
		globalThis.__tallowIcons = createIconRegistry(overrides);
	});
}
