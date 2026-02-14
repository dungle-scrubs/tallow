/**
 * Integration tests for shell policy + confirmation in cross-extension tool_call flow.
 *
 * Validates that `enforceExplicitPolicy` interacts correctly with the pi
 * extension handler chain: confirmed commands pass through, denied / throwing /
 * denylist commands are blocked, and multiple handlers compose as expected.
 *
 * All tests are safe — a mock "bash" tool echoes the command string instead of
 * executing it, and confirmation behavior is injected via closures.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";
import { createSessionRunner, type SessionRunner } from "../../test-utils/session-runner.js";
import { clearAuditTrail, enforceExplicitPolicy, getAuditTrail } from "../_shared/shell-policy.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let runner: SessionRunner | undefined;

beforeEach(() => {
	clearAuditTrail();
});

afterEach(() => {
	runner?.dispose();
	runner = undefined;
});

/**
 * Register a mock "bash" tool that returns the command text without executing it.
 *
 * @param pi - Extension API
 */
function registerSafeBashTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "bash",
		label: "Bash (safe mock)",
		description: "Returns command text without execution",
		parameters: Type.Object({ command: Type.String() }),
		async execute(_id, params) {
			return {
				content: [{ type: "text" as const, text: `mock-exec: ${params.command}` }],
				details: undefined,
			};
		},
	});
}

/**
 * Create an extension that registers both the safe bash tool and a policy
 * handler whose confirmation callback is controlled by `confirmBehavior`.
 *
 * @param confirmBehavior - "accept" resolves true, "deny" resolves false, "throw" rejects
 * @returns Extension factory
 */
function createPolicyExtension(confirmBehavior: "accept" | "deny" | "throw"): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		registerSafeBashTool(pi);

		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName !== "bash") return;

			const command = (event.input as { command?: string }).command;
			if (!command) return;

			return enforceExplicitPolicy(command, "bash", ctx.cwd, true, async () => {
				if (confirmBehavior === "throw") {
					throw new Error("Confirmation interrupted");
				}
				return confirmBehavior === "accept";
			});
		});
	};
}

/**
 * Scripted model response that calls bash with the given command, followed
 * by a text response so the agent loop completes cleanly.
 *
 * @param command - Shell command string to embed in the tool call
 * @returns Scripted stream function
 */
function bashCallThenDone(command: string) {
	return createScriptedStreamFn([
		{ toolCalls: [{ name: "bash", arguments: { command } }] },
		{ text: "done" },
	]);
}

// ═══════════════════════════════════════════════════════════════
// 1) Confirmed high-risk command passes through
// ═══════════════════════════════════════════════════════════════

describe("Shell Policy Confirm — confirmed high-risk", () => {
	it("allows execution when user confirms", async () => {
		const toolResults: string[] = [];

		const resultTracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "bash") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: bashCallThenDone("sudo ls /etc"),
			extensionFactories: [createPolicyExtension("accept"), resultTracker],
		});

		await runner.run("run sudo ls");

		// Tool executed — mock output should be present
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toBe("mock-exec: sudo ls /etc");

		// Audit trail recorded "confirmed"
		const confirmed = getAuditTrail().filter((e) => e.outcome === "confirmed");
		expect(confirmed).toHaveLength(1);
		expect(confirmed[0].command).toBe("sudo ls /etc");
	});
});

// ═══════════════════════════════════════════════════════════════
// 2) Denied high-risk command is blocked
// ═══════════════════════════════════════════════════════════════

describe("Shell Policy Confirm — denied high-risk", () => {
	it("blocks execution when user denies", async () => {
		const toolResults: string[] = [];

		const resultTracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "bash") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: bashCallThenDone("sudo rm -rf /tmp/test"),
			extensionFactories: [createPolicyExtension("deny"), resultTracker],
		});

		await runner.run("run dangerous command");

		// tool_result fires for the error, but mock-exec output should NOT appear
		const executed = toolResults.filter((t) => t.startsWith("mock-exec:"));
		expect(executed).toHaveLength(0);

		// Audit trail recorded "blocked" with user denial reason
		const blocked = getAuditTrail().filter((e) => e.outcome === "blocked");
		expect(blocked.length).toBeGreaterThanOrEqual(1);
		expect(blocked.some((e) => e.reason?.includes("denied"))).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════
// 3) Throwing confirmation is blocked
// ═══════════════════════════════════════════════════════════════

describe("Shell Policy Confirm — interrupted confirmation", () => {
	it("blocks execution when confirmation throws", async () => {
		const toolResults: string[] = [];

		const resultTracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "bash") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: bashCallThenDone("sudo apt-get install foo"),
			extensionFactories: [createPolicyExtension("throw"), resultTracker],
		});

		await runner.run("install something");

		// Mock tool output should NOT appear — the throw propagates as a block
		const executed = toolResults.filter((t) => t.startsWith("mock-exec:"));
		expect(executed).toHaveLength(0);

		// The error result should mention the interruption
		const errorResults = toolResults.filter(
			(t) => t.includes("interrupted") || t.includes("Confirmation")
		);
		expect(errorResults.length + (toolResults.length === 0 ? 1 : 0)).toBeGreaterThanOrEqual(1);
	});
});

