/**
 * E2E: Core profile boot test.
 *
 * Verifies the minimum viable extension set loads, registers expected
 * tools and commands, and can execute a prompt round-trip.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	createProfileSession,
	createScriptedStreamFn,
	getRegisteredCommandNames,
	getRegisteredToolNames,
	type ProfileSession,
} from "./profile-runner.js";
import { CORE_EXTENSIONS } from "./profiles.js";

let session: ProfileSession | undefined;

afterEach(() => {
	session?.dispose();
	session = undefined;
});

describe("Core Profile", () => {
	it("loads all core extensions without errors", async () => {
		session = await createProfileSession({ extensions: CORE_EXTENSIONS });

		expect(session.tallow.extensions.errors).toEqual([]);
		expect(session.tallow.extensions.extensions.length).toBeGreaterThanOrEqual(
			CORE_EXTENSIONS.length
		);
	});

	it("registers enhanced tool replacements", async () => {
		session = await createProfileSession({ extensions: CORE_EXTENSIONS });
		const tools = getRegisteredToolNames(session.tallow);

		// Enhanced tools that override pi built-ins
		for (const name of ["bash", "read", "edit", "write", "cd"]) {
			expect(tools).toContain(name);
		}
	});

	it("registers basic slash commands", async () => {
		session = await createProfileSession({ extensions: CORE_EXTENSIONS });
		const commands = getRegisteredCommandNames(session.tallow);

		expect(commands).toContain("clear");
		expect(commands).toContain("show-system-prompt");
	});

	it("completes a text prompt round-trip", async () => {
		session = await createProfileSession({
			extensions: CORE_EXTENSIONS,
			streamFn: createScriptedStreamFn([{ text: "Hello from core!" }]),
		});

		const events = await session.run("ping");
		const textDeltas = events.filter(
			(e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta"
		);
		expect(textDeltas.length).toBeGreaterThan(0);
	});

	it("completes a tool-use round-trip", async () => {
		session = await createProfileSession({
			extensions: CORE_EXTENSIONS,
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "read", arguments: { path: "/dev/null" } }] },
				{ text: "Done reading." },
			]),
		});

		const events = await session.run("read /dev/null");
		const toolResults = events.filter((e) => e.type === "tool_execution_end");
		expect(toolResults.length).toBeGreaterThanOrEqual(1);
	});
});
