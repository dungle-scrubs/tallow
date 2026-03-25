/**
 * Tests for SGR mouse event parsing: parseMouseEvent and isMouseEvent.
 */
import { describe, expect, it } from "bun:test";
import { isMouseEvent, parseMouseEvent } from "../keys.js";

// ── parseMouseEvent ──────────────────────────────────────────────────────────

describe("parseMouseEvent", () => {
	it("parses scroll-up event", () => {
		// SGR: \x1b[<64;10;5M — code 64 = scroll up, col 10, row 5, press
		expect(parseMouseEvent("\x1b[<64;10;5M")).toEqual({
			type: "scroll-up",
			button: 0,
			x: 10,
			y: 5,
		});
	});

	it("parses scroll-down event", () => {
		// SGR: \x1b[<65;20;15M — code 65 = scroll down, col 20, row 15, press
		expect(parseMouseEvent("\x1b[<65;20;15M")).toEqual({
			type: "scroll-down",
			button: 0,
			x: 20,
			y: 15,
		});
	});

	it("parses left button press", () => {
		// SGR: \x1b[<0;5;3M — code 0 = left button, col 5, row 3, M = press
		expect(parseMouseEvent("\x1b[<0;5;3M")).toEqual({
			type: "press",
			button: 0,
			x: 5,
			y: 3,
		});
	});

	it("parses left button release", () => {
		// SGR: \x1b[<0;5;3m — code 0, lowercase m = release
		expect(parseMouseEvent("\x1b[<0;5;3m")).toEqual({
			type: "release",
			button: 0,
			x: 5,
			y: 3,
		});
	});

	it("parses middle button press", () => {
		// SGR: \x1b[<1;12;8M — code 1 = middle button
		expect(parseMouseEvent("\x1b[<1;12;8M")).toEqual({
			type: "press",
			button: 1,
			x: 12,
			y: 8,
		});
	});

	it("parses right button press", () => {
		// SGR: \x1b[<2;30;20M — code 2 = right button
		expect(parseMouseEvent("\x1b[<2;30;20M")).toEqual({
			type: "press",
			button: 2,
			x: 30,
			y: 20,
		});
	});

	it("parses drag event (bit 5 set)", () => {
		// SGR: \x1b[<32;15;10M — code 32 = motion + left button
		expect(parseMouseEvent("\x1b[<32;15;10M")).toEqual({
			type: "drag",
			button: 0,
			x: 15,
			y: 10,
		});
	});

	it("parses drag with right button", () => {
		// SGR: \x1b[<34;15;10M — code 34 = 32 (motion) + 2 (right)
		expect(parseMouseEvent("\x1b[<34;15;10M")).toEqual({
			type: "drag",
			button: 2,
			x: 15,
			y: 10,
		});
	});

	it("handles large coordinates (beyond 223-column limit)", () => {
		// SGR format supports arbitrary coordinates — this is why we use mode 1006
		expect(parseMouseEvent("\x1b[<0;300;150M")).toEqual({
			type: "press",
			button: 0,
			x: 300,
			y: 150,
		});
	});

	it("returns null for non-mouse input", () => {
		expect(parseMouseEvent("a")).toBeNull();
		expect(parseMouseEvent("\x1b[A")).toBeNull(); // arrow up
		expect(parseMouseEvent("\x1b[1;2H")).toBeNull(); // cursor position
		expect(parseMouseEvent("")).toBeNull();
	});

	it("returns null for malformed SGR sequences", () => {
		expect(parseMouseEvent("\x1b[<0;5M")).toBeNull(); // missing y
		expect(parseMouseEvent("\x1b[<0;5;3")).toBeNull(); // missing M/m terminator
		expect(parseMouseEvent("\x1b[<;5;3M")).toBeNull(); // missing code
	});
});

// ── isMouseEvent ─────────────────────────────────────────────────────────────

describe("isMouseEvent", () => {
	it("returns true for SGR mouse sequences", () => {
		expect(isMouseEvent("\x1b[<0;5;3M")).toBe(true);
		expect(isMouseEvent("\x1b[<64;10;5M")).toBe(true);
		expect(isMouseEvent("\x1b[<0;300;150m")).toBe(true);
	});

	it("returns false for non-mouse input", () => {
		expect(isMouseEvent("a")).toBe(false);
		expect(isMouseEvent("\x1b[A")).toBe(false);
		expect(isMouseEvent("\x1b[1")).toBe(false);
		expect(isMouseEvent("")).toBe(false);
	});

	it("returns false for strings shorter than minimum mouse sequence", () => {
		// Minimum: \x1b[<N;N;NM = 9 chars
		expect(isMouseEvent("\x1b[<0;5;")).toBe(false);
	});
});
