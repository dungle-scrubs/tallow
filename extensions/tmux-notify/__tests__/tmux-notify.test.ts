import { describe, expect, it } from "bun:test";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import tmuxNotify, { createTmuxNotifyLifecycle, type TmuxStatus } from "../index.js";

describe("createTmuxNotifyLifecycle", () => {
	it("coalesces lifecycle status writes", () => {
		const statuses: TmuxStatus[] = [];
		const lifecycle = createTmuxNotifyLifecycle({ setStatus: (value) => statuses.push(value) });

		lifecycle.onSessionStart();
		lifecycle.onBeforeAgentStart();
		lifecycle.onAgentStart();
		lifecycle.onAgentEnd();
		const inputResult = lifecycle.onInput();
		lifecycle.onSessionShutdown();

		expect(inputResult).toEqual({ action: "continue" });
		expect(statuses).toEqual(["", "working", "done", ""]);
	});
});

describe("tmuxNotify", () => {
	it("does not register handlers outside tmux", async () => {
		const savedTmux = process.env.TMUX;
		delete process.env.TMUX;
		try {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(tmuxNotify);
			expect(harness.handlers.size).toBe(0);
		} finally {
			if (savedTmux !== undefined) {
				process.env.TMUX = savedTmux;
			}
		}
	});
});
