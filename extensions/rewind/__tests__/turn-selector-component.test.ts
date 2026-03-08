import { describe, expect, it } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	createTurnSelector,
	formatRelativeTime,
	formatTurnOption,
} from "../turn-selector-component.js";
import type { TurnOption } from "../ui.js";

// ── Helpers ──────────────────────────────────────────────────────

/** Creates a TurnOption with sensible defaults. */
function makeTurn(turnIndex: number, files: string[] = [], timestamp = 0): TurnOption {
	return {
		turnIndex,
		ref: `refs/tallow/rewind/test/turn-${turnIndex}`,
		files,
		timestamp,
	};
}

/** Identity theme — no ANSI escapes, makes assertions easier. */
const plainTheme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

// ── formatTurnOption ─────────────────────────────────────────────

describe("formatTurnOption", () => {
	it("formats a turn with files", () => {
		const result = formatTurnOption(makeTurn(5, ["a.ts", "b.ts"]));
		expect(result).toBe("Turn 5 — 2 file(s): a.ts, b.ts");
	});

	it("truncates when more than 3 files", () => {
		const result = formatTurnOption(makeTurn(2, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]));
		expect(result).toContain("[+2 more]");
		expect(result).toContain("5 file(s)");
	});

	it("shows snapshot-only label when no files tracked", () => {
		const result = formatTurnOption(makeTurn(1));
		expect(result).toContain("(git diff snapshot only)");
	});

	it("includes relative time when timestamp is positive", () => {
		const recent = Date.now() - 30_000; // 30 seconds ago
		const result = formatTurnOption(makeTurn(3, ["x.ts"], recent));
		expect(result).toContain("just now");
	});
});

// ── formatRelativeTime ───────────────────────────────────────────

describe("formatRelativeTime", () => {
	it("returns 'just now' for < 60s", () => {
		expect(formatRelativeTime(Date.now() - 10_000)).toBe("just now");
	});

	it("returns minutes for < 60m", () => {
		expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe("5m ago");
	});

	it("returns hours for < 24h", () => {
		expect(formatRelativeTime(Date.now() - 3 * 3_600_000)).toBe("3h ago");
	});

	it("returns days for >= 24h", () => {
		expect(formatRelativeTime(Date.now() - 2 * 86_400_000)).toBe("2d ago");
	});
});

// ── createTurnSelector ───────────────────────────────────────────

