/**
 * Regression tests for editor border rendering.
 *
 * Ensures the editor always renders a top and bottom border row,
 * including focused state with empty and multiline content.
 */
import { describe, expect, test } from "bun:test";
import { Editor, type EditorTheme } from "../components/editor.js";
import type { TUI } from "../tui.js";

/**
 * Create a minimal TUI mock that provides only what Editor needs.
 *
 * @param rows - Terminal row count for viewport calculations
 * @param cols - Terminal column count
 * @returns Minimal TUI instance
 */
function createMockTUI(rows: number = 40, cols: number = 80): TUI {
	return {
		requestRender: () => {},
		terminal: { rows, cols },
	} as unknown as TUI;
}

const theme: EditorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		descriptionFg: (text: string) => text,
		matchHighlight: (text: string) => text,
		normalBg: (text: string) => text,
		normalFg: (text: string) => text,
		selectedBg: (text: string) => text,
		selectedFg: (text: string) => text,
	},
};

/**
 * Assert that rendered editor output starts and ends with full border rows.
 *
 * @param renderedLines - Editor render output
 * @param width - Render width used for the editor
 * @returns void
 */
function expectTopAndBottomBorders(renderedLines: readonly string[], width: number): void {
	expect(renderedLines.length).toBeGreaterThanOrEqual(2);
	expect(renderedLines[0]).toBe("─".repeat(width));
	expect(renderedLines[renderedLines.length - 1]).toBe("─".repeat(width));
}

describe("Editor border rendering", () => {
	test("always includes top and bottom border rows for empty content", () => {
		const editor = new Editor(createMockTUI(), theme);
		editor.focused = true;

		const width = 32;
		const renderedLines = editor.render(width);

		expectTopAndBottomBorders(renderedLines, width);
	});

	test("always includes top and bottom border rows for non-empty multiline content", () => {
		const editor = new Editor(createMockTUI(), theme);
		editor.focused = true;
		editor.setText("first line\nsecond line\nthird line");

		const width = 32;
		const renderedLines = editor.render(width);

		expect(renderedLines.length).toBeGreaterThanOrEqual(5);
		expectTopAndBottomBorders(renderedLines, width);
	});
});
