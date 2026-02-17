/**
 * Tests for bash progress message helpers: stripAllAnsi, extractTailLines, formatProgressMessage.
 */
import { describe, expect, it } from "bun:test";
import { extractTailLines, formatProgressMessage, stripAllAnsi } from "../index.js";

// ── stripAllAnsi ─────────────────────────────────────────────────────────────

describe("stripAllAnsi", () => {
	it("strips SGR color codes", () => {
		expect(stripAllAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips bold/underline codes", () => {
		expect(stripAllAnsi("\x1b[1mbold\x1b[4munderline\x1b[0m")).toBe("boldunderline");
	});

	it("strips OSC sequences with BEL terminator", () => {
		expect(stripAllAnsi("\x1b]1337;foo\x07text")).toBe("text");
	});

	it("strips OSC sequences with ST terminator", () => {
		expect(stripAllAnsi("\x1b]999;data\x1b\\text")).toBe("text");
	});

	it("strips mixed SGR and OSC", () => {
		expect(stripAllAnsi("\x1b[32m\x1b]1337;x\x07green\x1b[0m")).toBe("green");
	});

	it("returns plain text unchanged", () => {
		expect(stripAllAnsi("hello world")).toBe("hello world");
	});

	it("handles empty string", () => {
		expect(stripAllAnsi("")).toBe("");
	});
});

// ── extractTailLines ─────────────────────────────────────────────────────────

describe("extractTailLines", () => {
	it("returns last N non-empty lines", () => {
		const text = "line1\nline2\nline3\nline4\nline5";
		expect(extractTailLines(text, 3)).toEqual(["line3", "line4", "line5"]);
	});

	it("skips empty and whitespace-only lines", () => {
		const text = "line1\n\n  \nline2\n\nline3\n";
		expect(extractTailLines(text, 2)).toEqual(["line2", "line3"]);
	});

	it("returns all lines when fewer than maxLines", () => {
		const text = "one\ntwo";
		expect(extractTailLines(text, 5)).toEqual(["one", "two"]);
	});

	it("returns empty array for empty input", () => {
		expect(extractTailLines("", 3)).toEqual([]);
	});

	it("returns empty array for whitespace-only input", () => {
		expect(extractTailLines("  \n\n  \n", 3)).toEqual([]);
	});

	it("handles single line", () => {
		expect(extractTailLines("only line", 3)).toEqual(["only line"]);
	});
});

// ── formatProgressMessage ────────────────────────────────────────────────────

describe("formatProgressMessage", () => {
	it("shows command only when no tail lines", () => {
		expect(formatProgressMessage("ls -la", [], 60)).toBe("Bash: ls -la");
	});

	it("shows command only when tail lines are all empty", () => {
		expect(formatProgressMessage("ls -la", ["", "  "], 60)).toBe("Bash: ls -la");
	});

	it("appends tail lines with visual prefix", () => {
		const result = formatProgressMessage("bun install", ["added 42 packages", "done in 3s"], 60);
		expect(result).toContain("Bash: bun install");
		expect(result).toContain("│ added 42 packages");
		expect(result).toContain("│ done in 3s");
	});

	it("truncates long lines with ellipsis", () => {
		const longLine = "a".repeat(80);
		const result = formatProgressMessage("cmd", [longLine], 60);
		// Truncated to 59 chars + ellipsis
		expect(result).toContain(`${"a".repeat(59)}…`);
		expect(result).not.toContain("a".repeat(60));
	});

	it("strips ANSI from tail lines", () => {
		const coloredLine = "\x1b[32mSuccess\x1b[0m: all tests passed";
		const result = formatProgressMessage("bun test", [coloredLine], 60);
		expect(result).toContain("│ Success: all tests passed");
		expect(result).not.toContain("\x1b[");
	});

	it("preserves line order", () => {
		const result = formatProgressMessage("cmd", ["first", "second", "third"], 60);
		const firstIdx = result.indexOf("first");
		const secondIdx = result.indexOf("second");
		const thirdIdx = result.indexOf("third");
		expect(firstIdx).toBeLessThan(secondIdx);
		expect(secondIdx).toBeLessThan(thirdIdx);
	});
});
