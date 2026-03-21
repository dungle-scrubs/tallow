import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import minimalSkillDisplay from "../index.js";

describe("minimal-skill-display extension", () => {
	test("registers session_start and input handlers", () => {
		const events: string[] = [];
		const pi = {
			on: (event: string) => {
				events.push(event);
			},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
		} as unknown as ExtensionAPI;

		minimalSkillDisplay(pi);
		expect(events).toContain("session_start");
		expect(events).toContain("input");
	});
});
