/**
 * Tests for src/process-cleanup.ts — signal handlers and stream error recovery.
 *
 * Since registerProcessCleanup installs signal handlers that call process.exit,
 * tests run scenarios in child processes to avoid killing the test runner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "tallow-cleanup-test-"));
});

afterEach(() => {
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

/**
 * Run a child process that imports process-cleanup and executes a test script.
 *
 * @param script - Inline JS to execute after importing the module
 * @returns Exit code, stdout, and stderr
 */
async function runCleanupScenario(script: string): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const distDir = join(process.cwd(), "dist");
	const fullScript = `
		const { registerProcessCleanup } = await import(${JSON.stringify(join(distDir, "process-cleanup.js"))});
		${script}
	`;

	const proc = Bun.spawn(["node", "--input-type=module", "-e", fullScript], {
		env: {
			...process.env,
			TALLOW_HOME: testDir,
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

describe("registerProcessCleanup", () => {
	test("returns a mutable session ref", async () => {
		const { exitCode, stdout } = await runCleanupScenario(`
			const ref = registerProcessCleanup();
			// The ref is a plain object — current starts as undefined
			const isObject = typeof ref === "object" && ref !== null;
			const currentIsUndefined = ref.current === undefined;
			// Verify mutability
			ref.current = "test-session";
			const canMutate = ref.current === "test-session";
			process.stdout.write(JSON.stringify({ isObject, currentIsUndefined, canMutate }));
			process.exit(0);
		`);

		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.isObject).toBe(true);
		expect(result.currentIsUndefined).toBe(true);
		expect(result.canMutate).toBe(true);
	});

	test("handles SIGTERM with exit code 143", async () => {
		const { exitCode } = await runCleanupScenario(`
			registerProcessCleanup();
			// Send SIGTERM to self after a brief delay
			setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
			// Keep alive long enough for the signal
			setTimeout(() => {}, 5000);
		`);

		// SIGTERM → cleanup → exit(143)
		expect(exitCode).toBe(143);
	});

	test("handles SIGINT with exit code 130", async () => {
		const { exitCode } = await runCleanupScenario(`
			registerProcessCleanup();
			setTimeout(() => process.kill(process.pid, "SIGINT"), 50);
			setTimeout(() => {}, 5000);
		`);

		expect(exitCode).toBe(130);
	});

	test("second signal during cleanup forces immediate exit", async () => {
		// Send two SIGTERMs in rapid succession — the second should force-exit
		const { exitCode } = await runCleanupScenario(`
			registerProcessCleanup();
			setTimeout(() => {
				process.kill(process.pid, "SIGTERM");
				// Second signal 10ms later should force immediate exit
				setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
			}, 50);
			setTimeout(() => {}, 5000);
		`);

		expect(exitCode).toBe(143);
	});
});
