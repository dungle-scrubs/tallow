import { describe, expect, test } from "bun:test";
import type { Terminal } from "@mariozechner/pi-tui";
import { type Component, TUI } from "@mariozechner/pi-tui";
import { stripAnsi } from "../../test-utils/virtual-terminal.js";
import { applyPiTuiPatches } from "../pi-tui-patch.js";

class MockTerminal implements Terminal {
	public readonly writes: string[] = [];

	constructor(
		private readonly width: number,
		private readonly height: number
	) {}

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
}

class MutableLinesComponent implements Component {
	constructor(private lines: string[]) {}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function renderNow(tui: TUI): void {
	const renderer = tui as unknown as { doRender: () => void };
	renderer.doRender();
}

async function flushIO(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Condition not met before timeout");
		}
		await flushIO();
	}
}

describe("applyPiTuiPatches TUI hooks", () => {
	test("full redraw renders only the visible tail of oversized content", async () => {
		await applyPiTuiPatches();
		const terminal = new MockTerminal(40, 5);
		const tui = new TUI(terminal);
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
		const component = new MutableLinesComponent(lines);
		tui.addChild(component);
		renderNow(tui);

		const output = terminal.writes.join("");
		expect(output).not.toContain("line 0");
		expect(output).not.toContain("line 5");
		expect(output).toContain("line 7");
		expect(output).toContain("line 11");
	});

	test("requestScrollbackClear only affects the next full render", async () => {
		await applyPiTuiPatches();
		const terminal = new MockTerminal(32, 6);
		const tui = new TUI(terminal) as TUI & { requestScrollbackClear(): void };
		const component = new MutableLinesComponent(Array.from({ length: 8 }, (_, i) => `line ${i}`));
		tui.addChild(component);
		renderNow(tui);
		terminal.writes.length = 0;

		tui.requestScrollbackClear();
		component.setLines(Array.from({ length: 4 }, (_, i) => `short ${i}`));
		renderNow(tui);

		expect(terminal.writes.some((write) => write.includes("\x1b[3J"))).toBe(true);
	});

	test("batched render requests coalesce until the batch ends", async () => {
		await applyPiTuiPatches();
		const terminal = new MockTerminal(20, 4);
		const tui = new TUI(terminal) as TUI & {
			beginRenderBatch(): void;
			endRenderBatch(): void;
			requestRender(force?: boolean): void;
		};
		const component = new MutableLinesComponent(["alpha", "beta"]);
		tui.addChild(component);
		tui.beginRenderBatch();
		component.setLines(["gamma", "delta"]);
		tui.requestRender();
		tui.requestRender(true);
		expect(terminal.writes.length).toBe(0);
		tui.endRenderBatch();
		await waitFor(() => terminal.writes.length === 1);
		expect(stripAnsi(terminal.writes[0] ?? "")).toContain("gamma");
	});
});
