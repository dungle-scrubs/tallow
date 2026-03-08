import { describe, expect, test } from "bun:test";
import type { Terminal } from "../terminal.js";
import { type Component, TUI } from "../tui.js";

/** Terminal test double that captures writes and lets tests inject input. */
class ControlledTerminal implements Terminal {
	private readonly width: number;
	private readonly height: number;
	private onInput?: (data: string) => void;
	public readonly writes: string[] = [];

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
	}

	/**
	 * Store input callback so tests can inject terminal input later.
	 *
	 * @param onInput - TUI input handler
	 * @param _onResize - Unused resize handler
	 * @returns {void}
	 */
	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.onInput = onInput;
	}

	/**
	 * Remove captured input handler.
	 *
	 * @returns {void}
	 */
	stop(): void {
		this.onInput = undefined;
	}

	/**
	 * No-op drain for the test terminal.
	 *
	 * @returns {Promise<void>}
	 */
	async drainInput(): Promise<void> {}

	/**
	 * Record terminal writes for assertions.
	 *
	 * @param data - Terminal escape sequences and rendered text
	 * @returns {void}
	 */
	write(data: string): void {
		this.writes.push(data);
	}

	/**
	 * Inject input as if it came from stdin.
	 *
	 * @param data - Input sequence to deliver
	 * @returns {void}
	 */
	emitInput(data: string): void {
		this.onInput?.(data);
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

/**
 * Component that keeps requesting renders to simulate a chatty streaming turn.
 */
class StreamingBurstComponent implements Component {
	public text = "";
	public renderCount = 0;
	public inputHandledAtRenderCount: number | null = null;
	public inputVisibleAtRenderCount: number | null = null;

	constructor(
		private readonly tui: TUI,
		private readonly targetRenderCount: number
	) {}

	/**
	 * Render current editor text and request another frame until the burst finishes.
	 *
	 * @returns {string[]} Visible lines for the frame
	 */
	render(): string[] {
		this.renderCount += 1;
		if (this.text.length > 0 && this.inputVisibleAtRenderCount === null) {
			this.inputVisibleAtRenderCount = this.renderCount;
		}
		if (this.renderCount < this.targetRenderCount) {
			this.tui.requestRender();
		}
		return ["assistant: streaming", `editor: ${this.text}`];
	}

	/**
	 * Apply typed input and record the render count at which input became interactive.
	 *
	 * @param data - Typed character sequence
	 * @returns {void}
	 */
	handleInput(data: string): void {
		this.text += data;
		if (this.inputHandledAtRenderCount === null) {
			this.inputHandledAtRenderCount = this.renderCount;
		}
	}

	/**
	 * No-op invalidation hook required by Component.
	 *
	 * @returns {void}
	 */
	invalidate(): void {}
}

/** Simple component used to count coalesced render executions. */
class CountingComponent implements Component {
	public renderCount = 0;

	/**
	 * Increment render counter for each frame.
	 *
	 * @returns {string[]} Rendered lines
	 */
	render(): string[] {
		this.renderCount += 1;
		return [`renders: ${this.renderCount}`];
	}

	/**
	 * No-op invalidation hook required by Component.
	 *
	 * @returns {void}
	 */
	invalidate(): void {}
}

/**
 * Yield until the next I/O phase.
 *
 * Uses `setTimeout(0)` because on Bun `setImmediate` never enters the
 * I/O poll phase. This matches the `setTimeout(0)` used in `scheduleRender`.
 *
 * @returns {Promise<void>} Promise that resolves after I/O polling
 */
function flushIO(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait until a condition becomes true, failing if it never does.
 *
 * @param condition - Predicate checked after each event-loop turn
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns {Promise<void>} Promise that resolves once the condition passes
 * @throws {Error} When the condition does not pass before timeout
 */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Condition not met before timeout");
		}
		await flushIO();
	}
}

describe("TUI render scheduling", () => {
	test("requestRender yields to input under streaming pressure", async () => {
		const terminal = new ControlledTerminal(80, 24);
		const tui = new TUI(terminal);
		const component = new StreamingBurstComponent(tui, 40);
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();

		setTimeout(() => {
			terminal.emitInput("x");
		}, 0);

		await waitFor(() => component.renderCount >= 40);
		expect(component.inputHandledAtRenderCount).not.toBeNull();
		expect(component.inputHandledAtRenderCount).toBeLessThan(40);

		tui.stop();
	});

	test("typing remains visible during streaming burst", async () => {
		const terminal = new ControlledTerminal(80, 24);
		const tui = new TUI(terminal);
		const component = new StreamingBurstComponent(tui, 40);
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();

		setTimeout(() => {
			terminal.emitInput("x");
		}, 0);

		await waitFor(() => component.inputVisibleAtRenderCount !== null);
		expect(component.inputVisibleAtRenderCount).toBeLessThan(40);
		await waitFor(() => component.renderCount >= 40);
		expect(terminal.writes.some((write) => write.includes("editor: x"))).toBe(true);

		tui.stop();
	});

	test("render requests still coalesce", async () => {
		const terminal = new ControlledTerminal(80, 24);
		const tui = new TUI(terminal);
		const component = new CountingComponent();
		tui.addChild(component);

		for (let index = 0; index < 25; index += 1) {
			tui.requestRender();
		}
		await flushIO();

		expect(component.renderCount).toBe(1);
		expect(terminal.writes).toHaveLength(1);
	});
});
