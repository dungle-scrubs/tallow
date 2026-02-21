/**
 * Tests for unconditional fatal error handlers (src/fatal-errors.ts).
 *
 * These run crash scenarios in child processes since the handlers call
 * process.exit(1) — which would kill the test runner if run in-process.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Temp directory for crash logs — isolated per test run. */
let testDir: string;

beforeEach(() => {
	testDir = join(
		tmpdir(),
		`tallow-fatal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup
	}
});

/**
 * Spawn a child process that registers fatal handlers then triggers a crash.
 * Overrides TALLOW_HOME so crash.log lands in the test's temp directory.
 *
 * @param crashScript - Inline JS to execute after registering handlers
 * @returns Exit code, stdout, stderr, and crash log contents
 */
async function runCrashScenario(crashScript: string): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	crashLog: string | null;
}> {
	// Build inline script that imports the compiled module and triggers a crash.
	// TALLOW_HOME env var is set so config.ts resolves to the test directory,
	// which means crash.log lands in an isolated temp dir.
	const distDir = join(process.cwd(), "dist");
	const script = `
		const { registerFatalErrorHandlers } = await import(${JSON.stringify(join(distDir, "fatal-errors.js"))});
		registerFatalErrorHandlers();
		${crashScript}
	`;

	const proc = Bun.spawn(["node", "--input-type=module", "-e", script], {
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

	const crashLogPath = join(testDir, "crash.log");
	const crashLog = existsSync(crashLogPath) ? readFileSync(crashLogPath, "utf-8") : null;

	return { exitCode, stdout, stderr, crashLog };
}

describe("Fatal error handlers", () => {
	it("catches uncaught exceptions with exit code 1 and FATAL banner", async () => {
		const { exitCode, stderr } = await runCrashScenario(`
			throw new Error("test explosion");
		`);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("FATAL");
		expect(stderr).toContain("Uncaught exception");
		expect(stderr).toContain("test explosion");
	});

	it("catches unhandled promise rejections with exit code 1 and FATAL banner", async () => {
		const { exitCode, stderr } = await runCrashScenario(`
			Promise.reject(new Error("async kaboom"));
			// Keep the process alive long enough for the rejection to fire
			setTimeout(() => {}, 2000);
		`);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("FATAL");
		expect(stderr).toContain("Unhandled promise rejection");
		expect(stderr).toContain("async kaboom");
	});

	it("writes crash log with timestamp and stack trace", async () => {
		const { crashLog } = await runCrashScenario(`
			throw new Error("logged crash");
		`);

		expect(crashLog).not.toBeNull();
		expect(crashLog).toContain("Uncaught exception");
		expect(crashLog).toContain("logged crash");
		expect(crashLog).toContain("Stack:");
		// Timestamp format: [2026-02-15T...]
		expect(crashLog).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
	});

	it("includes crash log path in banner", async () => {
		const { stderr } = await runCrashScenario(`
			throw new Error("path check");
		`);

		expect(stderr).toContain("crash.log");
		expect(stderr).toContain("Crash log:");
	});

	it("includes /diagnostics-on hint in banner", async () => {
		const { stderr } = await runCrashScenario(`
			throw new Error("hint check");
		`);

		expect(stderr).toContain("/diagnostics-on");
	});

	it("handles non-Error rejection values", async () => {
		const { exitCode, stderr } = await runCrashScenario(`
			Promise.reject("plain string rejection");
			setTimeout(() => {}, 2000);
		`);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("FATAL");
		expect(stderr).toContain("plain string rejection");
	});

	it("truncates very long error messages in banner", async () => {
		const { stderr } = await runCrashScenario(`
			throw new Error("x".repeat(1000));
		`);

		expect(stderr).toContain("FATAL");
		// Banner should truncate at 500 chars + ellipsis
		expect(stderr).toContain("…");
		// Full message should NOT appear in stderr
		expect(stderr).not.toContain("x".repeat(1000));
	});
});