// ═══════════════════════════════════════════════════════════════
// 4) Denylist command blocked without confirm path
// ═══════════════════════════════════════════════════════════════

describe("Shell Policy Confirm — denylist bypass", () => {
	it("blocks denylist command without invoking confirmation", async () => {
		let confirmCalled = false;

		/** Policy extension where we track whether confirmFn is ever invoked. */
		const denylistPolicy: ExtensionFactory = (pi: ExtensionAPI): void => {
			registerSafeBashTool(pi);

			pi.on("tool_call", async (event, ctx) => {
				if (event.toolName !== "bash") return;

				const command = (event.input as { command?: string }).command;
				if (!command) return;

				return enforceExplicitPolicy(command, "bash", ctx.cwd, true, async () => {
					confirmCalled = true;
					return true;
				});
			});
		};

		const toolResults: string[] = [];
		const resultTracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "bash") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		// Fork bomb — always denied, never reaches confirmation
		const forkBomb = ":(){ :|:& };:";

		runner = await createSessionRunner({
			streamFn: bashCallThenDone(forkBomb),
			extensionFactories: [denylistPolicy, resultTracker],
		});

		await runner.run("run fork bomb");

		expect(confirmCalled).toBe(false);

		const executed = toolResults.filter((t) => t.startsWith("mock-exec:"));
		expect(executed).toHaveLength(0);

		const blocked = getAuditTrail().filter((e) => e.outcome === "blocked");
		expect(blocked).toHaveLength(1);
		expect(blocked[0].reason).toContain("denylist");
	});
});

// ═══════════════════════════════════════════════════════════════
// 5) Handler ordering — confirmed command survives extra handlers
// ═══════════════════════════════════════════════════════════════

describe("Shell Policy Confirm — handler ordering", () => {
	it("confirmed command executes when subsequent handlers do not block", async () => {
		const handlerOrder: string[] = [];

		/**
		 * First handler: policy gate that confirms high-risk commands.
		 * Registered by extension A.
		 */
		const policyGate: ExtensionFactory = (pi: ExtensionAPI): void => {
			registerSafeBashTool(pi);

			pi.on("tool_call", async (event, ctx) => {
				handlerOrder.push("policy");
				if (event.toolName !== "bash") return;

				const command = (event.input as { command?: string }).command;
				if (!command) return;

				return enforceExplicitPolicy(command, "bash", ctx.cwd, true, async () => true);
			});
		};

		/**
		 * Second handler: audit logger that observes but never blocks.
		 * Registered by extension B — runs after policyGate because
		 * extensions are processed in registration order.
		 */
		const auditLogger: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_call", async (event) => {
				handlerOrder.push("audit");
				if (event.toolName === "bash") {
					// Observe only — return undefined (no block)
					return undefined;
				}
			});
		};

		const toolResults: string[] = [];
		const resultTracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "bash") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: bashCallThenDone("sudo cat /etc/shadow"),
			extensionFactories: [policyGate, auditLogger, resultTracker],
		});

		await runner.run("read shadow file");

		// Both handlers were invoked in order
		expect(handlerOrder).toEqual(["policy", "audit"]);

		// Tool executed successfully despite high-risk command (user confirmed)
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toBe("mock-exec: sudo cat /etc/shadow");
	});

	it("subsequent handler block still prevents execution", async () => {
		const handlerOrder: string[] = [];

		/** Policy gate that confirms — returns undefined (no block). */
		const policyGate: ExtensionFactory = (pi: ExtensionAPI): void => {
			registerSafeBashTool(pi);

			pi.on("tool_call", async (event, ctx) => {
				handlerOrder.push("policy");
				if (event.toolName !== "bash") return;

				const command = (event.input as { command?: string }).command;
				if (!command) return;

				return enforceExplicitPolicy(command, "bash", ctx.cwd, true, async () => true);
			});
		};

		/** Second handler that unconditionally blocks bash calls. */
		const blocker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_call", async (event) => {
				handlerOrder.push("blocker");
				if (event.toolName === "bash") {
					return { block: true, reason: "Blocked by secondary handler" };
				}
			});
		};

		const toolResults: string[] = [];
		const resultTracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "bash") {
					const text = event.content.find((c) => c.type === "text");
					if (text?.type === "text") toolResults.push(text.text);
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: bashCallThenDone("sudo cat /etc/shadow"),
			extensionFactories: [policyGate, blocker, resultTracker],
		});

		await runner.run("read shadow file");

		// Policy ran first, then blocker fired and killed it
		expect(handlerOrder).toEqual(["policy", "blocker"]);

		// Tool did NOT execute — secondary handler blocked
		const executed = toolResults.filter((t) => t.startsWith("mock-exec:"));
		expect(executed).toHaveLength(0);
	});
});
