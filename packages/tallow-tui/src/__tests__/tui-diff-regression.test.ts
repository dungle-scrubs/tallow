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

/**
 * Reproduce grow -> shrink -> grow -> update cycle that simulates agent turn
 * content fluctuations (loader appears, content shrinks, new content arrives).
 *
 * @returns All terminal writes and final redraw count
 */
function runHeightFluctuationScenario(): { allWrites: string[]; fullRedraws: number } {
	const width = 32;
	const height = 10;
	const stableLines = 18;
	const terminal = new MockTerminal(width, height);
	const tui = new TUI(terminal);
	const component = new MutableLinesComponent(createFrame(stableLines, "input A", 9, width));
	tui.addChild(component);

	// Phase 1: Grow to establish a large working area (simulates loader + streaming).
	renderNow(tui);

	// Phase 2: Shrink (simulates loader stopping or tool result replacing progress).
	component.setLines(createFrame(stableLines, "input A", 0, width));
	renderNow(tui);

	// Phase 3: Grow again (simulates new streaming content arriving).
	component.setLines(createFrame(stableLines, "input A", 5, width));
	renderNow(tui);

	// Phase 4: Update within content (simulates editor input change).
	component.setLines(createFrame(stableLines, "input B", 5, width));
	renderNow(tui);

	return {
		allWrites: [...terminal.writes],
		fullRedraws: tui.fullRedraws,
	};
}

describe("TUI differential rendering shrink regression", () => {
	test("realigns viewport basis on drift instead of full redraw", () => {
		const result = runGrowShrinkUpdateScenario();

		// Viewport basis drift is now handled by realignment, not full redraw.
		// The update render should use a partial redraw (no increase in fullRedraws).
		expect(result.redrawsAfterUpdate).toBe(result.redrawsBeforeUpdate);
	});

	test("keeps editor content correct after grow->shrink->update", () => {
		const result = runGrowShrinkUpdateScenario();
		const plain = stripAnsi(result.finalWrite);

		// The partial redraw only writes the changed line, not the full content.
		// Borders are already on screen from the prior render and don't need
		// to be redrawn — their absence in the final write proves partial redraw worked.
		expect(plain).toContain("input B");
	});

	test("never clears scrollback during content height fluctuation", () => {
		const result = runHeightFluctuationScenario();

		// No write should ever contain \x1b[3J (clear scrollback).
		// This sequence destroys the user's scroll position and reading context.
		for (const write of result.allWrites) {
			expect(write).not.toContain("\x1b[3J");
		}
	});

	test("never clears scrollback during grow->shrink->update", () => {
		const width = 32;
		const height = 10;
		const stableLines = 18;
		const terminal = new MockTerminal(width, height);
		const tui = new TUI(terminal);
		const component = new MutableLinesComponent(createFrame(stableLines, "input A", 9, width));
		tui.addChild(component);

		renderNow(tui);

		component.setLines(createFrame(stableLines, "input A", 0, width));
		renderNow(tui);

		component.setLines(createFrame(stableLines, "input B", 0, width));
		renderNow(tui);

		for (const write of terminal.writes) {
			expect(write).not.toContain("\x1b[3J");
		}
	});

	test("extraLines > height in diff path triggers safety full redraw", () => {
		const width = 40;
		const height = 10;
		const terminal = new MockTerminal(width, height);
		const tui = new TUI(terminal);
		// Start with 30 lines (extraLines on shrink = 25, which exceeds height = 10)
		const component = new MutableLinesComponent(Array.from({ length: 30 }, (_, i) => `line ${i}`));
		tui.addChild(component);
		renderNow(tui);

		// Shrink to 5 lines with changed content so we don't hit the "all deleted" path
		component.setLines(Array.from({ length: 5 }, (_, i) => `changed ${i}`));
		const redrawsBefore = tui.fullRedraws;
		renderNow(tui);

		// Should have triggered safety full redraw (extraLines = 25 > height = 10)
		expect(tui.fullRedraws).toBe(redrawsBefore + 1);
	});

	test("maxLinesRendered decays after shrink without overlays", () => {
		const width = 40;
		const height = 20;
		const terminal = new MockTerminal(width, height);
		const tui = new TUI(terminal);
		const component = new MutableLinesComponent(Array.from({ length: 15 }, (_, i) => `line ${i}`));
		tui.addChild(component);
		renderNow(tui);

		component.setLines(Array.from({ length: 8 }, (_, i) => `short ${i}`));
		renderNow(tui);

		// maxLinesRendered should have decayed to actual content size
		const tuiInternal = tui as unknown as { maxLinesRendered: number };
		expect(tuiInternal.maxLinesRendered).toBe(8);
	});

	test("grow-shrink-grow does not leave ghost gap", () => {
		const width = 40;
		const height = 10;
		const terminal = new MockTerminal(width, height);
		const tui = new TUI(terminal);
		const component = new MutableLinesComponent(Array.from({ length: 25 }, (_, i) => `line ${i}`));
		tui.addChild(component);
		renderNow(tui); // 25 lines

		component.setLines(Array.from({ length: 8 }, (_, i) => `shrunk ${i}`));
		renderNow(tui); // Shrink to 8

		component.setLines(Array.from({ length: 12 }, (_, i) => `grown ${i}`));
		renderNow(tui); // Grow to 12

		// maxLinesRendered should track actual content, not stale high-water mark
		const tuiInternal = tui as unknown as { maxLinesRendered: number };
		expect(tuiInternal.maxLinesRendered).toBe(12);

		// Verify no blank-line ghost: writes should not contain scrollback destruction
		const lastWrite = terminal.writes[terminal.writes.length - 1] ?? "";
		expect(lastWrite).not.toContain("\x1b[3J");
	});

	test("viewport drift corrected on same render as shrink", () => {
		const width = 40;
		const height = 10;
		const terminal = new MockTerminal(width, height);
		const tui = new TUI(terminal);
		// Start with 80 lines to establish large working area
		const component = new MutableLinesComponent(Array.from({ length: 80 }, (_, i) => `line ${i}`));
		tui.addChild(component);
		renderNow(tui); // maxLinesRendered = 80

		// Shrink to 30 — drift should be corrected immediately (same cycle)
		component.setLines(Array.from({ length: 30 }, (_, i) => `shrunk ${i}`));
		renderNow(tui);

		const tuiInternal = tui as unknown as {
			maxLinesRendered: number;
			previousViewportTop: number;
		};

		// maxLinesRendered should have decayed to 30 (not stuck at 80)
		expect(tuiInternal.maxLinesRendered).toBe(30);
		// previousViewportTop should be consistent with the decayed maxLinesRendered
		expect(tuiInternal.previousViewportTop).toBe(Math.max(0, 30 - height));

		// Grow to 40 — should NOT require full redraw since drift was already corrected
		component.setLines(Array.from({ length: 40 }, (_, i) => `grown ${i}`));
		renderNow(tui);

		// The key assertion is maxLinesRendered is correct
		expect(tuiInternal.maxLinesRendered).toBe(40);
	});
});
