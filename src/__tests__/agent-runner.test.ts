import { describe, expect, test } from "bun:test";
import { formatMissingAgentRunnerError, resolveAgentRunnerCandidates } from "../agent-runner.js";

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

	test("formats missing-runner diagnostics with no candidates", () => {
		const reason = formatMissingAgentRunnerError([], "TALLOW_HOOK_AGENT_RUNNER");
		expect(reason).toContain("Tried: (none)");
	});
});
