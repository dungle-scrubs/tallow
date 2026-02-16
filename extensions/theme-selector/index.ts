import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { atomicWriteFileSync } from "../_shared/atomic-write.js";

/**
 * Theme switcher extension with live preview.
 *
 * Provides a `/theme` command to switch between popular color themes
 * in real-time as you navigate the list.
 *
 * Supports tag-based filtering (`/theme warm`, `/theme cool vibrant`)
 * and `/theme random` to pick a random theme (optionally filtered).
 */

// ── Tag taxonomy ─────────────────────────────────────────────────────────────

type ThemeTag =
	| "warm"
	| "cool"
	| "muted"
	| "vibrant"
	| "minimal"
	| "high-contrast"
	| "low-contrast"
	| "pastel"
	| "neon"
	| "earthy"
	| "retro";

interface ThemeEntry {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly bg: string;
	readonly tags: readonly ThemeTag[];
}

const THEMES: readonly ThemeEntry[] = [
	// Catppuccin
	{
		name: "catppuccin-frappe",
		label: "Catppuccin Frappé",
		description: "Muted dark",
		bg: "#303446",
		tags: ["cool", "muted", "pastel"],
	},
	{
		name: "catppuccin-macchiato",
		label: "Catppuccin Macchiato",
		description: "Dark",
		bg: "#24273a",
		tags: ["cool", "muted", "pastel"],
	},
	{
		name: "catppuccin-mocha",
		label: "Catppuccin Mocha",
		description: "Deep dark",
		bg: "#1e1e2e",
		tags: ["warm", "muted", "pastel"],
	},
	// Classic dark themes
	{
		name: "dracula",
		label: "Dracula",
		description: "Dark purple",
		bg: "#282a36",
		tags: ["cool", "vibrant", "neon"],
	},
	{
		name: "github-dark",
		label: "GitHub Dark",
		description: "GitHub",
		bg: "#0d1117",
		tags: ["cool", "minimal", "high-contrast"],
	},
	{
		name: "gruvbox-dark",
		label: "Gruvbox Dark",
		description: "Retro",
		bg: "#282828",
		tags: ["warm", "earthy", "retro"],
	},
	{
		name: "nord",
		label: "Nord",
		description: "Arctic blue",
		bg: "#2e3440",
		tags: ["cool", "muted", "pastel"],
	},
	{
		name: "one-dark",
		label: "One Dark",
		description: "Atom",
		bg: "#282c34",
		tags: ["cool", "muted"],
	},
	{
		name: "rose-pine",
		label: "Rosé Pine",
		description: "Dark rose",
		bg: "#191724",
		tags: ["warm", "muted", "pastel"],
	},
	{
		name: "solarized-dark",
		label: "Solarized Dark",
		description: "Classic",
		bg: "#002b36",
		tags: ["warm", "earthy", "retro", "low-contrast"],
	},
	{
		name: "tokyo-night",
		label: "Tokyo Night",
		description: "Dark blue",
		bg: "#1a1b26",
		tags: ["cool", "vibrant", "neon"],
	},
	{
		name: "trash-panda",
		label: "Trash Panda",
		description: "JetBrains",
		bg: "#1e1e1e",
		tags: ["cool", "minimal"],
	},
	// Additional dark themes
	{
		name: "ayu-mirage",
		label: "Ayu Mirage",
		description: "Muted contrast",
		bg: "#1f2430",
		tags: ["cool", "muted"],
	},
	{
		name: "everforest-dark",
		label: "Everforest Dark",
		description: "Forest dusk",
		bg: "#272e33",
		tags: ["warm", "earthy", "muted"],
	},
	{
		name: "kanagawa-wave",
		label: "Kanagawa Wave",
		description: "Ink blue",
		bg: "#1f1f28",
		tags: ["warm", "muted", "earthy"],
	},
	{
		name: "material-ocean",
		label: "Material Ocean",
		description: "Oceanic",
		bg: "#0f111a",
		tags: ["cool", "vibrant", "high-contrast"],
	},
	{
		name: "monokai-pro",
		label: "Monokai Pro",
		description: "Vibrant dark",
		bg: "#2d2a2e",
		tags: ["warm", "vibrant", "retro"],
	},
	{
		name: "night-owl",
		label: "Night Owl",
		description: "Night blue",
		bg: "#011627",
		tags: ["cool", "vibrant", "high-contrast"],
	},
	{
		name: "oxocarbon-dark",
		label: "Oxocarbon Dark",
		description: "Carbon",
		bg: "#161616",
		tags: ["cool", "minimal", "high-contrast"],
	},
	{
		name: "poimandres",
		label: "Poimandres",
		description: "Cool neon",
		bg: "#1b1e28",
		tags: ["cool", "neon", "vibrant"],
	},
	{
		name: "vesper",
		label: "Vesper",
		description: "Nocturne",
		bg: "#101010",
		tags: ["warm", "minimal", "high-contrast"],
	},
	{
		name: "zenburn-dark",
		label: "Zenburn Dark",
		description: "Low-contrast",
		bg: "#3f3f3f",
		tags: ["warm", "earthy", "low-contrast", "retro"],
	},
	// New additions
	{
		name: "flexoki-dark",
		label: "Flexoki Dark",
		description: "Intentional warmth",
		bg: "#100f0f",
		tags: ["warm", "earthy", "low-contrast"],
	},
	{
		name: "palenight",
		label: "Palenight",
		description: "Material purple",
		bg: "#292d3e",
		tags: ["cool", "vibrant", "pastel"],
	},
	{
		name: "horizon",
		label: "Horizon",
		description: "Warm pink-orange",
		bg: "#1c1e26",
		tags: ["warm", "vibrant", "neon"],
	},
	{
		name: "synthwave-84",
		label: "Synthwave '84",
		description: "Neon retro",
		bg: "#262335",
		tags: ["warm", "neon", "retro", "vibrant"],
	},
	{
		name: "moonlight",
		label: "Moonlight",
		description: "Soft purple",
		bg: "#222436",
		tags: ["cool", "pastel", "muted"],
	},
	{
		name: "vitesse-dark",
		label: "Vitesse Dark",
		description: "Anthony Fu minimal",
		bg: "#121212",
		tags: ["cool", "minimal", "muted"],
	},
	{
		name: "mellow",
		label: "Mellow",
		description: "Warm minimal",
		bg: "#161617",
		tags: ["warm", "minimal", "muted"],
	},
	{
		name: "apprentice",
		label: "Apprentice",
		description: "Vim blue-grey",
		bg: "#1c1c1c",
		tags: ["cool", "earthy", "retro", "low-contrast"],
	},
	{
		name: "iceberg",
		label: "Iceberg",
		description: "Japanese frost",
		bg: "#161821",
		tags: ["cool", "low-contrast", "muted"],
	},
	{
		name: "bluloco-dark",
		label: "Bluloco Dark",
		description: "Vivid readable",
		bg: "#282c34",
		tags: ["cool", "vibrant", "pastel"],
	},
	{
		name: "modus-vivendi",
		label: "Modus Vivendi",
		description: "WCAG AAA accessible",
		bg: "#000000",
		tags: ["warm", "high-contrast", "minimal"],
	},
	{
		name: "spaceduck",
		label: "Spaceduck",
		description: "Space purple",
		bg: "#0f111b",
		tags: ["cool", "retro", "vibrant"],
	},
];

