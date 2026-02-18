import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { clearAuditTrail, getAuditTrail } from "../../_shared/shell-policy.js";
import { expandFileReferences } from "../../file-reference/index.js";
import { expandShellCommands } from "../index.js";

// These tests spawn real child processes via login shells (-lc).
// Under parallel test execution, process contention can exceed bun's
// default 5s timeout. Give them 15s of breathing room.
setDefaultTimeout(15_000);

const CWD = process.cwd();
const ORIG_ENABLE = process.env.TALLOW_ENABLE_SHELL_INTERPOLATION;
const ORIG_LEGACY_ENABLE = process.env.TALLOW_SHELL_INTERPOLATION;

/**
 * Restore shell interpolation env flags after each test.
 *
 * @returns void
 */
function restoreEnv(): void {
	if (ORIG_ENABLE === undefined) {
		delete process.env.TALLOW_ENABLE_SHELL_INTERPOLATION;
	} else {
		process.env.TALLOW_ENABLE_SHELL_INTERPOLATION = ORIG_ENABLE;
	}

	if (ORIG_LEGACY_ENABLE === undefined) {
		delete process.env.TALLOW_SHELL_INTERPOLATION;
	} else {
		process.env.TALLOW_SHELL_INTERPOLATION = ORIG_LEGACY_ENABLE;
	}
}

beforeEach(() => {
	clearAuditTrail();
	restoreEnv();
});

afterEach(() => {
	restoreEnv();
});

describe("expandShellCommands (utility mode)", () => {
	test("expands single command", () => {
		const result = expandShellCommands("Hello !`echo world`", CWD);
		expect(result).toBe("Hello world");
	});

	test("expands multiple commands in one input", () => {
		const result = expandShellCommands("!`echo foo` and !`echo bar`", CWD);
		expect(result).toBe("foo and bar");
	});

	test("passes through input with no patterns", () => {
		const input = "just a normal message with no patterns";
		expect(expandShellCommands(input, CWD)).toBe(input);
	});

	test("replaces failed commands with error marker", () => {
		const result = expandShellCommands("!`cat __missing_file__`", CWD);
		expect(result).toBe("[error: command failed: cat __missing_file__]");
	});

	test("trims trailing newlines from output", () => {
		const result = expandShellCommands("!`echo hello`", CWD);
		expect(result).toBe("hello");
		expect(result.endsWith("\n")).toBe(false);
	});

	test("handles empty backticks (no match)", () => {
		const input = "!`` should not match";
		expect(expandShellCommands(input, CWD)).toBe(input);
	});

	test("handles command with leading/trailing spaces", () => {
		const result = expandShellCommands("!`  echo trimmed  `", CWD);
		expect(result).toBe("trimmed");
	});

	test("is non-recursive (output not re-scanned)", () => {
		const result = expandShellCommands("!`printf '!\\140echo injected\\140'`", CWD);
		expect(result).toBe("!`echo injected`");
	});

	test("handles command with spaces in arguments", () => {
		const result = expandShellCommands("!`echo hello world`", CWD);
		expect(result).toBe("hello world");
	});

	test("preserves surrounding text", () => {
		const result = expandShellCommands("before !`echo mid` after", CWD);
		expect(result).toBe("before mid after");
	});

	test("returns same reference for input without patterns", () => {
		const input = "no patterns here";
		const result = expandShellCommands(input, CWD);
		expect(result).toBe(input);
	});
});

describe("expandShellCommands (policy mode)", () => {
	test("denies commands when interpolation is disabled", () => {
		delete process.env.TALLOW_ENABLE_SHELL_INTERPOLATION;
		const result = expandShellCommands("!`echo blocked`", CWD, {
			source: "shell-interpolation",
			enforcePolicy: true,
		});
		expect(result).toContain("[denied:");
		expect(result).toContain("disabled");
	});

	test("allows safe allowlisted commands when enabled", () => {
		process.env.TALLOW_ENABLE_SHELL_INTERPOLATION = "1";
		const result = expandShellCommands("!`echo allowed`", CWD, {
			source: "shell-interpolation",
			enforcePolicy: true,
		});
		expect(result).toBe("allowed");
	});

	test("blocks implicit commands with forbidden shell operators", () => {
		process.env.TALLOW_ENABLE_SHELL_INTERPOLATION = "1";
		const result = expandShellCommands("!`echo hi && echo there`", CWD, {
			source: "shell-interpolation",
			enforcePolicy: true,
		});
		expect(result).toContain("[denied:");
		expect(result).toContain("forbidden shell operators");
	});

	test("blocks implicit commands outside allowlist", () => {
		process.env.TALLOW_ENABLE_SHELL_INTERPOLATION = "1";
		const result = expandShellCommands('!`node -e "console.log(1)"`', CWD, {
			source: "shell-interpolation",
			enforcePolicy: true,
		});
		expect(result).toContain("[denied:");
		expect(result).toContain("not allowlisted");
	});

	test("records policy and execution events in audit trail", () => {
		process.env.TALLOW_ENABLE_SHELL_INTERPOLATION = "1";
		expandShellCommands("!`echo audited`", CWD, {
			source: "shell-interpolation",
			enforcePolicy: true,
		});
		const trail = getAuditTrail();
		expect(trail.length).toBeGreaterThanOrEqual(2);
		expect(trail.some((entry) => entry.source === "shell-interpolation")).toBe(true);
		expect(trail.some((entry) => entry.outcome === "allowed")).toBe(true);
		expect(trail.some((entry) => entry.outcome === "executed")).toBe(true);
	});
});

// ── Security invariant: subagent pipeline ───────────────────

describe("subagent content pipeline (expandFileReferences only)", () => {
	test("does NOT expand shell commands", async () => {
		const agentTask = "Install deps with !`rm -rf /` and continue";
		const result = await expandFileReferences(agentTask, CWD);

		expect(result).toContain("!`rm -rf /`");
	});

	test("still expands @file references", async () => {
		const result = await expandFileReferences("Check @package.json for deps", CWD);

		expect(result).toContain('"name"');
	});
});
