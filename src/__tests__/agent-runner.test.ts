import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	DEFAULT_AGENT_RUNNER_ENV,
	formatMissingAgentRunnerError,
	formatMissingRunnerError,
	resolveAgentRunnerCandidates,
	spawnWithResolvedAgentRunner,
} from "../agent-runner.js";

/**
 * Minimal child-process fake for runner spawn tests.
 */
class FakeChildProcess extends EventEmitter {
	stdout = null;
	stderr = null;
	stdin = null;
	pid = 1234;
	kill(): boolean {
		return true;
	}
}

describe("agent runner resolution", () => {
	test("applies override, current process, primary, and legacy precedence", () => {
		const candidates = resolveAgentRunnerCandidates({
			env: { TALLOW_HOOK_AGENT_RUNNER: "custom-runner" },
			execPath: "/usr/local/bin/node",
			argv: ["node", "/work/tallow/dist/cli.js"],
			overrideEnvVar: "TALLOW_HOOK_AGENT_RUNNER",
		});

		expect(candidates.map((candidate) => candidate.command)).toEqual([
			"custom-runner",
			"/usr/local/bin/node",
			"tallow",
			"pi",
		]);
		expect(candidates[1]?.preArgs).toEqual(["/work/tallow/dist/cli.js"]);
	});

	test("deduplicates candidates while preserving first occurrence", () => {
		const candidates = resolveAgentRunnerCandidates({
			env: { TALLOW_HOOK_AGENT_RUNNER: "tallow" },
			overrideEnvVar: "TALLOW_HOOK_AGENT_RUNNER",
			argv: ["node", "not-tallow.js"],
		});

		expect(candidates.map((candidate) => candidate.command)).toEqual(["tallow", "pi"]);
	});

	test("skips current process candidate when entrypoint is unrelated", () => {
		const candidates = resolveAgentRunnerCandidates({
			overrideEnvVar: "TALLOW_HOOK_AGENT_RUNNER",
			argv: ["node", "/tmp/other-cli.js"],
			env: {},
		});

		expect(candidates.map((candidate) => candidate.command)).toEqual(["tallow", "pi"]);
	});
});

describe("agent runner resolution diagnostics", () => {
	test("formats missing-runner diagnostics with attempted candidates", () => {
		const reason = formatMissingAgentRunnerError(
			[
				{ command: "missing-a", preArgs: [], source: "PATH" },
				{ command: "missing-b", preArgs: [], source: "PATH" },
			],
			"TALLOW_HOOK_AGENT_RUNNER",
			"ENOENT"
		);

		expect(reason).toContain("missing-a, missing-b");
		expect(reason).toContain("TALLOW_HOOK_AGENT_RUNNER");
		expect(reason).toContain("ENOENT");
	});

	test("formats generic runner diagnostics", () => {
		const reason = formatMissingRunnerError(
			"Subagent",
			[{ command: "missing-tallow", preArgs: [], source: "PATH" }],
			DEFAULT_AGENT_RUNNER_ENV,
			"ENOENT"
		);

		expect(reason).toContain("Subagent runner not found");
		expect(reason).toContain(DEFAULT_AGENT_RUNNER_ENV);
	});

	test("formats missing-runner diagnostics with no candidates", () => {
		const reason = formatMissingAgentRunnerError([], "TALLOW_HOOK_AGENT_RUNNER");
		expect(reason).toContain("Tried: (none)");
	});
});

describe("spawnWithResolvedAgentRunner", () => {
	test("falls back to the next runner on ENOENT", async () => {
		const calls: string[] = [];
		const result = await spawnWithResolvedAgentRunner({
			args: ["--mode", "json"],
			runnerLabel: "Subagent",
			resolution: {
				argv: ["node", "/tmp/other.js"],
				env: {},
				overrideEnvVar: DEFAULT_AGENT_RUNNER_ENV,
			},
			spawnImpl: ((command: string) => {
				calls.push(command);
				const child = new FakeChildProcess();
				queueMicrotask(() => {
					if (command === "tallow") {
						const error = Object.assign(new Error("missing tallow"), {
							code: "ENOENT",
						}) as NodeJS.ErrnoException;
						child.emit("error", error);
						return;
					}
					child.emit("spawn");
				});
				return child as unknown as ChildProcess;
			}) as typeof import("node:child_process").spawn,
			spawnOptions: {
				cwd: process.cwd(),
				env: process.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			},
		});

		expect(result.ok).toBe(true);
		expect(calls).toEqual(["tallow", "pi"]);
	});

	test("returns a diagnostic when all runners are missing", async () => {
		const result = await spawnWithResolvedAgentRunner({
			args: ["--mode", "json"],
			runnerLabel: "Context fork",
			resolution: {
				argv: ["node", "/tmp/other.js"],
				env: {},
				overrideEnvVar: DEFAULT_AGENT_RUNNER_ENV,
			},
			spawnImpl: (() => {
				const child = new FakeChildProcess();
				queueMicrotask(() => {
					const error = Object.assign(new Error("runner missing"), {
						code: "ENOENT",
					}) as NodeJS.ErrnoException;
					child.emit("error", error);
				});
				return child as unknown as ChildProcess;
			}) as typeof import("node:child_process").spawn,
			spawnOptions: {
				cwd: process.cwd(),
				env: process.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			},
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("Context fork runner not found");
			expect(result.reason).toContain(DEFAULT_AGENT_RUNNER_ENV);
		}
	});
});
