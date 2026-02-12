/**
 * Tests for tallow-tui core utility functions: visibleWidth, truncateToWidth,
 * wrapTextWithAnsi, hyperlink, and fileLink.
 */
import { describe, expect, it } from "bun:test";
import { fileLink, hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";

// ── visibleWidth ─────────────────────────────────────────────────────────────

describe("visibleWidth", () => {
	it("counts ASCII characters", () => {
		expect(visibleWidth("hello")).toBe(5);
	});

	it("returns 0 for empty string", () => {
		expect(visibleWidth("")).toBe(0);
	});

	it("ignores SGR color codes", () => {
		expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
	});

	it("ignores nested ANSI codes", () => {
		expect(visibleWidth("\x1b[1m\x1b[31mbold red\x1b[0m")).toBe(8);
	});

	it("ignores OSC 8 hyperlink sequences", () => {
		expect(visibleWidth("\x1b]8;;http://example.com\x07link\x1b]8;;\x07")).toBe(4);
	});

	it("counts CJK characters as double-width", () => {
		expect(visibleWidth("你好")).toBe(4);
	});

	it("handles mixed ASCII and CJK", () => {
		expect(visibleWidth("hi你好")).toBe(6);
	});

	it("counts emoji as double-width", () => {
		expect(visibleWidth("👋")).toBe(2);
	});

	it("counts tabs as 3 spaces", () => {
		expect(visibleWidth("\t")).toBe(3);
	});

	it("counts skin tone modifiers as single glyph", () => {
		expect(visibleWidth("👋🏽")).toBe(2);
	});

	it("handles string with only ANSI codes", () => {
		expect(visibleWidth("\x1b[31m\x1b[0m")).toBe(0);
	});

	it("handles multiple emoji in a row", () => {
		const w = visibleWidth("🔥🎉✅");
		expect(w).toBeGreaterThanOrEqual(4); // at least 2 wide emoji
	});
});

// ── truncateToWidth ──────────────────────────────────────────────────────────

describe("truncateToWidth", () => {
	it("returns string unchanged when within width", () => {
		expect(truncateToWidth("hello", 10, "…")).toBe("hello");
	});

	it("truncates and appends ellipsis", () => {
		const result = truncateToWidth("hello world", 8, "…");
		expect(visibleWidth(result)).toBeLessThanOrEqual(8);
		expect(result).toContain("…");
	});

	it("handles CJK truncation at character boundary", () => {
		const result = truncateToWidth("你好世界", 5, "…");
		expect(visibleWidth(result)).toBeLessThanOrEqual(5);
	});

	it("preserves ANSI codes in truncated output", () => {
		const result = truncateToWidth("\x1b[31mhello world\x1b[0m", 8, "…");
		expect(result).toContain("\x1b[31m");
	});

	it("handles exact width match", () => {
		const result = truncateToWidth("hello", 5, "…");
		expect(result).toBe("hello");
	});

	it("handles width of 1 with ellipsis", () => {
		const result = truncateToWidth("hello", 1, "…");
		expect(visibleWidth(result)).toBeLessThanOrEqual(1);
	});

	it("handles OSC 8 hyperlinks", () => {
		const linked = "\x1b]8;;file:///test\x07long-filename.ts\x1b]8;;\x07";
		const result = truncateToWidth(linked, 10, "…");
		expect(visibleWidth(result)).toBeLessThanOrEqual(10);
	});
});

// ── wrapTextWithAnsi ─────────────────────────────────────────────────────────

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

	it("handles long words that exceed width", () => {
		const lines = wrapTextWithAnsi("superlongword", 5);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(5);
		}
	});

	it("handles empty string", () => {
		expect(wrapTextWithAnsi("", 80)).toEqual([""]);
	});

	it("handles CJK wrapping", () => {
		const lines = wrapTextWithAnsi("你好世界测试", 5);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(5);
		}
	});

	it("does not wrap when text fits", () => {
		const lines = wrapTextWithAnsi("short", 80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe("short");
	});
});

// ── hyperlink ────────────────────────────────────────────────────────────────

describe("hyperlink", () => {
	it("wraps text in OSC 8 sequences", () => {
		const result = hyperlink("https://example.com", "click");
		expect(result).toBe("\x1b]8;;https://example.com\x07click\x1b]8;;\x07");
	});

	it("has zero visible width overhead", () => {
		expect(visibleWidth(hyperlink("https://x.com", "text"))).toBe(4);
	});

	it("handles empty text", () => {
		const result = hyperlink("https://x.com", "");
		expect(visibleWidth(result)).toBe(0);
	});
});

// ── fileLink ─────────────────────────────────────────────────────────────────

describe("fileLink", () => {
	it("creates file:// URL from path", () => {
		const result = fileLink("/path/to/file.ts");
		expect(result).toContain("file:///path/to/file.ts");
		expect(visibleWidth(result)).toBe("/path/to/file.ts".length);
	});

	it("percent-encodes spaces in path", () => {
		const result = fileLink("/path/with spaces/file.ts");
		expect(result).toContain("file:///path/with%20spaces/file.ts");
		expect(visibleWidth(result)).toBe("/path/with spaces/file.ts".length);
	});

	it("uses custom display text", () => {
		const result = fileLink("/long/path/file.ts", "file.ts");
		expect(visibleWidth(result)).toBe(7);
	});
});
