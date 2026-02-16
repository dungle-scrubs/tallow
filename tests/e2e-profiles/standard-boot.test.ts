/**
 * E2E: Standard profile boot test.
 *
 * Verifies the typical user extension set loads cleanly and all
 * productivity features (tasks, subagents, LSP, debug, etc.) register.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	createProfileSession,
	createScriptedStreamFn,
	getHandlerCounts,
	getRegisteredCommandNames,
	getRegisteredToolNames,
	type ProfileSession,
} from "./profile-runner.js";
import { STANDARD_EXTENSIONS } from "./profiles.js";

let session: ProfileSession | undefined;

afterEach(() => {
	session?.dispose();
	session = undefined;
});

describe("Standard Profile", () => {
	it("loads all standard extensions without errors", async () => {
		session = await createProfileSession({ extensions: STANDARD_EXTENSIONS });

		expect(session.tallow.extensions.errors).toEqual([]);
		expect(session.tallow.extensions.extensions.length).toBeGreaterThanOrEqual(
			STANDARD_EXTENSIONS.length
		);
	});

	it("registers productivity tools", async () => {
		session = await createProfileSession({ extensions: STANDARD_EXTENSIONS });
		const tools = getRegisteredToolNames(session.tallow);

		const expected = [
			"subagent",
			"subagent_status",
			"bg_bash",
			"task_output",
			"task_status",
			"task_kill",
			"ask_user_question",
			"plan_mode",
			"switch_theme",
			"debug_inspect",
			"session_recall",
			// LSP tools
			"lsp_hover",
			"lsp_definition",
			"lsp_references",
			"lsp_symbols",
			"lsp_workspace_symbols",
			"lsp_status",
		];

		for (const name of expected) {
			expect(tools).toContain(name);
		}
	});

	it("registers productivity slash commands", async () => {
		session = await createProfileSession({ extensions: STANDARD_EXTENSIONS });
		const commands = getRegisteredCommandNames(session.tallow);

		const expected = [
			"tasks",
			"todos",
			"theme",
			"health",
			"doctor",
			"stats",
			"debug",
			"plan-mode",
			"cheatsheet",
			"init",
			"context",
			"rewind",
			"keybindings",
			"keymap",
			"keys",
		];

		for (const name of expected) {
			expect(commands).toContain(name);
		}
	});

	it("has session_start handlers from multiple extensions", async () => {
		session = await createProfileSession({ extensions: STANDARD_EXTENSIONS });
		const counts = getHandlerCounts(session.tallow);

		// Many standard extensions hook session_start
		const sessionStartCount = counts.get("session_start") ?? 0;
		expect(sessionStartCount).toBeGreaterThanOrEqual(5);
	});

	it("completes a prompt with tasks/subagent extensions loaded", async () => {
		session = await createProfileSession({
			extensions: STANDARD_EXTENSIONS,
			streamFn: createScriptedStreamFn([{ text: "Standard profile works." }]),
		});

		const events = await session.run("hello");
		// Prompt completed without throwing — verify we got text back
		const textUpdates = events.filter(
			(e) => e.type === "message_update" && (e as any).assistantMessageEvent?.type === "text_delta"
		);
		expect(textUpdates.length).toBeGreaterThan(0);
	});
});
