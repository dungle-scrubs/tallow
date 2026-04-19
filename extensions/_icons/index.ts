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
 *   - getIcon() reads from the global (zero overhead)
 *
 * Underscore prefix (_icons) ensures this extension loads before
 * others that depend on it.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getTallowSettingsPath } from "../_shared/tallow-paths.js";

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
	| "task_list"
	| "comment";

/** Icon values — single glyph string. */
export type IconValue = string;

/** User overrides from settings.json `icons` field. */
export type IconOverrides = Partial<Record<IconKey, IconValue>>;

/** Resolved icon registry — defaults merged with user overrides. */
export interface IconRegistry {
	/** Get an icon value by key. Returns undefined for unknown keys. */
	get(key: IconKey): IconValue | undefined;
	/** Get a string icon, falling back to the provided default. */
	getString(key: IconKey, fallback?: string): string;
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

	for (const [key, value] of Object.entries(ICON_DEFAULTS)) {
		resolved.set(key, value);
	}

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
			return resolved.get(key) ?? fallback;
		},
	};
}

// ─── Global Access ───────────────────────────────────────────────────────────

declare global {
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
	return ICON_DEFAULTS[key] ?? "";
}

/**
 * Get the default spinner animation frames.
 *
 * @returns Array of spinner frame glyphs
 */
export function getSpinner(): string[] {
	return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
}

// ─── Settings Reader ─────────────────────────────────────────────────────────

/**
 * Read icon overrides from ~/.tallow/settings.json.
 * Returns empty object if file doesn't exist or has no icons field.
 *
 * @returns User icon overrides
 */
function readIconSettings(): IconOverrides {
	const settingsPath = getTallowSettingsPath();
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
