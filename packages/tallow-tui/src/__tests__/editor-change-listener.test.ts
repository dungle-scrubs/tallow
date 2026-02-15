/**
 * Tests for Editor.addChangeListener — ensures change listeners fire
 * alongside onChange without interfering with each other.
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

/** Simulate typing a string character by character. */
function typeText(editor: Editor, text: string): void {
	for (const char of text) {
		editor.handleInput(char);
	}
}

describe("Editor.addChangeListener", () => {
	test("listener fires on character input", () => {
		const editor = new Editor(createMockTUI(), theme);
		const received: string[] = [];
		editor.addChangeListener((text) => received.push(text));

		typeText(editor, "hi");
		expect(received).toEqual(["h", "hi"]);
	});

	test("listener fires alongside onChange", () => {
		const editor = new Editor(createMockTUI(), theme);
		const onChangeCalls: string[] = [];
		const listenerCalls: string[] = [];

		editor.onChange = (text) => onChangeCalls.push(text);
		editor.addChangeListener((text) => listenerCalls.push(text));

		typeText(editor, "ab");
		expect(onChangeCalls).toEqual(["a", "ab"]);
		expect(listenerCalls).toEqual(["a", "ab"]);
	});

	test("overwriting onChange does not affect listener", () => {
		const editor = new Editor(createMockTUI(), theme);
		const listenerCalls: string[] = [];

		editor.addChangeListener((text) => listenerCalls.push(text));

		// Simulate framework overwriting onChange
		editor.onChange = () => {};
		editor.onChange = () => {};

		typeText(editor, "x");
		expect(listenerCalls).toEqual(["x"]);
	});

	test("multiple listeners all fire", () => {
		const editor = new Editor(createMockTUI(), theme);
		const calls1: string[] = [];
		const calls2: string[] = [];
		const calls3: string[] = [];

		editor.addChangeListener((text) => calls1.push(text));
		editor.addChangeListener((text) => calls2.push(text));
		editor.addChangeListener((text) => calls3.push(text));

		typeText(editor, "z");
		expect(calls1).toEqual(["z"]);
		expect(calls2).toEqual(["z"]);
		expect(calls3).toEqual(["z"]);
	});

	test("listener fires on backspace", () => {
		const editor = new Editor(createMockTUI(), theme);
		const received: string[] = [];
		editor.addChangeListener((text) => received.push(text));

		typeText(editor, "ab");
		editor.handleInput("\x7f"); // backspace
		expect(received).toEqual(["a", "ab", "a"]);
	});

	test("listener fires on setText", () => {
		const editor = new Editor(createMockTUI(), theme);
		const received: string[] = [];
		editor.addChangeListener((text) => received.push(text));

		editor.setText("hello world");
		expect(received).toEqual(["hello world"]);
	});

	test("listener fires on submit (text cleared)", () => {
		const editor = new Editor(createMockTUI(), theme);
		const received: string[] = [];
		editor.addChangeListener((text) => received.push(text));
		editor.onSubmit = () => {}; // prevent default submit behavior

		typeText(editor, "test");
		received.length = 0; // clear typing events

		editor.handleInput("\r"); // Enter/submit
		// After submit, editor text is cleared — listener gets ""
		expect(received).toContain("");
	});
});
