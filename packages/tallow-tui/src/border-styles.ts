/**
 * Border character sets for box-drawing.
 *
 * @module
 */

/** A set of box-drawing characters for rendering borders. */
export interface BorderStyle {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
}

/** Sharp corners — standard box-drawing (┌┐└┘). */
export const SHARP: BorderStyle = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
};

/** Rounded corners — Unicode arc box-drawing (╭╮╰╯). */
export const ROUNDED: BorderStyle = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
};

/** Flat — horizontal rules only, no corners or verticals. */
export const FLAT: BorderStyle = {
	topLeft: "─",
	topRight: "─",
	bottomLeft: "─",
	bottomRight: "─",
	horizontal: "─",
	vertical: " ",
};

/**
 * Global default border style — set once, applies to all new BorderedBox instances.
 * Extensions can set this at session_start to override.
 */
export let defaultBorderStyle: BorderStyle = SHARP;

/**
 * Set the global default border style.
 *
 * @param style - Border style to use as default
 */
export function setDefaultBorderStyle(style: BorderStyle): void {
	defaultBorderStyle = style;
}
