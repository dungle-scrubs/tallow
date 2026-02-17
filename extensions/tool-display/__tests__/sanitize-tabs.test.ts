import { describe, expect, it } from "bun:test";
import { formatToolVerb, renderLines, sanitizeTabs } from "../index.js";

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

describe("formatToolVerb", () => {
	it("returns label + present continuous for known tools during execution", () => {
		expect(formatToolVerb("read", false)).toBe("Read: Reading…");
		expect(formatToolVerb("write", false)).toBe("Write: Writing…");
		expect(formatToolVerb("edit", false)).toBe("Edit: Editing…");
		expect(formatToolVerb("bash", false)).toBe("Bash: Running…");
		expect(formatToolVerb("ls", false)).toBe("Ls: Listing…");
		expect(formatToolVerb("grep", false)).toBe("Grep: Searching…");
		expect(formatToolVerb("find", false)).toBe("Find: Finding…");
		expect(formatToolVerb("generate_image", false)).toBe("GenerateImage: Generating…");
		expect(formatToolVerb("web_search", false)).toBe("Web Search: Searching…");
	});

	it("returns label + past tense for known tools when complete", () => {
		expect(formatToolVerb("read", true)).toBe("Read: Read");
		expect(formatToolVerb("write", true)).toBe("Write: Wrote");
		expect(formatToolVerb("edit", true)).toBe("Edit: Edited");
		expect(formatToolVerb("bash", true)).toBe("Bash: Ran");
		expect(formatToolVerb("ls", true)).toBe("Ls: Listed");
		expect(formatToolVerb("grep", true)).toBe("Grep: Searched");
		expect(formatToolVerb("find", true)).toBe("Find: Found");
		expect(formatToolVerb("generate_image", true)).toBe("GenerateImage: Generated");
		expect(formatToolVerb("web_search", true)).toBe("Web Search: Searched");
	});

	it("falls back to title-cased label with ellipsis for unknown tools during execution", () => {
		expect(formatToolVerb("custom_tool", false)).toBe("Custom Tool…");
	});

	it("falls back to title-cased label for unknown tools when complete", () => {
		expect(formatToolVerb("custom_tool", true)).toBe("Custom Tool");
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
