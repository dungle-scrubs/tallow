import { describe, expect, test } from "bun:test";
import { setPathListEnv } from "../sdk.js";

describe("setPathListEnv", () => {
	test("replaces stale values instead of appending", () => {
		const env: NodeJS.ProcessEnv = {
			TALLOW_PLUGIN_COMMANDS_DIRS: "/old/plugin/commands",
		};

		setPathListEnv("TALLOW_PLUGIN_COMMANDS_DIRS", ["/new/plugin-a/commands"], env);
		expect(env.TALLOW_PLUGIN_COMMANDS_DIRS).toBe("/new/plugin-a/commands");
	});

	test("deduplicates values while preserving first-seen order", () => {
		const env: NodeJS.ProcessEnv = {};

		setPathListEnv(
			"TALLOW_PLUGIN_AGENTS_DIRS",
			["/plugin-a/agents", "/plugin-a/agents", "/plugin-b/agents"],
			env
		);
		expect(env.TALLOW_PLUGIN_AGENTS_DIRS).toBe("/plugin-a/agents:/plugin-b/agents");
	});

	test("clears the env var when no values remain", () => {
		const env: NodeJS.ProcessEnv = {
			TALLOW_PLUGIN_COMMANDS_DIRS: "/stale/plugin/commands",
		};

		setPathListEnv("TALLOW_PLUGIN_COMMANDS_DIRS", [], env);
		expect(env.TALLOW_PLUGIN_COMMANDS_DIRS).toBeUndefined();
	});
});