describe("createTurnSelector", () => {
	it("renders all items when list fits within terminal", () => {
		const turns = [makeTurn(3), makeTurn(2), makeTurn(1)];
		const labels = turns.map(formatTurnOption);

		const component = createTurnSelector(turns, labels, 30, plainTheme, () => {});

		const lines = component.render(80);

		// All 3 turns should be visible
		expect(lines.some((l) => l.includes("Turn 3"))).toBe(true);
		expect(lines.some((l) => l.includes("Turn 2"))).toBe(true);
		expect(lines.some((l) => l.includes("Turn 1"))).toBe(true);

		// No scroll indicators (hint line has ↑↓ but no "more" suffix)
		expect(lines.some((l) => l.includes("↑") && l.includes("more"))).toBe(false);
		expect(lines.some((l) => l.includes("↓") && l.includes("more"))).toBe(false);
	});

	it("windows the list when items exceed terminal height", () => {
		const turns = Array.from({ length: 20 }, (_, i) => makeTurn(20 - i));
		const labels = turns.map(formatTurnOption);

		// Terminal with only 12 rows → maxVisible = 12 - 6 = 6
		const component = createTurnSelector(turns, labels, 12, plainTheme, () => {});

		const lines = component.render(80);

		// Should show scroll-down indicator
		expect(lines.some((l) => l.includes("↓") && l.includes("more"))).toBe(true);

		// Should show position indicator
		expect(lines.some((l) => l.includes("1/20"))).toBe(true);

		// Should NOT show all 20 items
		const turnLines = lines.filter((l) => l.includes("Turn "));
		expect(turnLines.length).toBeLessThan(20);
	});

	it("shows scroll-up indicator after navigating down", () => {
		const turns = Array.from({ length: 20 }, (_, i) => makeTurn(20 - i));
		const labels = turns.map(formatTurnOption);

		const component = createTurnSelector(turns, labels, 12, plainTheme, () => {});

		// Navigate down several times to push past the top of the window
		for (let i = 0; i < 8; i++) {
			component.handleInput("\x1b[B"); // Down arrow
		}

		const lines = component.render(80);
		expect(lines.some((l) => l.includes("↑") && l.includes("more"))).toBe(true);
	});

	it("wraps selection from top to bottom", () => {
		const turns = [makeTurn(3), makeTurn(2), makeTurn(1)];
		const labels = turns.map(formatTurnOption);
		let result: TurnOption | null | undefined;

		const component = createTurnSelector(turns, labels, 30, plainTheme, (r) => {
			result = r;
		});

		// Press up from index 0 → should wrap to last
		component.handleInput("\x1b[A"); // Up arrow

		// Confirm → should be the last item (Turn 1)
		component.handleInput("\r"); // Enter

		expect(result).toEqual(turns[2]);
	});

	it("wraps selection from bottom to top", () => {
		const turns = [makeTurn(3), makeTurn(2), makeTurn(1)];
		const labels = turns.map(formatTurnOption);
		let result: TurnOption | null | undefined;

		const component = createTurnSelector(turns, labels, 30, plainTheme, (r) => {
			result = r;
		});

		// Navigate to bottom then one more down
		component.handleInput("\x1b[B"); // Down
		component.handleInput("\x1b[B"); // Down (now at index 2)
		component.handleInput("\x1b[B"); // Down → wraps to 0

		component.handleInput("\r"); // Enter
		expect(result).toEqual(turns[0]);
	});

	it("returns selected turn on Enter", () => {
		const turns = [makeTurn(5), makeTurn(4), makeTurn(3)];
		const labels = turns.map(formatTurnOption);
		let result: TurnOption | null | undefined;

		const component = createTurnSelector(turns, labels, 30, plainTheme, (r) => {
			result = r;
		});

		component.handleInput("\x1b[B"); // Down to index 1
		component.handleInput("\r"); // Enter

		expect(result).toEqual(turns[1]); // Turn 4
	});

	it("returns null on Escape", () => {
		const turns = [makeTurn(3)];
		const labels = turns.map(formatTurnOption);
		let result: TurnOption | null | undefined;

		const component = createTurnSelector(turns, labels, 30, plainTheme, (r) => {
			result = r;
		});

		component.handleInput("\x1b"); // Escape
		expect(result).toBeNull();
	});

	it("returns null on Ctrl+C", () => {
		const turns = [makeTurn(3)];
		const labels = turns.map(formatTurnOption);
		let result: TurnOption | null | undefined;

		const component = createTurnSelector(turns, labels, 30, plainTheme, (r) => {
			result = r;
		});

		component.handleInput("\x03"); // Ctrl+C
		expect(result).toBeNull();
	});

	it("invalidate clears the render cache", () => {
		const turns = [makeTurn(1)];
		const labels = turns.map(formatTurnOption);

		const component = createTurnSelector(turns, labels, 30, plainTheme, () => {});

		const lines1 = component.render(80);
		const lines2 = component.render(80);
		expect(lines1).toBe(lines2); // Same reference (cached)

		component.invalidate();
		const lines3 = component.render(80);
		expect(lines3).not.toBe(lines1); // New reference (re-rendered)
		expect(lines3).toEqual(lines1); // Same content though
	});

	it("renders hint line and borders", () => {
		const turns = [makeTurn(1)];
		const labels = turns.map(formatTurnOption);

		const component = createTurnSelector(turns, labels, 30, plainTheme, () => {});
		const lines = component.render(80);

		expect(lines.some((l) => l.includes("navigate"))).toBe(true);
		expect(lines.some((l) => l.includes("Rewind to which turn?"))).toBe(true);
	});

	it("handles minimum terminal height (3 visible)", () => {
		const turns = Array.from({ length: 10 }, (_, i) => makeTurn(10 - i));
		const labels = turns.map(formatTurnOption);

		// Very small terminal: rows=9 → maxVisible = max(3, 9-6) = 3
		const component = createTurnSelector(turns, labels, 9, plainTheme, () => {});
		const lines = component.render(80);

		// Should still render without crashing
		const turnLines = lines.filter((l) => l.includes("Turn "));
		expect(turnLines.length).toBeLessThanOrEqual(3);
		expect(turnLines.length).toBeGreaterThanOrEqual(1);
	});
});
