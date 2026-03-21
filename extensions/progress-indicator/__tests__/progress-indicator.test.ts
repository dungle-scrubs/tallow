import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import progressIndicator from "../index.js";

describe("progress-indicator extension", () => {
	let originalIsTTY: boolean;
	let written: string[];
	let originalWrite: typeof process.stdout.write;

	beforeEach(() => {
		originalIsTTY = process.stdout.isTTY;
		originalWrite = process.stdout.write;
		written = [];
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		process.stdout.write = ((chunk: string) => {
			written.push(chunk);
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		Object.defineProperty(process.stdout, "isTTY", {
			value: originalIsTTY,
			configurable: true,
		});
		process.stdout.write = originalWrite;
	});

	test("registers turn_start, turn_end, agent_end, session_shutdown handlers", () => {
		const events: string[] = [];
		const pi = {
			on: (event: string) => {
				events.push(event);
			},
		} as unknown as ExtensionAPI;

		progressIndicator(pi);
		expect(events).toContain("turn_start");
		expect(events).toContain("turn_end");
		expect(events).toContain("agent_end");
		expect(events).toContain("session_shutdown");
	});

	test("turn_start writes indeterminate OSC sequence", () => {
		const handlers: Record<string, () => void> = {};
		const pi = {
			on: (event: string, handler: () => void) => {
				handlers[event] = handler;
			},
		} as unknown as ExtensionAPI;

		progressIndicator(pi);
		handlers.turn_start();

		expect(written).toHaveLength(1);
		expect(written[0]).toContain("9;4;3");
	});

	test("turn_end writes clear OSC sequence", () => {
		const handlers: Record<string, () => void> = {};
		const pi = {
			on: (event: string, handler: () => void) => {
				handlers[event] = handler;
			},
		} as unknown as ExtensionAPI;

		progressIndicator(pi);
		handlers.turn_end();

		expect(written).toHaveLength(1);
		expect(written[0]).toContain("9;4;0");
	});

	test("agent_end writes clear OSC sequence", () => {
		const handlers: Record<string, () => void> = {};
		const pi = {
			on: (event: string, handler: () => void) => {
				handlers[event] = handler;
			},
		} as unknown as ExtensionAPI;

		progressIndicator(pi);
		handlers.agent_end();

		expect(written).toHaveLength(1);
		expect(written[0]).toContain("9;4;0");
	});

	test("skips write when stdout is not a TTY", () => {
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

		const handlers: Record<string, () => void> = {};
		const pi = {
			on: (event: string, handler: () => void) => {
				handlers[event] = handler;
			},
		} as unknown as ExtensionAPI;

		progressIndicator(pi);
		handlers.turn_start();

		expect(written).toHaveLength(0);
	});
});