/** All unique tags across themes. */
const ALL_TAGS: readonly string[] = [...new Set(THEMES.flatMap((t) => t.tags))].sort();

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickRandom<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

/** Filter themes whose tags include ALL of the requested tags. */
function filterByTags(themes: readonly ThemeEntry[], tags: string[]): readonly ThemeEntry[] {
	return themes.filter((t) => tags.every((tag) => (t.tags as readonly string[]).includes(tag)));
}

/**
 * Read the `randomThemeOnStart` setting from settings.json.
 *
 * @returns `false` (disabled), `true` (pick from all), or `string[]` (filter by tags)
 */
function readRandomThemeSetting(): false | true | string[] {
	const settingsPath = join(homedir(), ".tallow", "settings.json");
	try {
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { randomThemeOnStart?: boolean | string[] };
		return settings.randomThemeOnStart ?? false;
	} catch {
		return false;
	}
}

/**
 * Persist theme selection to settings.json so it survives restarts.
 */
function persistTheme(themeName: string): void {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ??
		join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".tallow");
	const settingsPath = join(agentDir, "settings.json");
	try {
		let settings: Record<string, unknown> = {};
		if (existsSync(settingsPath)) {
			const raw = readFileSync(settingsPath, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = parsed as Record<string, unknown>;
			} else {
				console.error("theme-selector: settings.json is not an object, skipping persist");
				return;
			}
		}
		settings.theme = themeName;
		atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2), { backup: true });
	} catch (err) {
		console.error(`theme-selector: failed to persist theme: ${err}`);
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

/** Guards against re-rolling the theme on `/reload` (which re-fires session_start). */
let isInitialLaunch = true;

export default function (pi: ExtensionAPI) {
	// ── Random theme on fresh launch ─────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!isInitialLaunch) return;
		isInitialLaunch = false;

		if (!ctx.hasUI) return;

		const setting = readRandomThemeSetting();
		if (setting === false) return;

		const availableThemes = ctx.ui.getAllThemes();
		let pool: readonly ThemeEntry[] = THEMES.filter((t) =>
			availableThemes.some((at) => at.name === t.name)
		);

		if (Array.isArray(setting)) {
			pool = filterByTags(pool, setting);
			if (pool.length === 0) return; // no tag matches — keep persisted theme
		}

		if (pool.length === 0) return;

		const theme = pickRandom(pool);
		ctx.ui.setTheme(theme.name);
		// Intentionally NOT calling persistTheme() — random picks are ephemeral
	});

	pi.registerCommand("theme", {
		description:
			"Switch color theme. Usage: /theme [name|tag…|random [tag…]]. Tags: warm, cool, muted, vibrant, minimal, neon, earthy, retro, pastel, high-contrast, low-contrast",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			const availableThemes = ctx.ui.getAllThemes();
			const themesAvailable = THEMES.filter((t) =>
				availableThemes.some((at) => at.name === t.name)
			);

			if (themesAvailable.length === 0) {
				ctx.ui.notify("No themes found.", "error");
				return;
			}

			// ── Argument handling ────────────────────────────────────

			if (args?.trim()) {
				const tokens = args.trim().toLowerCase().split(/\s+/);
				const isRandom = tokens[0] === "random";
				const tagTokens = isRandom ? tokens.slice(1) : tokens;

				// Check if all tokens are tags (not a theme name lookup)
				const allAreTags = tagTokens.length > 0 && tagTokens.every((t) => ALL_TAGS.includes(t));

				if (isRandom || allAreTags) {
					// Tag-based filtering, then pick one
					const pool = allAreTags ? filterByTags(themesAvailable, tagTokens) : themesAvailable;

					if (pool.length === 0) {
						ctx.ui.notify(`No themes match tags: ${tagTokens.join(", ")}`, "error");
						return;
					}

					const theme = pickRandom(pool);
					const result = ctx.ui.setTheme(theme.name);
					if (result.success) {
						persistTheme(theme.name);
						const tagStr = theme.tags.join(", ");
						ctx.ui.notify(`Theme: ${theme.label} [${tagStr}]`, "info");
					} else {
						ctx.ui.notify(`Theme error: ${result.error}`, "error");
					}
					return;
				}

				// Direct name match
				const input = args.trim().toLowerCase();
				const theme = THEMES.find(
					(t) => t.name === input || t.name.includes(input) || t.label.toLowerCase().includes(input)
				);

				if (theme) {
					const result = ctx.ui.setTheme(theme.name);
					if (result.success) {
						persistTheme(theme.name);
						ctx.ui.notify(`Theme: ${theme.label}`, "info");
					} else {
						ctx.ui.notify(`Theme error: ${result.error}`, "error");
					}
				} else {
					ctx.ui.notify(`Unknown theme or tag: ${input}`, "error");
				}
				return;
			}

			// ── Interactive picker ───────────────────────────────────

			const originalThemeName = ctx.ui.theme?.name;

			let selectedIndex = themesAvailable.findIndex((t) => t.name === originalThemeName);
			if (selectedIndex === -1) selectedIndex = 0;

			const result = await ctx.ui.custom<string | null>(
				(tui, _theme, _kb, done) => {
					const container = new Container();

					const applyTheme = (index: number): void => {
						const t = themesAvailable[index];
						ctx.ui.setTheme(t.name);
						tui.requestRender();
					};

					applyTheme(selectedIndex);

					return {
						render(width: number): string[] {
							container.clear();
							const theme = ctx.ui.theme;

							container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
							container.addChild(new Text(theme.fg("accent", theme.bold(" Select Theme")), 1, 0));

							for (let i = 0; i < themesAvailable.length; i++) {
								const t = themesAvailable[i];
								const isSelected = i === selectedIndex;
								const prefix = isSelected ? "│ ❯ " : "│   ";
								const tagStr = t.tags.join(", ");
								const label = `${t.label} — ${t.description} [${tagStr}]`;
								const line = isSelected
									? theme.fg("accent", prefix + theme.bold(label))
									: theme.fg("text", prefix + label);
								container.addChild(new Text(line, 0, 0));
							}

							container.addChild(
								new Text(theme.fg("dim", "│ ↑↓ preview • enter apply • esc cancel"), 0, 0)
							);
							container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

							return container.render(width);
						},

						handleInput(data: string): void {
							if (matchesKey(data, Key.up)) {
								selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : themesAvailable.length - 1;
								applyTheme(selectedIndex);
							} else if (matchesKey(data, Key.down)) {
								selectedIndex = selectedIndex < themesAvailable.length - 1 ? selectedIndex + 1 : 0;
								applyTheme(selectedIndex);
							} else if (matchesKey(data, Key.enter)) {
								done(themesAvailable[selectedIndex].name);
							} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
								if (originalThemeName) ctx.ui.setTheme(originalThemeName);
								done(null);
							}
						},

						invalidate(): void {
							container.invalidate();
						},
					};
				},
				{ overlay: true }
			);

			if (result) {
				persistTheme(result);
				const theme = themesAvailable.find((t) => t.name === result);
				if (theme) {
					ctx.ui.notify(`Theme: ${theme.label}`, "info");
				}
			} else {
				if (originalThemeName) ctx.ui.setTheme(originalThemeName);
			}
		},
		getArgumentCompletions: (prefix) => {
			const lower = prefix.toLowerCase();
			// Suggest theme names and tags
			const nameMatches = THEMES.filter((t) => t.name.includes(lower)).map((t) => ({
				value: t.name,
				label: `${t.name} — ${t.tags.join(", ")}`,
			}));
			const tagMatches = ALL_TAGS.filter((t) => t.includes(lower)).map((t) => ({
				value: t,
				label: `[tag] ${t}`,
			}));
			const special = [{ value: "random", label: "random — pick a random theme" }].filter((s) =>
				s.value.includes(lower)
			);
			const all = [...special, ...tagMatches, ...nameMatches];
			return all.length > 0 ? all : null;
		},
	});

	// ── LLM-callable tool ────────────────────────────────────────

	const SwitchThemeParams = Type.Object({
		name: Type.Optional(
			Type.String({
				description: `Exact theme name. Available: ${THEMES.map((t) => t.name).join(", ")}`,
			})
		),
		tags: Type.Optional(
			Type.Array(
				Type.String({
					description: `Filter tag. Available: ${ALL_TAGS.join(", ")}`,
				}),
				{ description: "Filter themes by tags (AND logic). A random match is applied." }
			)
		),
		random: Type.Optional(
			Type.Boolean({
				description: "Pick a random theme (optionally filtered by tags). Default: false",
			})
		),
	});

	pi.registerTool({
		name: "switch_theme",
		label: "Switch Theme",
		description: `Switch the editor color theme by name, by mood tags, or randomly.

WHEN TO USE:
- User asks to change the theme ("give me a warm theme", "something cooler", "random theme")
- User describes a mood or vibe for their editor

EXAMPLES:
- { "name": "dracula" } — switch to Dracula
- { "tags": ["warm", "earthy"] } — random warm earthy theme
- { "random": true } — any random theme
- { "random": true, "tags": ["cool"] } — random cool theme

Available tags: ${ALL_TAGS.join(", ")}`,
		parameters: SwitchThemeParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const makeResult = (text: string, theme?: ThemeEntry) => ({
				content: [{ type: "text" as const, text }],
				details: { theme: theme?.name ?? null, tags: theme?.tags ?? [] },
			});

			if (!ctx.hasUI) {
				return makeResult("Error: UI not available (non-interactive mode)");
			}

			const availableThemes = ctx.ui.getAllThemes();
			const pool = THEMES.filter((t) => availableThemes.some((at) => at.name === t.name));

			if (pool.length === 0) {
				return makeResult("No themes available.");
			}

			// Direct name match
			if (params.name) {
				const theme = pool.find((t) => t.name === params.name);
				if (!theme) {
					return makeResult(
						`Unknown theme: ${params.name}. Available: ${pool.map((t) => t.name).join(", ")}`
					);
				}
				const result = ctx.ui.setTheme(theme.name);
				if (!result.success) {
					return makeResult(`Failed: ${result.error}`);
				}
				persistTheme(theme.name);
				return makeResult(
					`Switched to ${theme.label} (${theme.description}) [${theme.tags.join(", ")}]`,
					theme
				);
			}

			// Tag filtering + random
			let filtered: readonly ThemeEntry[] = pool;
			if (params.tags && params.tags.length > 0) {
				filtered = filterByTags(pool, params.tags);
				if (filtered.length === 0) {
					return makeResult(
						`No themes match tags: ${params.tags.join(", ")}. Available tags: ${ALL_TAGS.join(", ")}`
					);
				}
			}

			const theme = pickRandom(filtered);
			const result = ctx.ui.setTheme(theme.name);
			if (!result.success) {
				return makeResult(`Failed: ${result.error}`);
			}
			persistTheme(theme.name);
			return makeResult(
				`Switched to ${theme.label} (${theme.description}) [${theme.tags.join(", ")}]`,
				theme
			);
		},
	});
}
