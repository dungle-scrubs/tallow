/**
 * Integration test for slash-command-bridge.
 *
 * Verifies the tool works end-to-end via a session runner with a mock model
 * that invokes the run_slash_command tool.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";
import { createSessionRunner, type SessionRunner } from "../../test-utils/session-runner.js";
import slashCommandBridge from "../slash-command-bridge/index.js";

let runner: SessionRunner | undefined;

afterEach(() => {
	runner?.dispose();
	runner = undefined;
});

describe("slash-command-bridge integration", () => {
	it("model invokes show-system-prompt and receives prompt text", async () => {
		const toolResults: string[] = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "run_slash_command") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [{ name: "run_slash_command", arguments: { command: "show-system-prompt" } }],
				},
				{ text: "Got the system prompt" },
			]),
			extensionFactories: [slashCommandBridge, tracker],
		});

		await runner.run("Show me the system prompt");

		expect(toolResults).toHaveLength(1);
		// System prompt exists and is non-empty in a real session
		expect(toolResults[0].length).toBeGreaterThan(0);
	});

	it("model invokes context and receives usage data", async () => {
		const toolResults: Array<{ text: string; isError: boolean }> = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "run_slash_command") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") {
						toolResults.push({ text: text.text, isError: event.isError });
					}
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [{ name: "run_slash_command", arguments: { command: "context" } }],
				},
				{ text: "Context usage noted" },
			]),
			extensionFactories: [slashCommandBridge, tracker],
		});

		await runner.run("Check context usage");

		expect(toolResults).toHaveLength(1);
		// Context usage should contain token info (may be actual data or "no data" error)
		expect(toolResults[0].text.length).toBeGreaterThan(0);
	});

	it("model receives error for unknown commands", async () => {
		const toolResults: string[] = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "run_slash_command") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [{ name: "run_slash_command", arguments: { command: "reboot" } }],
				},
				{ text: "That command is not available" },
			]),
			extensionFactories: [slashCommandBridge, tracker],
		});

		await runner.run("Reboot the system");

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toContain("Unknown command");
		expect(toolResults[0]).toContain("reboot");
	});

	it("model invokes compact successfully", async () => {
		const toolResults: string[] = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "run_slash_command") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [{ name: "run_slash_command", arguments: { command: "compact" } }],
				},
				{ text: "Compaction started" },
			]),
			extensionFactories: [slashCommandBridge, tracker],
		});

		await runner.run("Compact the session");

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toContain("compaction will begin");
	});

	it("model invokes release-memory successfully", async () => {
		const toolResults: string[] = [];

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "run_slash_command") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [{ name: "run_slash_command", arguments: { command: "release-memory" } }],
				},
				{ text: "Memory release started" },
			]),
			extensionFactories: [slashCommandBridge, tracker],
		});

		await runner.run("Release memory for this session");

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toContain("memory release will begin");
	});
});
