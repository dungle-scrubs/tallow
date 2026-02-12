/**
 * Tests for bash-tool-enhanced OSC stripping: stripNonDisplayOsc and styleBashLine.
 */
import { describe, expect, it } from "bun:test";
import { stripNonDisplayOsc, styleBashLine } from "../index.js";

// ── stripNonDisplayOsc ───────────────────────────────────────────────────────

describe("stripNonDisplayOsc", () => {
	it("strips iTerm2 SetUserVar sequences (BEL terminator)", () => {
		const line = "text\x1b]1337;SetUserVar=foo=bar\x07more";
		expect(stripNonDisplayOsc(line)).toBe("textmore");
	});

	it("preserves OSC 8 hyperlinks", () => {
		const line = "\x1b]8;;http://x.com\x07link\x1b]8;;\x07";
		expect(stripNonDisplayOsc(line)).toBe(line);
	});

	it("returns plain text unchanged", () => {
		expect(stripNonDisplayOsc("plain text")).toBe("plain text");
	});

	it("strips OSC with ST terminator", () => {
		const line = "text\x1b]999;data\x1b\\more";
		expect(stripNonDisplayOsc(line)).toBe("textmore");
	});

	it("strips multiple non-display OSC sequences", () => {
		const line = "\x1b]1337;foo\x07middle\x1b]999;bar\x07end";
		expect(stripNonDisplayOsc(line)).toBe("middleend");
	});

	it("handles empty string", () => {
		expect(stripNonDisplayOsc("")).toBe("");
	});

	it("handles string with only SGR codes (no OSC)", () => {
		const line = "\x1b[31mred\x1b[0m";
		expect(stripNonDisplayOsc(line)).toBe(line);
	});

	it("preserves OSC 8 while stripping others in same line", () => {
		const line = "\x1b]1337;x\x07\x1b]8;;url\x07text\x1b]8;;\x07";
		expect(stripNonDisplayOsc(line)).toBe("\x1b]8;;url\x07text\x1b]8;;\x07");
	});
});

// ── styleBashLine ────────────────────────────────────────────────────────────

describe("styleBashLine", () => {
	const dim = (s: string) => `[dim:${s}]`;

	it("dims plain text", () => {
		expect(styleBashLine("hello", dim)).toBe("[dim:hello]");
	});

	it("leaves ANSI-colored text unchanged", () => {
		const colored = "\x1b[31mred text\x1b[0m";
		expect(styleBashLine(colored, dim)).toBe(colored);
	});

	it("strips non-display OSC before checking for ANSI", () => {
		// Line with only non-display OSC (no SGR) → gets dimmed after strip
		const line = "\x1b]1337;foo\x07plain text";
		expect(styleBashLine(line, dim)).toBe("[dim:plain text]");
	});

	it("handles empty string", () => {
		expect(styleBashLine("", dim)).toBe("[dim:]");
	});
});
