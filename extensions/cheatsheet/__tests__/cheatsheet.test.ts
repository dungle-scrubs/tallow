import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import cheatsheet from "../index.js";

describe("cheatsheet extension", () => {
	function collectRegistrations() {
		const commands: Array<{ name: string; description: string }> = [];
		const pi = {
			registerCommand: (name: string, opts: { description: string }) => {
				commands.push({ name, description: opts.description });
			},
			registerMessageRenderer: () => {},
			registerShortcut: () => {},
			on: () => {},
		} as unknown as ExtensionAPI;

		cheatsheet(pi);
		return { commands };
	}

	test("registers /cheatsheet command", () => {
		const { commands } = collectRegistrations();
		expect(commands.some((c) => c.name === "cheatsheet")).toBe(true);
	});

	test("registers /keys alias", () => {
		const { commands } = collectRegistrations();
		expect(commands.some((c) => c.name === "keys")).toBe(true);
	});

	test("registers /keymap alias", () => {
		const { commands } = collectRegistrations();
		expect(commands.some((c) => c.name === "keymap")).toBe(true);
	});

	test("registers /keybindings alias", () => {
		const { commands } = collectRegistrations();
		expect(commands.some((c) => c.name === "keybindings")).toBe(true);
	});

	test("all aliases have descriptions", () => {
		const { commands } = collectRegistrations();
		for (const cmd of commands) {
			expect(cmd.description.length).toBeGreaterThan(0);
		}
	});
});
