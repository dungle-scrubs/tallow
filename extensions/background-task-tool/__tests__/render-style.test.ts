import { describe, expect, test } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { styleBackgroundOutputLine } from "../index.js";

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

describe("styleBackgroundOutputLine", () => {
	test("dims plain output lines", () => {
		const line = styleBackgroundOutputLine(createMockTheme(), "plain output");
		expect(line).toBe("<dim>plain output</dim>");
	});

	test("preserves pre-colored ANSI lines", () => {
		const colored = "\x1b[31merror\x1b[0m";
		const line = styleBackgroundOutputLine(createMockTheme(), colored);
		expect(line).toBe(colored);
	});
});
