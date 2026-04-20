import { describe, expect, it } from "bun:test";
import type { TUI } from "@mariozechner/pi-tui";
import {
	Editor,
	type EditorTheme,
	SettingsList,
	type SettingsListTheme,
} from "@mariozechner/pi-tui";
import { applyPiTuiPatches } from "../pi-tui-patch.js";

function createMockTUI(): TUI {
	return {
		requestRender: () => {},
		terminal: { rows: 40, cols: 80 },
	} as unknown as TUI;
}

const editorTheme: EditorTheme = {
	borderColor: (s: string) => s,
	selectList: {
		descriptionFg: (s: string) => s,
		matchHighlight: (s: string) => s,
		normalBg: (s: string) => s,
		normalFg: (s: string) => s,
		selectedBg: (s: string) => s,
		selectedFg: (s: string) => s,
	},
};

const settingsTheme: SettingsListTheme = {
	cursor: "> ",
	description: (text) => text,
	hint: (text) => text,
	label: (text) => text,
	value: (text) => text,
};

describe("applyPiTuiPatches", () => {
	it("adds editor ghost-text and change-listener support on top of upstream pi-tui", async () => {
		await applyPiTuiPatches();
		const editor = new Editor(createMockTUI(), editorTheme) as Editor & {
			addChangeListener(fn: (text: string) => void): void;
			getGhostText(): string | null;
			setGhostText(text: string | null): void;
		};
		const received: string[] = [];
		editor.addChangeListener((text) => received.push(text));

		expect(editor.getGhostText()).toBeNull();
		editor.setGhostText("complete me");
		expect(editor.getGhostText()).toBe("complete me");
		expect(editor.render(80).join("\n")).toContain("\x1b[38;5;242mcomplete me\x1b[0m");

		editor.handleInput("\t");
		expect(editor.getGhostText()).toBeNull();
		expect(editor.getText()).toBe("complete me");
		expect(received).toEqual(["complete me"]);

		let submitted = "";
		editor.setText("");
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setGhostText("suggested prompt");
		editor.handleInput("\r");
		expect(submitted).toBe("suggested prompt");

		editor.setGhostText("dismiss me");
		editor.handleInput("a");
		expect(editor.getGhostText()).toBeNull();
	});

	it("adds settings submenu transition preservation on top of upstream pi-tui", async () => {
		await applyPiTuiPatches();
		let changedValue: string | undefined;
		const list = new SettingsList(
			[
				{
					id: "thinking",
					label: "Thinking level",
					currentValue: "medium",
					description: "Reasoning depth",
					submenu: (_currentValue, done) => ({
						handleInput: () => done("high"),
						invalidate: () => {},
						render: () => ["submenu", "", "one", "two", "three", "four", "five", "six"],
					}),
				},
			],
			10,
			settingsTheme,
			(_id, newValue) => {
				changedValue = newValue;
			},
			() => {}
		) as SettingsList & { setLayoutTransitionCallback?: (callback?: () => void) => void };
		const transitions: string[] = [];
		list.setLayoutTransitionCallback?.(() => {
			transitions.push("transition");
		});

		const initialLines = list.render(80);
		list.handleInput(" ");
		const submenuLines = list.render(80);
		list.handleInput("x");
		const firstFrameAfterClose = list.render(80);
		const secondFrameAfterClose = list.render(80);

		expect(changedValue).toBe("high");
		expect(transitions).toEqual(["transition", "transition"]);
		expect(submenuLines.length).toBeGreaterThan(initialLines.length);
		expect(firstFrameAfterClose.length).toBe(submenuLines.length);
		expect(secondFrameAfterClose.length).toBe(initialLines.length);
	});
});
