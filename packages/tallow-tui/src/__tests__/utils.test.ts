/**
 * Tests for core utility functions kept in the fork.
 */
import { describe, expect, it } from "bun:test";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";

describe("visibleWidth", () => {
	it("counts ASCII characters", () => {
		expect(visibleWidth("hello")).toBe(5);
	});

	it("ignores SGR color codes", () => {
		expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
	});

	it("ignores OSC 8 hyperlink sequences", () => {
		expect(visibleWidth("\x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe(4);
	});

	it("counts CJK and emoji as wide glyphs", () => {
		expect(visibleWidth("你好")).toBe(4);
		expect(visibleWidth("👋")).toBe(2);
	});

	it("counts tabs as 3 spaces", () => {
		expect(visibleWidth("\t")).toBe(3);
	});
});

describe("truncateToWidth", () => {
	it("returns text unchanged when it fits", () => {
		expect(truncateToWidth("hello", 10, "…")).toBe("hello");
	});

	it("truncates long text to the target width", () => {
		const result = truncateToWidth("hello world", 8, "…");
		expect(visibleWidth(result)).toBeLessThanOrEqual(8);
		expect(result).toContain("…");
	});

	it("preserves ANSI sequences in truncated output", () => {
		const result = truncateToWidth("\x1b[31mhello world\x1b[0m", 8, "…");
		expect(result).toContain("\x1b[31m");
		expect(visibleWidth(result)).toBeLessThanOrEqual(8);
	});

	it("handles OSC 8 hyperlinks", () => {
		const linked = "\x1b]8;;file:///test\x1blong-filename.ts\x1b]8;;\x1b\\";
		const result = truncateToWidth(linked, 10, "…");
		expect(visibleWidth(result)).toBeLessThanOrEqual(10);
	});
});

describe("wrapTextWithAnsi", () => {
	it("wraps plain text at word boundaries", () => {
		const lines = wrapTextWithAnsi("hello world foo", 10);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(10);
		}
	});

	it("preserves ANSI codes across line breaks", () => {
		const lines = wrapTextWithAnsi("\x1b[31mhello world\x1b[0m", 8);
		expect(lines.length).toBeGreaterThan(1);
	});

	it("handles long words and empty strings", () => {
		for (const line of wrapTextWithAnsi("superlongword", 5)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(5);
		}
		expect(wrapTextWithAnsi("", 80)).toEqual([""]);
	});
});
