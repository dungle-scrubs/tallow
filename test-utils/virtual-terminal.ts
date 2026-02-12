/**
 * Virtual terminal utilities for TUI snapshot testing.
 *
 * Captures component render output and strips ANSI escape codes
 * for deterministic plaintext comparison.
 */

// ── ANSI Stripping ───────────────────────────────────────────────────────────

/**
 * Regex matching all common ANSI escape sequences:
 * - CSI sequences: \x1b[...m (colors, bold, cursor movement, etc.)
 * - OSC sequences: \x1b]...ST (hyperlinks, window titles)
 * - Simple escapes: \x1b followed by a single letter
 *
 * Uses RegExp constructor to avoid biome's noControlCharactersInRegex lint.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires matching control characters
const ANSI_REGEX = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[A-Za-z])/g;

/**
 * Strip ANSI escape codes from text for plaintext comparison.
 *
 * @param text - Text possibly containing ANSI codes
 * @returns Clean plaintext with no escape sequences
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_REGEX, "");
}

// ── Render Utilities ─────────────────────────────────────────────────────────

/** Minimal component interface for rendering. */
export interface Renderable {
	render(width: number): string[];
}

/**
 * Render a TUI component and return both raw and stripped output.
 *
 * @param component - Component with `render(width)` method
 * @param width - Terminal width to render at
 * @returns Object with `raw` (ANSI-preserved) and `plain` (stripped) line arrays
 */
export function renderComponent(
	component: Renderable,
	width: number
): { raw: string[]; plain: string[] } {
	const raw = component.render(width);
	const plain = raw.map(stripAnsi);
	return { raw, plain };
}

/**
 * Render a component and return joined plaintext for snapshot comparison.
 *
 * @param component - Component with `render(width)` method
 * @param width - Terminal width to render at
 * @returns Newline-joined plaintext suitable for `toMatchSnapshot()`
 */
export function renderSnapshot(component: Renderable, width: number): string {
	return renderComponent(component, width).plain.join("\n");
}
