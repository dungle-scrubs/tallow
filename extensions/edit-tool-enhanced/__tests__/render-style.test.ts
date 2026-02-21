import { describe, expect, test } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import editLive from "../index.js";

/**
 * Build a minimal theme stub for renderer assertions.
 *
 * @returns Theme-like object with deterministic fg/bold wrappers
 */
function createMockTheme(): Theme {
	return {
		bold(text: string) {
			return `<b>${text}</b>`;
		},
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
	} as unknown as Theme;
}

describe("edit renderer presentation styles", () => {
	test("live edit footer uses semantic success/action roles", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(editLive);

		const editTool = harness.tools.get("edit");
		expect(editTool?.renderResult).toBeDefined();
		if (!editTool?.renderResult) return;

		const component = editTool.renderResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					__edit_live__: true,
					_filename: "file.ts",
				},
			} as never,
			{ expanded: false, isPartial: false },
			createMockTheme()
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("<success>");
		expect(rendered).toContain("<accent>");
	});
});
