import { describe, expect, it } from "bun:test";
import { SettingsList, type SettingsListTheme } from "../components/settings-list.js";

const theme: SettingsListTheme = {
	cursor: "> ",
	description: (text) => text,
	hint: (text) => text,
	label: (text) => text,
	value: (text) => text,
};

describe("SettingsList submenu transitions", () => {
	it("preserves submenu height for one frame when closing back to the main list", () => {
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
			theme,
			(_id, newValue) => {
				changedValue = newValue;
			},
			() => {}
		);

		const initialLines = list.render(80);
		list.handleInput(" ");
		const submenuLines = list.render(80);
		list.handleInput("x");
		const firstFrameAfterClose = list.render(80);
		const secondFrameAfterClose = list.render(80);

		expect(changedValue).toBe("high");
		expect(submenuLines.length).toBeGreaterThan(initialLines.length);
		expect(firstFrameAfterClose.length).toBe(submenuLines.length);
		expect(secondFrameAfterClose.length).toBe(initialLines.length);
	});

	it("fires the layout transition callback when opening and closing a submenu", () => {
		const list = new SettingsList(
			[
				{
					id: "thinking",
					label: "Thinking level",
					currentValue: "medium",
					submenu: (_currentValue, done) => ({
						handleInput: () => done("high"),
						invalidate: () => {},
						render: () => ["submenu", "one", "two"],
					}),
				},
			],
			10,
			theme,
			() => {},
			() => {}
		);
		const transitions: string[] = [];
		list.setLayoutTransitionCallback(() => {
			transitions.push("transition");
		});

		list.render(80);
		list.handleInput(" ");
		list.render(80);
		list.handleInput("x");

		expect(transitions).toEqual(["transition", "transition"]);
	});
});
