import { describe, expect, test } from "bun:test";

// ── Inline copies of theme data + helpers ────────────────────
// We duplicate the minimal subset here to avoid importing the extension
// (which has side-effect-heavy pi imports). If the source THEMES array
// changes, update this file too.

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

const ALL_TAGS: readonly string[] = [...new Set(THEMES.flatMap((t) => t.tags))].sort();

function filterByTags(themes: readonly ThemeEntry[], tags: string[]): readonly ThemeEntry[] {
	return themes.filter((t) => tags.every((tag) => (t.tags as readonly string[]).includes(tag)));
}

function pickRandom<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

// ── Tests ────────────────────────────────────────────────────

describe("filterByTags", () => {
	test("single tag returns matching themes", () => {
		const warm = filterByTags(THEMES, ["warm"]);
		expect(warm.length).toBeGreaterThan(0);
		for (const t of warm) {
			expect(t.tags).toContain("warm");
		}
	});

	test("multiple tags use AND logic", () => {
		const warmEarthy = filterByTags(THEMES, ["warm", "earthy"]);
		expect(warmEarthy.length).toBeGreaterThan(0);
		for (const t of warmEarthy) {
			expect(t.tags).toContain("warm");
			expect(t.tags).toContain("earthy");
		}
	});

	test("impossible combination returns empty", () => {
		const result = filterByTags(THEMES, ["warm", "cool"]);
		expect(result).toHaveLength(0);
	});

	test("empty tags returns all themes", () => {
		const result = filterByTags(THEMES, []);
		expect(result).toHaveLength(THEMES.length);
	});

	test("cool themes exclude warm themes", () => {
		const cool = filterByTags(THEMES, ["cool"]);
		const warm = filterByTags(THEMES, ["warm"]);
		const coolNames = new Set(cool.map((t) => t.name));
		for (const t of warm) {
			expect(coolNames.has(t.name)).toBe(false);
		}
	});
});

describe("ALL_TAGS", () => {
	test("contains expected tags", () => {
		expect(ALL_TAGS).toContain("warm");
		expect(ALL_TAGS).toContain("cool");
		expect(ALL_TAGS).toContain("muted");
		expect(ALL_TAGS).toContain("vibrant");
		expect(ALL_TAGS).toContain("minimal");
		expect(ALL_TAGS).toContain("neon");
		expect(ALL_TAGS).toContain("earthy");
		expect(ALL_TAGS).toContain("retro");
		expect(ALL_TAGS).toContain("pastel");
		expect(ALL_TAGS).toContain("high-contrast");
		expect(ALL_TAGS).toContain("low-contrast");
	});

	test("every theme has at least one tag", () => {
		for (const t of THEMES) {
			expect(t.tags.length).toBeGreaterThan(0);
		}
	});

	test("every tag is used by at least one theme", () => {
		for (const tag of ALL_TAGS) {
			const matches = THEMES.filter((t) => (t.tags as readonly string[]).includes(tag));
			expect(matches.length).toBeGreaterThan(0);
		}
	});
});

describe("pickRandom", () => {
	test("returns an element from the array", () => {
		const arr = [1, 2, 3, 4, 5];
		const result = pickRandom(arr);
		expect(arr).toContain(result);
	});

	test("works with single element", () => {
		expect(pickRandom([42])).toBe(42);
	});

	test("random warm theme has warm tag", () => {
		const warm = filterByTags(THEMES, ["warm"]);
		const theme = pickRandom(warm);
		expect(theme.tags).toContain("warm");
	});
});

describe("theme coverage", () => {
	test("warm and cool together cover all themes", () => {
		const warm = filterByTags(THEMES, ["warm"]);
		const cool = filterByTags(THEMES, ["cool"]);
		// Every theme should be warm or cool
		expect(warm.length + cool.length).toBe(THEMES.length);
	});

	test("known warm themes", () => {
		const warm = filterByTags(THEMES, ["warm"]).map((t) => t.name);
		expect(warm).toContain("gruvbox-dark");
		expect(warm).toContain("everforest-dark");
		expect(warm).toContain("monokai-pro");
		expect(warm).toContain("solarized-dark");
		expect(warm).toContain("zenburn-dark");
	});

	test("known cool themes", () => {
		const cool = filterByTags(THEMES, ["cool"]).map((t) => t.name);
		expect(cool).toContain("nord");
		expect(cool).toContain("dracula");
		expect(cool).toContain("tokyo-night");
		expect(cool).toContain("github-dark");
	});
});
