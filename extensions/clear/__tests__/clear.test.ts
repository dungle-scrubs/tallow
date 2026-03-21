import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerClear from "../index.js";

describe("clear extension", () => {
	test("registers /clear command", () => {
		const commands: Array<{ name: string; description: string }> = [];
		const pi = {
			registerCommand: (name: string, opts: { description: string }) => {
				commands.push({ name, description: opts.description });
			},
		} as unknown as ExtensionAPI;

		registerClear(pi);

		expect(commands).toHaveLength(1);
		expect(commands[0].name).toBe("clear");
		expect(commands[0].description).toContain("new session");
	});

	test("handler calls ctx.newSession()", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (
				_name: string,
				opts: { handler: (args: string, ctx: unknown) => Promise<void> }
			) => {
				handler = opts.handler;
			},
		} as unknown as ExtensionAPI;

		registerClear(pi);

		const newSession = mock(() => Promise.resolve());
		await handler!("", { newSession });
		expect(newSession).toHaveBeenCalledTimes(1);
	});
});
