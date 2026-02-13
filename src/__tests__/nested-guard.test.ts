import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../../dist/cli.js");

/**
 * Spawn the tallow CLI with given args and env overrides.
 * Resolves with { code, stdout, stderr } after the process exits or is killed.
 *
 * @param args - CLI arguments
 * @param env - Extra env vars merged into process.env
 * @param timeoutMs - Kill the process after this many ms (default: 5000)
 * @returns Exit code, stdout, and stderr
 */
function runCli(
	args: string[],
	env: Record<string, string> = {},
	timeoutMs = 5000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("bun", [CLI, ...args], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

describe("nested interactive session guard", () => {
	test("blocks interactive mode when TALLOW_INTERACTIVE=1", async () => {
		const { code, stderr } = await runCli([], { TALLOW_INTERACTIVE: "1" });

		expect(code).toBe(1);
		expect(stderr).toContain(
			"Cannot start interactive tallow inside an existing interactive session"
		);
	});

	test("allows print mode when TALLOW_INTERACTIVE=1", async () => {
		// Print mode may hang (needs API key / session setup) — kill after 3s
		const { stderr } = await runCli(["-p", "hello"], { TALLOW_INTERACTIVE: "1" }, 3000);

		// Should NOT contain the nesting error — may fail for other reasons (no API key)
		expect(stderr).not.toContain(
			"Cannot start interactive tallow inside an existing interactive session"
		);
	});

	test("allows interactive mode without TALLOW_INTERACTIVE", async () => {
		// Unset the sentinel; process may be killed or exit for unrelated setup reasons
		const { stderr } = await runCli([], { TALLOW_INTERACTIVE: "" }, 2000);

		// The nested-session guard must not trigger when sentinel is unset.
		expect(stderr).not.toContain(
			"Cannot start interactive tallow inside an existing interactive session"
		);
	});
});
