/**
 * Tests that ask_user_question error paths return `isError: true`.
 *
 * Verifies the model receives a proper error signal (not just error text)
 * when the tool cannot execute due to missing UI or invalid parameters.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import askUserQuestion from "../index.js";

/**
 * Build a minimal ExtensionContext stub for tool execute calls.
 * @param overrides - Fields to override on the default context
 * @returns Partial context cast to ExtensionContext
 */
function stubContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		hasUI: false,
		ui: {
			setWorkingMessage() {},
			async custom() {
				return undefined;
			},
		},
		cwd: process.cwd(),
		...overrides,
	} as unknown as ExtensionContext;
}

describe("ask_user_question error paths", () => {
	test("returns isError: true when UI not available", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(askUserQuestion);

		const tool = harness.tools.get("ask_user_question");
		expect(tool).toBeDefined();
		if (!tool) return;

		const result = await tool.execute(
			"test-id",
			{ question: "Pick one", options: [{ label: "Option A" }] },
			new AbortController().signal,
			() => {},
			stubContext({ hasUI: false })
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Error: UI not available (running in non-interactive mode)",
		});
	});

	test("returns isError: true when no options provided", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(askUserQuestion);

		const tool = harness.tools.get("ask_user_question");
		if (!tool) return;

		const result = await tool.execute(
			"test-id",
			{ question: "Pick one", options: [] },
			new AbortController().signal,
			() => {},
			stubContext({ hasUI: true })
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Error: No options provided",
		});
	});

	test("does NOT set isError on successful selection cancel", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(askUserQuestion);

		const tool = harness.tools.get("ask_user_question");
		if (!tool) return;

		const result = await tool.execute(
			"test-id",
			{ question: "Pick one", options: [{ label: "A" }] },
			new AbortController().signal,
			() => {},
			stubContext({
				hasUI: true,
				ui: {
					setWorkingMessage() {},
					async custom() {
						return null; // simulate user cancel
					},
				} as unknown as ExtensionContext["ui"],
			})
		);

		// Cancel is not an error — it's a valid user action
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toBe("User cancelled the selection");
	});
});
