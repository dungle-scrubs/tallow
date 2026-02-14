import { describe, expect, it } from "bun:test";
import { renderLines, sanitizeTabs } from "../index.js";

describe("sanitizeTabs", () => {
	it("replaces tabs with three spaces", () => {
		expect(sanitizeTabs("\t\tindented")).toBe("      indented");
	});

	it("returns unchanged string when no tabs present", () => {
		expect(sanitizeTabs("no tabs here")).toBe("no tabs here");
	});

	it("handles mixed tabs and spaces", () => {
		expect(sanitizeTabs("\t hello\t")).toBe("    hello   ");
	});

	it("handles empty string", () => {
		expect(sanitizeTabs("")).toBe("");
	});
});

describe("renderLines", () => {
	it("replaces tabs with spaces in rendered output", () => {
		const component = renderLines(["\t\tindented", "no tabs"]);
		const lines = component.render(80);
		for (const line of lines) {
			expect(line).not.toContain("\t");
		}
	});

	it("preserves content after tab replacement", () => {
		const component = renderLines(["\tcode();"]);
		const lines = component.render(80);
		expect(lines[0]).toBe("   code();");
	});

	it("truncates lines by default", () => {
		const component = renderLines(["a".repeat(100)]);
		const lines = component.render(50);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("…");
	});

	it("wraps lines when wrap option is true", () => {
		const component = renderLines(["a".repeat(100)], { wrap: true });
		const lines = component.render(50);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join("")).not.toContain("…");
	});

	it("behaves identically with no options as without options arg", () => {
		const line = "a".repeat(100);
		const withoutOpts = renderLines([line]).render(50);
		const withEmptyOpts = renderLines([line], {}).render(50);
		expect(withoutOpts).toEqual(withEmptyOpts);
	});
});
