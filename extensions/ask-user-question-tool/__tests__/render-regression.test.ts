/**
 * Regression tests for ask_user_question custom UI rendering.
 *
 * Validates multiline option content never leaks embedded newlines into
 * render rows and that repeated arrow navigation rerenders remain stable.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import askUserQuestion from "../index.js";

/** Shape of the custom component returned by `ctx.ui.custom(...)`. */
interface RenderComponentLike {
	handleInput: (data: string) => void;
	invalidate: () => void;
	render: (width: number) => string[];
}

/** Driver returned by {@link createInteractiveContextHarness}. */
interface InteractiveContextHarness {
	ctx: ExtensionContext;
	getComponent: () => RenderComponentLike;
	getRenderRequestCount: () => number;
}

/** Raw terminal sequence for the Down arrow key. */
const KEY_DOWN = "\u001b[B";
/** Raw terminal sequence for Escape key. */
const KEY_ESCAPE = "\u001b";

/**
 * Builds an interactive context stub and captures the custom UI component.
 *
 * The returned context implements `ctx.ui.custom(...)` by instantiating the
 * component immediately and resolving when the component calls `done(...)`.
 *
 * @returns Harness with context and captured component accessors
 */
function createInteractiveContextHarness(): InteractiveContextHarness {
	let component: RenderComponentLike | null = null;
	let renderRequestCount = 0;

	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setWorkingMessage() {},
			async custom(factory: unknown) {
				const createComponent = factory as (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (value: unknown) => void
				) => RenderComponentLike;

				return await new Promise((resolve) => {
					component = createComponent(
						{
							requestRender() {
								renderRequestCount += 1;
							},
						},
						{
							bold: (value: string) => value,
							fg: (_color: string, value: string) => value,
						},
						{},
						(value: unknown) => {
							resolve(value);
						}
					);
				});
			},
		} as unknown as ExtensionContext["ui"],
	} as ExtensionContext;

	return {
		ctx,
		getComponent() {
			if (!component) {
				throw new Error("Custom component was not created yet");
			}
			return component;
		},
		getRenderRequestCount() {
			return renderRequestCount;
		},
	};
}

/**
 * Ensures the current microtask queue has drained.
 * @returns Promise resolved on the next microtask tick
 */
async function nextTick(): Promise<void> {
	await Promise.resolve();
}

describe("ask_user_question render regression", () => {
	test("renders newline-safe rows for multiline labels and descriptions", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(askUserQuestion);

		const tool = harness.tools.get("ask_user_question");
		expect(tool).toBeDefined();
		if (!tool) {
			throw new Error("ask_user_question tool is not registered");
		}

		const interactive = createInteractiveContextHarness();
		const runPromise = tool.execute(
			"test-id",
			{
				question: "Pick one option",
				options: [
					{
						description: "first description line\nsecond description line",
						label: "Option A\nExtra Label",
					},
					{
						description: "single line",
						label: "Option B",
					},
				],
			},
			new AbortController().signal,
			() => {},
			interactive.ctx
		);

		await nextTick();
		const component = interactive.getComponent();

		const firstRender = component.render(44);
		component.handleInput(KEY_DOWN);
		const secondRender = component.render(44);

		component.handleInput(KEY_ESCAPE);
		const result = await runPromise;

		expect(firstRender.every((line) => !line.includes("\n"))).toBe(true);
		expect(secondRender.every((line) => !line.includes("\n"))).toBe(true);
		expect(result.content[0]?.text).toBe("User cancelled the selection");
	});

	test("keeps line count stable during repeated down-arrow rerenders", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(askUserQuestion);

		const tool = harness.tools.get("ask_user_question");
		expect(tool).toBeDefined();
		if (!tool) {
			throw new Error("ask_user_question tool is not registered");
		}

		const interactive = createInteractiveContextHarness();
		const runPromise = tool.execute(
			"test-id",
			{
				question: "Navigate options",
				options: [
					{
						description: "Line 1\nLine 2\nLine 3",
						label: "Alpha",
					},
					{
						description: "Desc B",
						label: "Bravo",
					},
					{
						description: "Desc C",
						label: "Charlie",
					},
				],
			},
			new AbortController().signal,
			() => {},
			interactive.ctx
		);

		await nextTick();
		const component = interactive.getComponent();

		const width = 46;
		const lineCounts: number[] = [component.render(width).length];
		const renderSnapshots: string[][] = [component.render(width)];

		for (let i = 0; i < 8; i++) {
			component.handleInput(KEY_DOWN);
			const snapshot = component.render(width);
			lineCounts.push(snapshot.length);
			renderSnapshots.push(snapshot);
		}

		component.handleInput(KEY_ESCAPE);
		await runPromise;

		expect(new Set(lineCounts).size).toBe(1);
		expect(renderSnapshots.flat().every((line) => !line.includes("\n"))).toBe(true);
		expect(interactive.getRenderRequestCount()).toBeGreaterThan(0);
	});
});
