import { describe, expect, it } from "bun:test";
import { renderComponent, renderSnapshot, stripAnsi } from "../virtual-terminal.js";

// ── stripAnsi ────────────────────────────────────────────────────────────────

describe("stripAnsi", () => {
	it("strips CSI color codes", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips bold/italic codes", () => {
		expect(stripAnsi("\x1b[1mbold\x1b[22m \x1b[3mitalic\x1b[23m")).toBe("bold italic");
	});

	it("strips OSC hyperlinks", () => {
		expect(stripAnsi("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe("link");
	});

	it("strips OSC with ST terminator", () => {
		expect(stripAnsi("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
	});

	it("preserves plain text", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});

	it("handles mixed ANSI and plain text", () => {
		expect(stripAnsi("a\x1b[1mb\x1b[0mc")).toBe("abc");
	});
});

// ── renderComponent / renderSnapshot ─────────────────────────────────────────

describe("renderComponent", () => {
	it("renders a simple component", () => {
		const component = {
			render(width: number) {
				return [`Hello (w=${width})`, "Line 2"];
			},
		};
		const result = renderComponent(component, 40);
		expect(result.raw).toEqual(["Hello (w=40)", "Line 2"]);
		expect(result.plain).toEqual(["Hello (w=40)", "Line 2"]);
	});

	it("strips ANSI from plain output", () => {
		const component = {
			render() {
				return ["\x1b[31mColored\x1b[0m text"];
			},
		};
		const result = renderComponent(component, 80);
		expect(result.raw).toEqual(["\x1b[31mColored\x1b[0m text"]);
		expect(result.plain).toEqual(["Colored text"]);
	});
});

describe("renderSnapshot", () => {
	it("joins lines with newlines", () => {
		const component = {
			render() {
				return ["Line 1", "Line 2", "Line 3"];
			},
		};
		expect(renderSnapshot(component, 80)).toBe("Line 1\nLine 2\nLine 3");
	});
});
