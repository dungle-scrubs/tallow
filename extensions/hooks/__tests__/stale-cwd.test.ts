import { describe, expect, test } from "bun:test";
import { type HookHandler, runAgentHook, runCommandHook } from "../index.js";

/** Nonexistent directory path — guaranteed to not exist on any system. */
const MISSING_CWD = "/tmp/tallow-test-nonexistent-dir-stale-cwd-bug193";

/**
 * Build a minimal command hook handler for testing.
 *
 * @param command - Shell command to execute
 * @returns Command-type hook handler
 */
function createCommandHandler(command: string): HookHandler {
	return {
		command,
		timeout: 5,
		type: "command",
	};
}

/**
 * Build a minimal agent hook handler for testing.
 *
 * @param agent - Agent name
 * @returns Agent-type hook handler
 */
function createAgentHandler(agent: string): HookHandler {
	return {
		agent,
		prompt: "test prompt",
		timeout: 5,
		type: "agent",
	};
}

describe("stale cwd handling", () => {
	describe("runCommandHook", () => {
		test("returns infrastructure error for nonexistent cwd", async () => {
			const handler = createCommandHandler("echo ok");
			const result = await runCommandHook(handler, {}, MISSING_CWD);

			expect(result.ok).toBe(false);
			expect(result.infrastructureError).toBe(true);
			expect(result.reason).toContain("cwd no longer exists");
			expect(result.reason).toContain(MISSING_CWD);
		});

		test("does not set decision: block for missing cwd", async () => {
			const handler = createCommandHandler("echo ok");
			const result = await runCommandHook(handler, {}, MISSING_CWD);

			expect(result.decision).toBeUndefined();
		});

		test("still works normally with valid cwd", async () => {
			const handler = createCommandHandler(
				'node -e "process.stdout.write(JSON.stringify({ok:true}))"'
			);
			const result = await runCommandHook(handler, {}, process.cwd());

			expect(result.ok).toBe(true);
			expect(result.infrastructureError).toBeUndefined();
		});
	});

	describe("runAgentHook", () => {
		test("returns infrastructure error for nonexistent cwd", async () => {
			const handler = createAgentHandler("test-agent");
			const result = await runAgentHook(handler, {}, MISSING_CWD, "/tmp");

			expect(result.ok).toBe(false);
			expect(result.infrastructureError).toBe(true);
			expect(result.reason).toContain("cwd no longer exists");
			expect(result.reason).toContain(MISSING_CWD);
		});

		test("does not set decision: block for missing cwd", async () => {
			const handler = createAgentHandler("test-agent");
			const result = await runAgentHook(handler, {}, MISSING_CWD, "/tmp");

			expect(result.decision).toBeUndefined();
		});
	});

	describe("infrastructure vs policy distinction", () => {
		test("infrastructure error result shape differs from policy block", async () => {
			// Infrastructure error: missing cwd
			const infraHandler = createCommandHandler("echo ok");
			const infraResult = await runCommandHook(infraHandler, {}, MISSING_CWD);

			// Policy block: exit code 2
			const policyHandler = createCommandHandler("exit 2");
			const policyResult = await runCommandHook(policyHandler, {}, process.cwd());

			// Both are ok: false
			expect(infraResult.ok).toBe(false);
			expect(policyResult.ok).toBe(false);

			// Infrastructure error is flagged, policy block is not
			expect(infraResult.infrastructureError).toBe(true);
			expect(policyResult.infrastructureError).toBeUndefined();

			// Policy block has decision: "block", infrastructure error does not
			expect(policyResult.decision).toBe("block");
			expect(infraResult.decision).toBeUndefined();
		});
	});
});
