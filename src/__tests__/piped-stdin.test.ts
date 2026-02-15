import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../../dist/cli.js");

/**
 * Spawn the tallow CLI with piped stdin.
 * Waits for first stderr output (or kill timer) to determine routing behavior.
 *
 * @param stdinContent - Content to pipe into stdin
 * @param args - CLI arguments
 * @param env - Extra env vars (TALLOW_INTERACTIVE is stripped unless explicitly set)
 * @returns Exit code and stderr
 */
function runCliWithStdin(
	stdinContent: string,
	args: string[] = [],
	env: Record<string, string> = {}
): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const childEnv = { ...process.env, ...env };
		if (!("TALLOW_INTERACTIVE" in env)) {
			delete childEnv.TALLOW_INTERACTIVE;
		}

		const child = spawn("bun", [CLI, ...args], {
			env: childEnv,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stderr = "";
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		// Kill after 5s — enough for routing decisions, no need for full session
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, 5000);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stderr });
		});

		child.stdin.write(stdinContent);
		child.stdin.end();
	});
}

describe("piped stdin support", () => {
	test("empty piped stdin exits with helpful error", async () => {
		const { code, stderr } = await runCliWithStdin("", ["--no-session"]);

		expect(code).toBe(1);
		expect(stderr).toContain("stdin is piped but empty");
	}, 10000);

	test("piped stdin does not hit nesting guard or empty-pipe error", async () => {
		const { stderr } = await runCliWithStdin("hello world", ["--no-session"]);

		expect(stderr).not.toContain("Cannot start interactive tallow");
		expect(stderr).not.toContain("stdin is piped but empty");
	}, 10000);

	test("piped stdin with -p flag composes without error", async () => {
		const { stderr } = await runCliWithStdin("context", ["-p", "do it", "--no-session"]);

		expect(stderr).not.toContain("Piped input exceeds");
		expect(stderr).not.toContain("stdin is piped but empty");
	}, 10000);

	test("json mode accepts piped stdin instead of -p", async () => {
		const { stderr } = await runCliWithStdin("some input", ["--mode", "json", "--no-session"]);

		expect(stderr).not.toContain("JSON mode requires -p <prompt>");
	}, 10000);

	test("piped stdin bypasses nesting guard with TALLOW_INTERACTIVE=1", async () => {
		const { stderr } = await runCliWithStdin("hello from pipe", ["--no-session"], {
			TALLOW_INTERACTIVE: "1",
		});

		expect(stderr).not.toContain("Cannot start interactive tallow");
		expect(stderr).not.toContain("stdin is piped but empty");
	}, 10000);
});
