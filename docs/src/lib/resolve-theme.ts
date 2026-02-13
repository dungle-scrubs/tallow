/**
 * Build-time utility for resolving theme JSON semantic tokens
 * to flat hex color maps for the Quick Start terminal widget.
 */

/** Resolved hex color map for the Quick Start terminal widget CSS custom properties. */
export interface ThemeColors {
	/** Widget content background — theme's primary bg */
	bg: string;
	/** Title bar background — secondary surface (userMessageBg) */
	bgDark: string;
	/** Widget border color */
	border: string;
	/** Default text color */
	text: string;
	/** Muted/label text color */
	muted: string;
	/** Command keyword color (git, cd, node) */
	keyword: string;
	/** String literal color */
	string: string;
	/** Function name color (npm, clone) */
	function: string;
	/** Accent color for decorative elements */
	accent: string;
}

/** Raw theme JSON shape (subset of fields used by the resolver). */
interface ThemeJson {
	name: string;
	vars: Record<string, string>;
	colors: Record<string, string>;
}

/**
 * Common var names for the primary background across theme naming conventions.
 * Each theme family uses a different key for its canonical dark background:
 * most use "bg", Catppuccin/Rosé Pine use "base", Solarized "base03", Nord "nord0".
 */
const PRIMARY_BG_KEYS = ["bg", "base", "base03", "nord0"] as const;

/**
 * Resolves a semantic color key through the theme's colors→vars chain.
 *
 * @param theme - Parsed theme JSON
 * @param semanticKey - Key in theme.colors (e.g. 'userMessageBg')
 * @returns Resolved hex color string, or '#000000' if unresolvable
 */
function resolveSemanticColor(theme: ThemeJson, semanticKey: string): string {
	const varRef = theme.colors[semanticKey];
	if (!varRef) return "#000000";
	return theme.vars[varRef] ?? "#000000";
}

/**
 * Finds the primary background color by trying common var names.
 * Different theme families use different naming conventions.
 *
 * @param vars - Theme variable map
 * @returns Hex color string, or '#000000' if no convention matches
 */
function findPrimaryBg(vars: Record<string, string>): string {
	for (const key of PRIMARY_BG_KEYS) {
		if (vars[key]) return vars[key];
	}
	return "#000000";
}

/**
 * Resolves a theme JSON's semantic tokens into a flat hex color map
 * for the Quick Start terminal widget's CSS custom properties.
 *
 * Resolution chain: colors[semanticKey] → vars[varRef] → hex string.
 * Primary bg uses convention-based lookup across theme families.
 *
 * @param theme - Parsed theme JSON object with vars and colors
 * @returns Flat map of 9 resolved hex values
 */
export function resolveThemeColors(theme: ThemeJson): ThemeColors {
	return {
		bg: findPrimaryBg(theme.vars),
		bgDark: resolveSemanticColor(theme, "userMessageBg"),
		border: resolveSemanticColor(theme, "border"),
		text: resolveSemanticColor(theme, "text"),
		muted: resolveSemanticColor(theme, "muted"),
		keyword: resolveSemanticColor(theme, "syntaxKeyword"),
		string: resolveSemanticColor(theme, "syntaxString"),
		function: resolveSemanticColor(theme, "syntaxFunction"),
		accent: resolveSemanticColor(theme, "accent"),
	};
}
