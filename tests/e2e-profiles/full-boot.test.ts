/**
 * E2E: Full profile boot test.
 *
 * Loads every bundled extension and verifies no load errors, no tool/command
 * collisions, and prompt round-trips work with the full extension set.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	createProfileSession,
	createScriptedStreamFn,
	getRegisteredCommandNames,
	getRegisteredToolNames,
	type ProfileSession,
} from "./profile-runner.js";
import { discoverAllExtensionNames } from "./profiles.js";

let session: ProfileSession | undefined;

afterEach(() => {
	session?.dispose();
	session = undefined;
});

const ALL_EXTENSIONS = discoverAllExtensionNames();

describe("Full Profile", () => {
	it("discovers a reasonable number of bundled extensions", () => {
		// Sanity check — if this drops drastically something is wrong
		expect(ALL_EXTENSIONS.length).toBeGreaterThanOrEqual(40);
	});

	it("loads every bundled extension without errors", async () => {
		session = await createProfileSession({ extensions: ALL_EXTENSIONS });

		if (session.tallow.extensions.errors.length > 0) {
			const details = session.tallow.extensions.errors
				.map((e) => `  ${e.path}: ${e.error}`)
				.join("\n");
			throw new Error(`Extension load errors:\n${details}`);
		}
	});

	it("has no duplicate tool names", async () => {
		session = await createProfileSession({ extensions: ALL_EXTENSIONS });
		const tools = getRegisteredToolNames(session.tallow);
		const seen = new Map<string, number>();

		for (const name of tools) {
			seen.set(name, (seen.get(name) ?? 0) + 1);
		}

		const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
		if (duplicates.length > 0) {
			throw new Error(
				`Duplicate tool names: ${duplicates.map(([n, c]) => `${n} (${c}x)`).join(", ")}`
			);
		}
	});

	it("has no duplicate command names", async () => {
		session = await createProfileSession({ extensions: ALL_EXTENSIONS });
		const commands = getRegisteredCommandNames(session.tallow);
		const seen = new Map<string, number>();

		for (const name of commands) {
			seen.set(name, (seen.get(name) ?? 0) + 1);
		}

		const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
		if (duplicates.length > 0) {
			throw new Error(
				`Duplicate command names: ${duplicates.map(([n, c]) => `${n} (${c}x)`).join(", ")}`
			);
		}
	});

	it("tool count matches expected range", async () => {
		session = await createProfileSession({ extensions: ALL_EXTENSIONS });
		const tools = getRegisteredToolNames(session.tallow);

		// 27 known tools (MCP tools are dynamic, won't be present without servers)
		expect(tools.length).toBeGreaterThanOrEqual(25);
		expect(tools.length).toBeLessThanOrEqual(40);
	});

	it("completes a text prompt round-trip", async () => {
		session = await createProfileSession({
			extensions: ALL_EXTENSIONS,
			streamFn: createScriptedStreamFn([{ text: "Full profile operational." }]),
		});

		const events = await session.run("ping");
		const textDeltas = events.filter(
			(e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta"
		);
		expect(textDeltas.length).toBeGreaterThan(0);
	});

	it("completes a tool-use round-trip", async () => {
		session = await createProfileSession({
			extensions: ALL_EXTENSIONS,
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "read", arguments: { path: "/dev/null" } }] },
				{ text: "Read complete." },
			]),
		});

		const events = await session.run("read something");
		const toolResults = events.filter((e) => e.type === "tool_execution_end");
		expect(toolResults.length).toBeGreaterThanOrEqual(1);
	});
});
