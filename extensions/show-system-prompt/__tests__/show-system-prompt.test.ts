import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import showPrompt from "../index.js";

describe("show-system-prompt extension", () => {
	test("registers show-system-prompt command", () => {
		const commands: string[] = [];
		const pi = {
			registerCommand: (name: string) => {
				commands.push(name);
			},
		} as unknown as ExtensionAPI;

		showPrompt(pi);
		expect(commands).toContain("show-system-prompt");
	});

	test("handler logs system prompt and notifies", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (
				_name: string,
				opts: { handler: (args: string, ctx: unknown) => Promise<void> }
			) => {
				handler = opts.handler;
			},
		} as unknown as ExtensionAPI;

		showPrompt(pi);

		const notify = mock(() => {});
		const ctx = {
			getSystemPrompt: () => "You are a test prompt",
			ui: { notify },
		};

		const origLog = console.log;
		const logged: string[] = [];
		console.log = (...args: unknown[]) => {
			logged.push(args.join(" "));
		};
		try {
			await handler!("", ctx);
		} finally {
			console.log = origLog;
		}

		expect(logged.some((l) => l.includes("You are a test prompt"))).toBe(true);
		expect(notify).toHaveBeenCalledWith("System prompt logged to terminal", "info");
	});
});
