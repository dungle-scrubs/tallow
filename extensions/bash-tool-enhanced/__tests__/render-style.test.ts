import { describe, expect, test } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import bashLive from "../index.js";

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

describe("bash renderer presentation styles", () => {
	test("expanded results include output divider and styled footer", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(bashLive);

		const bashTool = harness.tools.get("bash");
		expect(bashTool?.renderResult).toBeDefined();
		if (!bashTool?.renderResult) return;

		const component = bashTool.renderResult(
			{
				content: [{ type: "text", text: "line one\nline two" }],
				details: {},
			} as never,
			{ expanded: true, isPartial: false },
			createMockTheme()
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("─── Output ───");
		expect(rendered).toContain("<dim>line one</dim>");
		expect(rendered).toContain("<success>");
	});
});
