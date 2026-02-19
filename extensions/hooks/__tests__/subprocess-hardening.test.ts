import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HOOK_OUTPUT_TRUNCATION_MARKER, type HookHandler, runCommandHook } from "../index.js";

const HOOK_OUTPUT_MAX_BUFFER_BYTES_ENV = "TALLOW_HOOK_MAX_BUFFER_BYTES";
const HOOK_FORCE_KILL_GRACE_MS_ENV = "TALLOW_HOOK_FORCE_KILL_GRACE_MS";

let originalOutputCap: string | undefined;
let originalKillGrace: string | undefined;

/**
 * Build a command hook handler for subprocess hardening tests.
 *
 * @param command - Shell command executed by the hook
 * @param timeoutSeconds - Hook timeout in seconds
 * @returns Command-type hook handler
 */
function createCommandHandler(command: string, timeoutSeconds: number): HookHandler {
	return {
		command,
		timeout: timeoutSeconds,
		type: "command",
	};
}

beforeEach(() => {
	originalOutputCap = process.env[HOOK_OUTPUT_MAX_BUFFER_BYTES_ENV];
	originalKillGrace = process.env[HOOK_FORCE_KILL_GRACE_MS_ENV];
	delete process.env[HOOK_OUTPUT_MAX_BUFFER_BYTES_ENV];
	delete process.env[HOOK_FORCE_KILL_GRACE_MS_ENV];
});

afterEach(() => {
	if (originalOutputCap === undefined) {
		delete process.env[HOOK_OUTPUT_MAX_BUFFER_BYTES_ENV];
	} else {
		process.env[HOOK_OUTPUT_MAX_BUFFER_BYTES_ENV] = originalOutputCap;
	}

	if (originalKillGrace === undefined) {
		delete process.env[HOOK_FORCE_KILL_GRACE_MS_ENV];
	} else {
		process.env[HOOK_FORCE_KILL_GRACE_MS_ENV] = originalKillGrace;
	}
});

describe("hook subprocess hardening", () => {
	test("normal command hook semantics remain unchanged", async () => {
		const handler = createCommandHandler(
			"node -e \"process.stdout.write(JSON.stringify({ok:true,additionalContext:'ok-context'}))\"",
			2
		);
		const result = await runCommandHook(handler, { test: true }, process.cwd());

		expect(result.ok).toBe(true);
		expect(result.additionalContext).toBe("ok-context");
		expect(result.reason).toBeUndefined();
	});

	test("large stdout is truncated to bounded output", async () => {
		process.env[HOOK_OUTPUT_MAX_BUFFER_BYTES_ENV] = "256";
		const handler = createCommandHandler("node -e \"process.stdout.write('x'.repeat(8192))\"", 2);
		const result = await runCommandHook(handler, { stream: "stdout" }, process.cwd());

		expect(result.ok).toBe(true);
		expect(result.additionalContext).toContain(HOOK_OUTPUT_TRUNCATION_MARKER.trim());
		expect(result.additionalContext?.length ?? 0).toBeLessThanOrEqual(
			256 + HOOK_OUTPUT_TRUNCATION_MARKER.length
		);
	});

	test("large stderr is truncated and still blocks on exit code 2", async () => {
		process.env[HOOK_OUTPUT_MAX_BUFFER_BYTES_ENV] = "256";
		const handler = createCommandHandler(
			"node -e \"process.stderr.write('e'.repeat(8192)); process.exit(2)\"",
			2
		);
		const result = await runCommandHook(handler, { stream: "stderr" }, process.cwd());

		expect(result.ok).toBe(false);
		expect(result.decision).toBe("block");
		expect(result.reason).toContain(HOOK_OUTPUT_TRUNCATION_MARKER.trim());
		expect(result.reason?.length ?? 0).toBeLessThanOrEqual(
			256 + HOOK_OUTPUT_TRUNCATION_MARKER.length
		);
	});

	test("timed out hooks escalate to force-kill after grace period", async () => {
		process.env[HOOK_FORCE_KILL_GRACE_MS_ENV] = "25";
		const handler = createCommandHandler("trap '' TERM; while true; do :; done", 0.02);

		const startedAt = Date.now();
		const result = await runCommandHook(handler, { mode: "timeout" }, process.cwd());
		const elapsedMs = Date.now() - startedAt;

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("Hook timed out or was aborted");
		expect(elapsedMs).toBeGreaterThanOrEqual(20);
		expect(elapsedMs).toBeLessThan(1000);
	});

	test("aborted hooks follow the same termination escalation path", async () => {
		process.env[HOOK_FORCE_KILL_GRACE_MS_ENV] = "25";
		const controller = new AbortController();
		const handler = createCommandHandler("trap '' TERM; while true; do :; done", 5);

		const startedAt = Date.now();
		setTimeout(() => controller.abort(), 20);
		const result = await runCommandHook(
			handler,
			{ mode: "abort" },
			process.cwd(),
			controller.signal
		);
		const elapsedMs = Date.now() - startedAt;

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("Hook timed out or was aborted");
		expect(elapsedMs).toBeGreaterThanOrEqual(20);
		expect(elapsedMs).toBeLessThan(1000);
	});
});
