/**
 * Tests for tallow-tui key parsing: parseKey, matchesKey, isKeyRelease, isKeyRepeat.
 */
import { describe, expect, it } from "bun:test";
import { isKeyRelease, isKeyRepeat, matchesKey, parseKey } from "../keys.js";

// ── parseKey ─────────────────────────────────────────────────────────────────

describe("parseKey", () => {
	it("parses printable ASCII letter", () => {
		expect(parseKey("a")).toBe("a");
	});

	it("parses enter (carriage return)", () => {
		expect(parseKey("\r")).toBe("enter");
	});

	it("parses escape", () => {
		expect(parseKey("\x1b")).toBe("escape");
	});

	it("parses tab", () => {
		expect(parseKey("\t")).toBe("tab");
	});

	it("parses space", () => {
		expect(parseKey(" ")).toBe("space");
	});

	it("parses arrow up", () => {
		expect(parseKey("\x1b[A")).toBe("up");
	});

	it("parses arrow down", () => {
		expect(parseKey("\x1b[B")).toBe("down");
	});

	it("parses arrow right", () => {
		expect(parseKey("\x1b[C")).toBe("right");
	});

	it("parses arrow left", () => {
		expect(parseKey("\x1b[D")).toBe("left");
	});

	it("parses ctrl+c", () => {
		expect(parseKey("\x03")).toBe("ctrl+c");
	});

	it("parses backspace (DEL)", () => {
		expect(parseKey("\x7f")).toBe("backspace");
	});

	it("parses backspace (BS)", () => {
		expect(parseKey("\x08")).toBe("backspace");
	});

	it("parses home", () => {
		expect(parseKey("\x1b[H")).toBe("home");
	});

	it("parses end", () => {
		expect(parseKey("\x1b[F")).toBe("end");
	});

	it("parses delete", () => {
		expect(parseKey("\x1b[3~")).toBe("delete");
	});

	it("parses shift+tab", () => {
		expect(parseKey("\x1b[Z")).toBe("shift+tab");
	});

	it("parses ctrl+space", () => {
		expect(parseKey("\x00")).toBe("ctrl+space");
	});

	it("returns undefined for unrecognized sequences", () => {
		expect(parseKey("\x1b[999z")).toBeUndefined();
	});
});

// ── matchesKey ───────────────────────────────────────────────────────────────

describe("matchesKey", () => {
	it("matches arrow up", () => {
		expect(matchesKey("\x1b[A", "up")).toBe(true);
	});

	it("matches enter", () => {
		expect(matchesKey("\r", "enter")).toBe(true);
	});

	it("matches escape", () => {
		expect(matchesKey("\x1b", "escape")).toBe(true);
	});

	it("rejects non-matching key", () => {
		expect(matchesKey("\x1b[A", "down")).toBe(false);
	});

	it("matches tab", () => {
		expect(matchesKey("\t", "tab")).toBe(true);
	});

	it("matches backspace", () => {
		expect(matchesKey("\x7f", "backspace")).toBe(true);
	});
});

// ── isKeyRelease ─────────────────────────────────────────────────────────────

describe("isKeyRelease", () => {
	it("returns false for regular ASCII input", () => {
		expect(isKeyRelease("a")).toBe(false);
	});

	it("returns false for legacy arrow sequences", () => {
		expect(isKeyRelease("\x1b[A")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isKeyRelease("")).toBe(false);
	});
});

// ── isKeyRepeat ──────────────────────────────────────────────────────────────

describe("isKeyRepeat", () => {
	it("returns false for regular ASCII input", () => {
		expect(isKeyRepeat("a")).toBe(false);
	});

	it("returns false for legacy arrow sequences", () => {
		expect(isKeyRepeat("\x1b[A")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isKeyRepeat("")).toBe(false);
	});
});
