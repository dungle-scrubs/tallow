import { describe, expect, it } from "bun:test";
import renderStabilizerExtension from "../index.js";

describe("render-stabilizer extension", () => {
	it("registers only the legacy session_before_switch hook", () => {
		const handlers = new Map<string, unknown[]>();

		const mockPi = {
			on(event: string, handler: unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)?.push(handler);
			},
		};

		renderStabilizerExtension(mockPi as never);

		expect(handlers.has("session_start")).toBe(false);
		expect(handlers.has("session_before_switch")).toBe(true);
		expect(handlers.get("session_before_switch")?.length).toBe(1);
	});

	it("does not register any commands or tools", () => {
		let commandCount = 0;
		let toolCount = 0;

		const mockPi = {
			on() {},
			registerCommand() {
				commandCount++;
			},
			registerTool() {
				toolCount++;
			},
		};

		renderStabilizerExtension(mockPi as never);

		expect(commandCount).toBe(0);
		expect(toolCount).toBe(0);
	});
});
