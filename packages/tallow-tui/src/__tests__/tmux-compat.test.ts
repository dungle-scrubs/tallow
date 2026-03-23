/**
 * Tests for tmux compatibility: modifyOtherKeys key matching and protocol detection.
 *
 * tmux uses xterm's modifyOtherKeys protocol (not Kitty keyboard protocol).
 * Format: \x1b[27;<modifier>;<keycode>~
 * CSI u format: \x1b[<keycode>;<modifier>u
 *
 * Modifier values are 1-indexed:
 *   1 = no modifier, 2 = Shift, 3 = Alt, 4 = Shift+Alt,
 *   5 = Ctrl, 6 = Ctrl+Shift, 7 = Ctrl+Alt, 8 = Ctrl+Shift+Alt
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isKittyProtocolActive, matchesKey, parseKey, setKittyProtocolActive } from "../keys.js";

// ── modifyOtherKeys format (xterm) ──────────────────────────────────────────
// tmux with `extended-keys-format xterm` sends: \x1b[27;<mod>;<keycode>~

describe("modifyOtherKeys xterm format", () => {
	beforeEach(() => setKittyProtocolActive(false));
	afterEach(() => setKittyProtocolActive(false));

	it("matches Shift+Enter as shift+enter", () => {
		// mod=2 → Shift, keycode=13 → Enter
		expect(matchesKey("\x1b[27;2;13~", "shift+enter")).toBe(true);
	});

	it("does not match Shift+Enter as plain enter", () => {
		expect(matchesKey("\x1b[27;2;13~", "enter")).toBe(false);
	});

	it("matches unmodified Escape via modifyOtherKeys", () => {
		// mod=1 → no modifier, keycode=27 → Escape
		expect(matchesKey("\x1b[27;1;27~", "escape")).toBe(true);
	});

	it("matches Ctrl+Shift+A", () => {
		// mod=6 → Ctrl+Shift, keycode=65 → 'A' (uppercase)
		// matchesKey expects lowercase key: "ctrl+shift+a"
		expect(matchesKey("\x1b[27;6;97~", "ctrl+shift+a")).toBe(true);
	});

	it("matches Ctrl+Enter", () => {
		// mod=5 → Ctrl, keycode=13 → Enter
		expect(matchesKey("\x1b[27;5;13~", "ctrl+enter")).toBe(true);
	});

	it("matches Alt+Enter", () => {
		// mod=3 → Alt, keycode=13 → Enter
		expect(matchesKey("\x1b[27;3;13~", "alt+enter")).toBe(true);
	});

	it("matches Shift+Space", () => {
		// mod=2 → Shift, keycode=32 → Space
		expect(matchesKey("\x1b[27;2;32~", "shift+space")).toBe(true);
	});

	it("matches Shift+Backspace", () => {
		// mod=2 → Shift, keycode=127 → Backspace
		expect(matchesKey("\x1b[27;2;127~", "shift+backspace")).toBe(true);
	});

	it("matches Shift+Tab via standard legacy sequence", () => {
		// Shift+Tab has its own legacy sequence, not modifyOtherKeys
		expect(matchesKey("\x1b[Z", "shift+tab")).toBe(true);
	});
});

// ── CSI u format (tmux with extended-keys-format csi-u) ─────────────────────
// tmux with `extended-keys-format csi-u` sends: \x1b[<keycode>;<modifier>u

describe("CSI u format (tmux csi-u)", () => {
	beforeEach(() => setKittyProtocolActive(false));
	afterEach(() => setKittyProtocolActive(false));

	it("matches Shift+Enter", () => {
		// \x1b[13;2u → keycode=13 (Enter), mod=2 (Shift)
		expect(matchesKey("\x1b[13;2u", "shift+enter")).toBe(true);
	});

	it("does not match CSI u Shift+Enter as plain enter", () => {
		expect(matchesKey("\x1b[13;2u", "enter")).toBe(false);
	});

	it("matches unmodified Enter via CSI u", () => {
		// \x1b[13u → keycode=13 (Enter), no modifier
		expect(matchesKey("\x1b[13u", "enter")).toBe(true);
	});

	it("matches unmodified Escape via CSI u", () => {
		// \x1b[27u → keycode=27 (Escape), no modifier
		expect(matchesKey("\x1b[27u", "escape")).toBe(true);
	});

	it("matches Ctrl+Shift+Enter", () => {
		// \x1b[13;6u → keycode=13, mod=6 (Ctrl+Shift)
		expect(matchesKey("\x1b[13;6u", "ctrl+shift+enter")).toBe(true);
	});

	it("matches Shift+Space via CSI u", () => {
		// \x1b[32;2u → keycode=32 (Space), mod=2 (Shift)
		expect(matchesKey("\x1b[32;2u", "shift+space")).toBe(true);
	});

	it("matches Shift+Backspace via CSI u", () => {
		// \x1b[127;2u → keycode=127 (Backspace), mod=2 (Shift)
		expect(matchesKey("\x1b[127;2u", "shift+backspace")).toBe(true);
	});
});

// ── Legacy fallbacks (no protocol) ──────────────────────────────────────────
// When tmux has extended-keys off, only legacy sequences arrive

describe("legacy mode (no extended-keys)", () => {
	beforeEach(() => setKittyProtocolActive(false));
	afterEach(() => setKittyProtocolActive(false));

	it("matches Escape as raw 0x1b", () => {
		expect(matchesKey("\x1b", "escape")).toBe(true);
	});

	it("matches Enter as raw \\r", () => {
		expect(matchesKey("\r", "enter")).toBe(true);
	});

	it("matches Enter as \\n in legacy mode", () => {
		expect(matchesKey("\n", "enter")).toBe(true);
	});

	it("does NOT match \\r as shift+enter", () => {
		// In legacy mode, Shift+Enter is indistinguishable from Enter
		expect(matchesKey("\r", "shift+enter")).toBe(false);
	});

	it("matches Ctrl+C", () => {
		expect(matchesKey("\x03", "ctrl+c")).toBe(true);
	});

	it("matches Alt+Enter as ESC CR in legacy mode", () => {
		expect(matchesKey("\x1b\r", "alt+enter")).toBe(true);
	});
});

// ── Kitty protocol active should NOT be set in tmux ─────────────────────────

describe("Kitty protocol state isolation", () => {
	afterEach(() => setKittyProtocolActive(false));

	it("starts with Kitty protocol inactive", () => {
		setKittyProtocolActive(false);
		expect(isKittyProtocolActive()).toBe(false);
	});

	it("modifyOtherKeys sequences work regardless of Kitty state", () => {
		// These should work whether Kitty protocol is active or not
		setKittyProtocolActive(false);
		expect(matchesKey("\x1b[27;2;13~", "shift+enter")).toBe(true);

		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[27;2;13~", "shift+enter")).toBe(true);
	});

	it("CSI u sequences work regardless of Kitty state", () => {
		setKittyProtocolActive(false);
		expect(matchesKey("\x1b[13;2u", "shift+enter")).toBe(true);

		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[13;2u", "shift+enter")).toBe(true);
	});

	it("legacy Escape works regardless of Kitty state", () => {
		setKittyProtocolActive(false);
		expect(matchesKey("\x1b", "escape")).toBe(true);

		setKittyProtocolActive(true);
		expect(matchesKey("\x1b", "escape")).toBe(true);
	});
});

// ── parseKey with modifyOtherKeys ───────────────────────────────────────────

describe("parseKey with modifyOtherKeys", () => {
	beforeEach(() => setKittyProtocolActive(false));
	afterEach(() => setKittyProtocolActive(false));

	it("parses CSI u Shift+Enter", () => {
		expect(parseKey("\x1b[13;2u")).toBe("shift+enter");
	});

	it("parses CSI u unmodified Enter", () => {
		expect(parseKey("\x1b[13u")).toBe("enter");
	});

	it("parses CSI u unmodified Escape", () => {
		expect(parseKey("\x1b[27u")).toBe("escape");
	});

	it("parses CSI u Ctrl+Enter", () => {
		expect(parseKey("\x1b[13;5u")).toBe("ctrl+enter");
	});

	it("parses CSI u Shift+Space", () => {
		expect(parseKey("\x1b[32;2u")).toBe("shift+space");
	});
});
