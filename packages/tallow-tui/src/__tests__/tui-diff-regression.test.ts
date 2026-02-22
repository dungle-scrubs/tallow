import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../../../../test-utils/virtual-terminal.js";
import type { Terminal } from "../terminal.js";
import { type Component, TUI } from "../tui.js";

/** Terminal test double that records all writes for assertion. */
class MockTerminal implements Terminal {
	private readonly width: number;
	private readonly height: number;
	public readonly writes: string[] = [];

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}

	stop(): void {}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.width;
	}

	get rows(): number {
		return this.height;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	enterAlternateScreen(): void {}

	leaveAlternateScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_percent: number): void {}

	clearProgress(): void {}
}

/** Mutable component that lets tests drive exact rendered line sequences. */
class MutableLinesComponent implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

interface ScenarioResult {
	border: string;
	finalWrite: string;
	redrawsBeforeUpdate: number;
	redrawsAfterUpdate: number;
}

/**
 * Invoke TUI's internal render synchronously for deterministic testing.
 *
 * @param tui - TUI instance under test
 */
function renderNow(tui: TUI): void {
	const renderer = tui as unknown as { doRender: () => void };
	renderer.doRender();
}

/**
 * Build a frame with stable lines, editor-like borders, and optional trailing lines.
 *
 * @param stableLines - Number of unchanged lines before editor
 * @param inputText - Editor content line between borders
 * @param trailingLines - Number of transient lines after editor
 * @param width - Terminal width in columns
 * @returns Frame lines for the component render output
 */
function createFrame(
	stableLines: number,
	inputText: string,
	trailingLines: number,
	width: number
): string[] {
	const stable = Array.from({ length: stableLines }, (_, index) => `stable ${index}`);
	const border = "─".repeat(width);
	const inputLine = inputText.padEnd(width, " ").slice(0, width);
	const trailing = Array.from({ length: trailingLines }, (_, index) => `tail ${index}`);
	return [...stable, border, inputLine, border, ...trailing];
}

/**
 * Reproduce grow -> shrink -> update sequence that previously risked row drift.
 *
 * @returns Scenario outputs used by assertions
 */
function runGrowShrinkUpdateScenario(): ScenarioResult {
	const width = 32;
	const height = 10;
	const stableLines = 18;
	const border = "─".repeat(width);
	const terminal = new MockTerminal(width, height);
	const tui = new TUI(terminal);
	const component = new MutableLinesComponent(createFrame(stableLines, "input A", 9, width));
	tui.addChild(component);

	// Grow to establish a large working area.
	renderNow(tui);

	// Shrink without changing earlier viewport lines. This keeps maxLinesRendered > previousLines.length.
	component.setLines(createFrame(stableLines, "input A", 0, width));
	renderNow(tui);

	const redrawsBeforeUpdate = tui.fullRedraws;

	// Trigger a regular update in the editor band after shrink.
	component.setLines(createFrame(stableLines, "input B", 0, width));
	renderNow(tui);

	return {
		border,
		finalWrite: terminal.writes[terminal.writes.length - 1] ?? "",
		redrawsBeforeUpdate,
		redrawsAfterUpdate: tui.fullRedraws,
	};
}

describe("TUI differential rendering shrink regression", () => {
	test("falls back to full redraw when viewport basis drift is detected", () => {
		const result = runGrowShrinkUpdateScenario();

		expect(result.redrawsAfterUpdate).toBe(result.redrawsBeforeUpdate + 1);
		expect(result.finalWrite).toContain("\x1b[3J\x1b[2J\x1b[H");
	});

	test("keeps editor top and bottom borders after grow->shrink->update", () => {
		const result = runGrowShrinkUpdateScenario();
		const plain = stripAnsi(result.finalWrite);
		const borderCount = plain.split(result.border).length - 1;

		expect(borderCount).toBeGreaterThanOrEqual(2);
		expect(plain).toContain("input B");
	});
});
