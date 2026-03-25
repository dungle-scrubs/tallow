/**
 * Integration test: cd tool prompt guidelines.
 *
 * Verifies that the cd tool's promptGuidelines are injected into the
 * system prompt, preventing the model from combining cd with other tools.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";
import { createSessionRunner, type SessionRunner } from "../../test-utils/session-runner.js";
import cdToolExtension from "../cd-tool/index.js";

let runner: SessionRunner | undefined;

afterEach(() => {
	runner?.dispose();
	runner = undefined;
});

describe("cd tool prompt guidelines", () => {
	it("injects exclusive-call guideline into the system prompt", async () => {
		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "ok" }]),
			extensionFactories: [cdToolExtension],
		});

		// Run a prompt so the system prompt is built (includes tool guidelines)
		await runner.run("hello");

		const systemPrompt = runner.session.systemPrompt;
		expect(systemPrompt).toContain("cd tool triggers an interactive workspace transition");
		expect(systemPrompt).toContain("SOLE tool call");
	});

	it("includes the cd tool in the available tools", async () => {
		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([{ text: "ok" }]),
			extensionFactories: [cdToolExtension],
		});

		await runner.run("hello");

		const systemPrompt = runner.session.systemPrompt;
		// The tool description should appear (either in the tools section or as a snippet)
		expect(systemPrompt).toContain("cd");
	});
});
