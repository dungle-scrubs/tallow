import { describe, expect, test } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import readSummary from "../index.js";

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

describe("read renderer presentation styles", () => {
	test("expanded summarized results show divider, subdued content, and semantic footer", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(readSummary);

		const readTool = harness.tools.get("read");
		expect(readTool?.renderResult).toBeDefined();
		if (!readTool?.renderResult) return;

		const component = readTool.renderResult(
			{
				content: [{ type: "text", text: "notes.md (2 lines, 0.1KB)" }],
				details: {
					__summarized_read__: true,
					_fullText: "alpha\nbeta",
				},
			} as never,
			{ expanded: true, isPartial: false },
			createMockTheme()
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("─── Output ───");
		expect(rendered).toContain("<dim>alpha</dim>");
		expect(rendered).toContain("<success>");
		expect(rendered).toContain("<accent>");
	});
});
