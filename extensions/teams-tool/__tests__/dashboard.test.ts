import { describe, expect, it } from "bun:test";
import {
	appendRollingOutput,
	calculateDashboardGridColumns,
	calculateDashboardSplit,
	clampScrollOffset,
	clampSelectionIndex,
	cycleSelectionIndex,
	DASHBOARD_MOUSE_SCROLL_LINES,
	DASHBOARD_OUTPUT_PREVIEW_LINES,
	moveScrollOffset,
	parseDashboardMouseWheel,
	resolveDashboardCommand,
} from "../dashboard";

describe("dashboard layout split", () => {
	it("uses 25% left pane on wide terminals", () => {
		const split = calculateDashboardSplit(120);
		expect(split.leftWidth).toBe(30);
		expect(split.separatorWidth).toBe(1);
		expect(split.rightWidth).toBe(89);
	});

	it("enforces left min width of 24", () => {
		const split = calculateDashboardSplit(80);
		expect(split.leftWidth).toBe(24);
		expect(split.rightWidth).toBe(55);
	});
});

describe("dashboard grid columns", () => {
	it("falls back to one column on narrow panes", () => {
		expect(calculateDashboardGridColumns(85)).toBe(1);
	});

	it("uses two columns when minimum width fits", () => {
		expect(calculateDashboardGridColumns(86)).toBe(2);
	});
});

describe("dashboard selection clamp and wrap", () => {
	it("clamps selection index for up/down movement", () => {
		expect(clampSelectionIndex(-1, 4)).toBe(0);
		expect(clampSelectionIndex(99, 4)).toBe(3);
	});

	it("wraps team cycling for tab navigation", () => {
		expect(cycleSelectionIndex(0, 3, -1)).toBe(2);
		expect(cycleSelectionIndex(2, 3, 1)).toBe(0);
	});
});

describe("dashboard scroll bounds", () => {
	it("clamps offsets to [0..max]", () => {
		expect(clampScrollOffset(-20, 12)).toBe(0);
		expect(clampScrollOffset(42, 12)).toBe(12);
	});

	it("applies deltas with bounds", () => {
		expect(moveScrollOffset(2, 5, 10)).toBe(7);
		expect(moveScrollOffset(9, 5, 10)).toBe(10);
		expect(moveScrollOffset(2, -9, 10)).toBe(0);
	});
});

describe("dashboard mouse wheel parsing", () => {
	it("parses wheel up SGR sequence", () => {
		expect(parseDashboardMouseWheel("\x1b[<64;40;12M")).toBe("up");
	});

	it("parses wheel down SGR sequence", () => {
		expect(parseDashboardMouseWheel("\x1b[<65;40;12M")).toBe("down");
	});

	it("returns undefined for non-wheel mouse events", () => {
		expect(parseDashboardMouseWheel("\x1b[<0;40;12M")).toBeUndefined();
		expect(parseDashboardMouseWheel("\x1b[<64;40;12m")).toBeUndefined();
	});

	it("keeps wheel scroll delta at three lines", () => {
		expect(DASHBOARD_MOUSE_SCROLL_LINES).toBe(3);
	});
});

describe("dashboard output truncation", () => {
	it("keeps newest chars when the buffer exceeds max", () => {
		expect(appendRollingOutput("abcd", "efgh", 6)).toBe("cdefgh");
	});

	it("keeps full output when under max", () => {
		expect(appendRollingOutput("hello", " world", 32)).toBe("hello world");
	});

	it("uses five output preview lines per card", () => {
		expect(DASHBOARD_OUTPUT_PREVIEW_LINES).toBe(5);
	});
});

describe("/team-dashboard command resolution", () => {
	it("toggles when no args are provided", () => {
		const resolution = resolveDashboardCommand(false, "");
		expect(resolution.action).toBe("toggle");
		expect(resolution.nextEnabled).toBe(true);
		expect(resolution.changed).toBe(true);
	});

	it("supports on/off/status modes", () => {
		expect(resolveDashboardCommand(false, "on").nextEnabled).toBe(true);
		expect(resolveDashboardCommand(true, "off").nextEnabled).toBe(false);
		expect(resolveDashboardCommand(true, "status").changed).toBe(false);
	});

	it("returns usage for invalid args", () => {
		const resolution = resolveDashboardCommand(true, "bad");
		expect(resolution.isError).toBe(true);
		expect(resolution.message).toContain("Usage: /team-dashboard");
	});
});
