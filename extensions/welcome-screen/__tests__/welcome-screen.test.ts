import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import welcomeScreen from "../index.js";

describe("welcome-screen extension", () => {
	test("registers session_start handler", () => {
		const events: string[] = [];
		const pi = {
			on: (event: string) => {
				events.push(event);
			},
		} as unknown as ExtensionAPI;

		welcomeScreen(pi);
		expect(events).toContain("session_start");
	});

	test("does not register any commands or tools", () => {
		const commands: string[] = [];
		const tools: string[] = [];
		const pi = {
			on: () => {},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			registerTool: (opts: { name: string }) => {
				tools.push(opts.name);
			},
		} as unknown as ExtensionAPI;

		welcomeScreen(pi);
		expect(commands).toHaveLength(0);
		expect(tools).toHaveLength(0);
	});
});
