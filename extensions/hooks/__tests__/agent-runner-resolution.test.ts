import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
	type HookHandler,
	runAgentHook,
	setHookAgentRunnerResolverForTests,
	setHookAgentSpawnForTests,
} from "../index.js";

/**
 * Minimal ChildProcess fake for hook-agent runner tests.
 */
class FakeAgentChildProcess extends EventEmitter {
	readonly stderr = new PassThrough();
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	pid = 42_321;

	/**
	 * Simulate child termination.
	 *
	 * @returns Always true
	 */
	kill(): boolean {
		this.signalCode = "SIGTERM";
		queueMicrotask(() => this.emit("close", null));
		return true;
	}
}

/**
 * Build a minimal agent hook handler.
 *
 * @returns Hook handler used in tests
 */
function createAgentHandler(): HookHandler {
	return {
		type: "agent",
		prompt: 'Return { "ok": true }',
		timeout: 1,
	};
}

afterEach(() => {
	setHookAgentSpawnForTests();
	setHookAgentRunnerResolverForTests();
});

describe("hook agent runner resolution", () => {
	test("uses explicit runner override candidate", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		setHookAgentRunnerResolverForTests(() => [
			{ command: "custom-tallow", preArgs: [], source: "test" },
		]);
		setHookAgentSpawnForTests(((command: string, args: readonly string[]) => {
			calls.push({ args: [...args], command });
			const child = new FakeAgentChildProcess();
			queueMicrotask(() => child.emit("close", 0));
			return child as unknown as ChildProcess;
		}) as unknown as typeof spawn);

		const result = await runAgentHook(createAgentHandler(), { event: "test" }, process.cwd(), "");
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("custom-tallow");
		expect(calls[0].args).toContain("--mode");
	});

	test("falls back to next runner when preferred runner is missing", async () => {
		const calls: string[] = [];
		setHookAgentRunnerResolverForTests(() => [
			{ command: "missing-runner", preArgs: [], source: "test" },
			{ command: "tallow", preArgs: [], source: "test" },
		]);
		setHookAgentSpawnForTests(((command: string) => {
			calls.push(command);
			const child = new FakeAgentChildProcess();
			queueMicrotask(() => {
				if (command === "missing-runner") {
					const error = Object.assign(new Error("missing"), {
						code: "ENOENT",
					}) as NodeJS.ErrnoException;
					child.emit("error", error);
					return;
				}
				child.emit("close", 0);
			});
			return child as unknown as ChildProcess;
		}) as unknown as typeof spawn);

		const result = await runAgentHook(createAgentHandler(), { event: "test" }, process.cwd(), "");
		expect(result.ok).toBe(true);
		expect(calls).toEqual(["missing-runner", "tallow"]);
	});

	test("returns actionable error when no runner candidates can spawn", async () => {
		setHookAgentRunnerResolverForTests(() => [
			{ command: "missing-a", preArgs: [], source: "test" },
			{ command: "missing-b", preArgs: [], source: "test" },
		]);
		setHookAgentSpawnForTests(((command: string) => {
			const child = new FakeAgentChildProcess();
			queueMicrotask(() => {
				const error = Object.assign(new Error(`${command} not found`), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException;
				child.emit("error", error);
			});
			return child as unknown as ChildProcess;
		}) as unknown as typeof spawn);

		const result = await runAgentHook(createAgentHandler(), { event: "test" }, process.cwd(), "");
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("Hook agent runner not found");
		expect(result.reason).toContain("TALLOW_HOOK_AGENT_RUNNER");
	});
});
