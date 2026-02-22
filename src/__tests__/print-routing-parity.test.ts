import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../dist/cli.js");
const INVALID_MODEL = "tallow-test-provider/tallow-test-model";
const NESTED_GUARD_ERROR = "Cannot start interactive tallow inside an existing interactive session";
const MODEL_NOT_FOUND_ERROR = `Model ${INVALID_MODEL} not found`;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
	tempDirs.length = 0;
});

interface RunCliOptions {
	args: string[];
	env?: Record<string, string>;
	stdinContent?: string;
	timeoutMs?: number;
}

/**
 * Create a temporary TALLOW_HOME for child CLI runs.
 *
 * @returns Absolute path to an isolated temp home directory
 */
function makeTempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "tallow-print-routing-home-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * Run the CLI with optional stdin and env overrides.
 *
 * @param options - CLI invocation options
 * @returns Exit code with captured stdout/stderr
 */
function runCli(
	options: RunCliOptions
): Promise<{ code: number | null; stderr: string; stdout: string }> {
	const timeoutMs = options.timeoutMs ?? 4000;

	return new Promise((resolveResult) => {
		const child = spawn("bun", [CLI, ...options.args], {
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolveResult({ code, stderr, stdout });
		});

		if (options.stdinContent !== undefined) {
			child.stdin.write(options.stdinContent);
		}
		child.stdin.end();
	});
}

describe("print-mode routing parity", () => {
	test("-p and piped stdin both route past nested-guard when TALLOW_INTERACTIVE=1", async () => {
		const home = makeTempHome();
		const sharedEnv = {
			TALLOW_HOME: home,
			TALLOW_INTERACTIVE: "1",
		};
		const sharedArgs = ["--model", INVALID_MODEL, "--no-session"];

		const withPrompt = await runCli({
			args: [...sharedArgs, "-p", "hello from flag"],
			env: sharedEnv,
		});
		const withPipe = await runCli({
			args: sharedArgs,
			env: sharedEnv,
			stdinContent: "hello from stdin",
		});

		for (const result of [withPrompt, withPipe]) {
			expect(result.code).toBe(1);
			expect(result.stderr).not.toContain(NESTED_GUARD_ERROR);
			expect(result.stderr).not.toContain("stdin is piped but empty");
			expect(result.stderr).toContain(MODEL_NOT_FOUND_ERROR);
		}
	});

	test("stdin + -p composition follows the same print routing path", async () => {
		const home = makeTempHome();
		const result = await runCli({
			args: ["--model", INVALID_MODEL, "--no-session", "-p", "final instruction"],
			env: {
				TALLOW_HOME: home,
				TALLOW_INTERACTIVE: "1",
			},
			stdinContent: "context block",
		});

		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain(NESTED_GUARD_ERROR);
		expect(result.stderr).not.toContain("stdin is piped but empty");
		expect(result.stderr).toContain(MODEL_NOT_FOUND_ERROR);
	});
});
