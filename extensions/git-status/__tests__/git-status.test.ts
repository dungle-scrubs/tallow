import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import gitStatus from "../index.js";

describe("git-status extension", () => {
	test("registers session_start, tool_result, and session_shutdown handlers", () => {
		const events: string[] = [];
		const pi = {
			on: (event: string) => {
				events.push(event);
			},
		} as unknown as ExtensionAPI;

		gitStatus(pi);
		expect(events).toContain("session_start");
		expect(events).toContain("tool_result");
		expect(events).toContain("session_shutdown");
	});

	test("does not register any commands", () => {
		const commands: string[] = [];
		const pi = {
			on: () => {},
			registerCommand: (name: string) => {
				commands.push(name);
			},
		} as unknown as ExtensionAPI;

		gitStatus(pi);
		expect(commands).toHaveLength(0);
	});
});
