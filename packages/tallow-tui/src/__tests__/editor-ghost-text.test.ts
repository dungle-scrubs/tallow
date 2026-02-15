/**
 * Tests for Editor ghost text (inline suggestion) functionality.
 *
 * Uses a minimal TUI mock since Editor requires a TUI instance.
 */
import { describe, expect, test } from "bun:test";
import { Editor, type EditorTheme } from "../components/editor.js";
import type { TUI } from "../tui.js";

/** Minimal TUI mock providing only what Editor needs. */
function createMockTUI(): TUI {
	return {
		requestRender: () => {},
		terminal: { rows: 40, cols: 80 },
	} as unknown as TUI;
}

const theme: EditorTheme = {
	borderColor: (s: string) => s,
	selectList: {
		selectedBg: (s: string) => s,
		selectedFg: (s: string) => s,
		normalBg: (s: string) => s,
		normalFg: (s: string) => s,
		matchHighlight: (s: string) => s,
		descriptionFg: (s: string) => s,
	},
};

describe("Editor ghost text", () => {
	test("setGhostText stores and getGhostText retrieves", () => {
		const editor = new Editor(createMockTUI(), theme);
		expect(editor.getGhostText()).toBeNull();
		editor.setGhostText("hello world");
		expect(editor.getGhostText()).toBe("hello world");
	});

	test("setGhostText(null) clears ghost text", () => {
		const editor = new Editor(createMockTUI(), theme);
		editor.setGhostText("suggestion");
		editor.setGhostText(null);
		expect(editor.getGhostText()).toBeNull();
	});

	test("ghost text renders as dim ANSI after cursor", () => {
		const editor = new Editor(createMockTUI(), theme);
		editor.setGhostText("complete me");
		const lines = editor.render(80);
		// Ghost text should appear as muted gray (256-color 242) in the output
		const joined = lines.join("\n");
		expect(joined).toContain("\x1b[38;5;242m");
		expect(joined).toContain("complete me");
	});

	test("ghost text cleared when character is typed", () => {
		const editor = new Editor(createMockTUI(), theme);
		editor.setGhostText("suggestion");
		editor.handleInput("a");
		expect(editor.getGhostText()).toBeNull();
	});

	test("ghost text cleared on backspace", () => {
		const editor = new Editor(createMockTUI(), theme);
		editor.setText("hello");
		editor.setGhostText("world");
		// Backspace (DEL character)
		editor.handleInput("\x7f");
		expect(editor.getGhostText()).toBeNull();
	});

	test("Tab accepts ghost text into buffer", () => {
		const editor = new Editor(createMockTUI(), theme);
		editor.setGhostText("complete me");
		// Tab
		editor.handleInput("\t");
		expect(editor.getGhostText()).toBeNull();
		expect(editor.getText()).toBe("complete me");
	});

	test("Enter on empty input accepts ghost text and submits", () => {
		const editor = new Editor(createMockTUI(), theme);
		let submitted = "";
		editor.onSubmit = (text: string) => {
			submitted = text;
		};
		editor.setGhostText("suggested prompt");
		// Enter (carriage return)
		editor.handleInput("\r");
		expect(submitted).toBe("suggested prompt");
		expect(editor.getGhostText()).toBeNull();
	});

	test("Enter on non-empty input submits typed text, not ghost text", () => {
		const editor = new Editor(createMockTUI(), theme);
		let submitted = "";
		editor.onSubmit = (text: string) => {
			submitted = text;
		};
		editor.setText("my input");
		editor.setGhostText("ghost suggestion");
		editor.handleInput("\r");
		expect(submitted).toBe("my input");
	});

	test("Escape dismisses ghost text", () => {
		const editor = new Editor(createMockTUI(), theme);
		editor.setGhostText("suggestion");
		// Escape
		editor.handleInput("\x1b");
		expect(editor.getGhostText()).toBeNull();
	});
});
