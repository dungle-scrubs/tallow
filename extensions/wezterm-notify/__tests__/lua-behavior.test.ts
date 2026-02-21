import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LUA_FILE_PATH = join(process.cwd(), "extensions/wezterm-notify/wezterm/tallow.lua");
const LUA_SOURCE = readFileSync(LUA_FILE_PATH, "utf8");

/**
 * Assert that snippets appear in source in the provided order.
 *
 * @param sourceText - Source to inspect
 * @param snippets - Ordered snippets expected in source
 * @returns Nothing; fails the test when ordering is violated
 */
function expectSnippetsInOrder(sourceText: string, snippets: readonly string[]): void {
	let cursor = 0;
	for (const snippet of snippets) {
		const index = sourceText.indexOf(snippet, cursor);
		expect(index).toBeGreaterThanOrEqual(0);
		cursor = index + snippet.length;
	}
}

describe("wezterm-notify Lua spinner behavior", () => {
	it("removes wall-clock throttling primitives", () => {
		expect(LUA_SOURCE).not.toContain("os.clock");
		expect(LUA_SOURCE).not.toMatch(/\btallow_spinner_last\b/);
		expect(LUA_SOURCE).not.toContain("spinner_interval_seconds");
	});

	it("uses redraw-generation based frame advancement", () => {
		expectSnippetsInOrder(LUA_SOURCE, [
			"local function advance_spinner_for_redraw()",
			"local generation = wezterm.GLOBAL.tallow_spinner_generation or 0",
			"if generation == last_generation then",
			"advance_spinner_frame()",
			"wezterm.GLOBAL.tallow_spinner_last_advanced_generation = generation",
			"function M.tick()",
			"local generation = wezterm.GLOBAL.tallow_spinner_generation or 0",
			"wezterm.GLOBAL.tallow_spinner_generation = generation + 1",
		]);

		expectSnippetsInOrder(LUA_SOURCE, ['wezterm.on("update-right-status", function()', "M.tick()"]);
	});

	it("advances spinner in the any_working render path and keeps done/unseen coloring", () => {
		expectSnippetsInOrder(LUA_SOURCE, [
			"if any_working then",
			"advance_spinner_for_redraw()",
			"table.insert(elements, { Foreground = { Color = resolved.spinner_color } })",
			'table.insert(elements, { Text = " " .. M.spinner_char() .. " " })',
			"else",
			'table.insert(elements, { Text = "   " })',
		]);

		expectSnippetsInOrder(LUA_SOURCE, [
			"local fg = tab.is_active and resolved.active_color or resolved.inactive_color",
			"if any_done_unseen then",
			"fg = resolved.done_color",
		]);
	});
});
