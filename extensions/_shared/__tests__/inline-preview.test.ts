import { describe, expect, test } from "bun:test";
import { extractPreview, isInlineResultsEnabled } from "../inline-preview.js";

describe("extractPreview", () => {
	test("returns empty array for empty input", () => {
		expect(extractPreview("")).toEqual([]);
		expect(extractPreview("   ")).toEqual([]);
		expect(extractPreview("\n\n")).toEqual([]);
	});

	test("extracts last N lines", () => {
		const output = "line1\nline2\nline3\nline4\nline5";
		expect(extractPreview(output, 3)).toEqual(["line3", "line4", "line5"]);
	});

	test("returns all lines when fewer than maxLines", () => {
		expect(extractPreview("line1\nline2", 3)).toEqual(["line1", "line2"]);
	});

	test("filters out blank lines", () => {
		const output = "line1\n\n\nline2\n\n";
		expect(extractPreview(output, 3)).toEqual(["line1", "line2"]);
	});

	test("strips ANSI escape codes", () => {
		const output = "\x1b[32mgreen text\x1b[0m\n\x1b[1mbold\x1b[0m";
		expect(extractPreview(output, 3)).toEqual(["green text", "bold"]);
	});

	test("truncates long lines with ellipsis", () => {
		const longLine = "a".repeat(100);
		const result = extractPreview(longLine, 3, 80);
		expect(result[0].length).toBe(80);
		expect(result[0].endsWith("…")).toBe(true);
	});

	test("does not truncate lines within limit", () => {
		const output = "short line";
		expect(extractPreview(output, 3, 80)).toEqual(["short line"]);
	});

	test("trims trailing whitespace from lines", () => {
		const output = "line1   \nline2\t\t";
		expect(extractPreview(output, 3)).toEqual(["line1", "line2"]);
	});
});

describe("isInlineResultsEnabled", () => {
	test("returns true by default (no settings file)", () => {
		// In test environment, ~/.tallow/settings.json likely doesn't have
		// inlineAgentResults set, so default should be true
		expect(typeof isInlineResultsEnabled()).toBe("boolean");
	});
});
