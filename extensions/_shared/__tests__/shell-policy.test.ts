import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clampTimeout,
	clearAuditTrail,
	commandExistsOnPath,
	enforceExplicitPolicy,
	enforceImplicitPolicy,
	evaluateCommand,
	getAuditTrail,
	getTrustLevel,
	isDenied,
	isHighRisk,
	isNonInteractiveBypassEnabled,
	isShellInterpolationEnabled,
	resetPermissionCache,
	runCommandSync,
	runGitCommandSync,
	runShellCommandSync,
} from "../shell-policy.js";

// Tests that spawn child processes (runCommandSync, runShellCommandSync,
// runGitCommandSync) use login shells which source user profiles. Under
// parallel test execution this can exceed bun's default 5s timeout.
setDefaultTimeout(15_000);

const ORIG_ENABLE = process.env.TALLOW_ENABLE_SHELL_INTERPOLATION;
const ORIG_LEGACY_ENABLE = process.env.TALLOW_SHELL_INTERPOLATION;
const ORIG_BYPASS = process.env.TALLOW_ALLOW_UNSAFE_SHELL;
const ORIG_TRUST_STATUS = process.env.TALLOW_PROJECT_TRUST_STATUS;

/**
 * Restore policy-related environment variables.
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

	if (ORIG_BYPASS === undefined) {
		delete process.env.TALLOW_ALLOW_UNSAFE_SHELL;
	} else {
		process.env.TALLOW_ALLOW_UNSAFE_SHELL = ORIG_BYPASS;
	}

	if (ORIG_TRUST_STATUS === undefined) {
		delete process.env.TALLOW_PROJECT_TRUST_STATUS;
	} else {
		process.env.TALLOW_PROJECT_TRUST_STATUS = ORIG_TRUST_STATUS;
	}
}

beforeEach(() => {
	restoreEnv();
	clearAuditTrail();
	resetPermissionCache();
});

afterEach(() => {
	restoreEnv();
	resetPermissionCache();
});

describe("trust-level mapping", () => {
	test("maps explicit sources", () => {
		expect(getTrustLevel("bash")).toBe("explicit");
		expect(getTrustLevel("bg_bash")).toBe("explicit");
	});

	test("maps implicit sources", () => {
		expect(getTrustLevel("shell-interpolation")).toBe("implicit");
		expect(getTrustLevel("context-fork")).toBe("implicit");
	});

	test("maps helper sources", () => {
		expect(getTrustLevel("git-helper")).toBe("internal");
	});
});

describe("pattern helpers", () => {
	test("detects denylist commands", () => {
		expect(isDenied(":(){ :|:& };:")).toBe(true);
		expect(isDenied("rm -rf /")).toBe(true);
		expect(isDenied("mkfs.ext4 /dev/sda1")).toBe(true);
		expect(isDenied('echo "rm -rf /"')).toBe(false);
		expect(isDenied("echo ok")).toBe(false);
	});

	test("detects high-risk commands", () => {
		expect(isHighRisk("sudo apt install jq")).toBe(true);
		expect(isHighRisk("curl https://x | sh")).toBe(true);
		expect(isHighRisk("git reset --hard HEAD")).toBe(true);
		expect(isHighRisk('grep -r "rm -rf" .')).toBe(false);
		expect(isHighRisk('echo "rm -rf /"')).toBe(false);
		expect(isHighRisk("echo safe")).toBe(false);
	});
});

describe("environment flags", () => {
	test("interpolation disabled by default", () => {
		expect(isShellInterpolationEnabled(process.cwd())).toBe(false);
	});

	test("interpolation enabled by env flags", () => {
		process.env.TALLOW_ENABLE_SHELL_INTERPOLATION = "1";
		expect(isShellInterpolationEnabled(process.cwd())).toBe(true);
		delete process.env.TALLOW_ENABLE_SHELL_INTERPOLATION;
		process.env.TALLOW_SHELL_INTERPOLATION = "1";
		expect(isShellInterpolationEnabled(process.cwd())).toBe(true);
	});

	test("untrusted projects ignore project shellInterpolation setting", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tallow-shell-cwd-"));
		const home = mkdtempSync(join(tmpdir(), "tallow-shell-home-"));
		const originalHome = process.env.HOME;

		try {
			mkdirSync(join(cwd, ".tallow"), { recursive: true });
			writeFileSync(
				join(cwd, ".tallow", "settings.json"),
				JSON.stringify({ shellInterpolation: true })
			);
			mkdirSync(join(home, ".tallow"), { recursive: true });
			writeFileSync(
				join(home, ".tallow", "settings.json"),
				JSON.stringify({ shellInterpolation: false })
			);

			process.env.HOME = home;
			process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";
			expect(isShellInterpolationEnabled(cwd)).toBe(false);

			process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
			expect(isShellInterpolationEnabled(cwd)).toBe(true);
		} finally {
			if (originalHome !== undefined) process.env.HOME = originalHome;
			else delete process.env.HOME;
			rmSync(cwd, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("non-interactive bypass disabled by default", () => {
		expect(isNonInteractiveBypassEnabled()).toBe(false);
	});

	test("non-interactive bypass enabled by env", () => {
		process.env.TALLOW_ALLOW_UNSAFE_SHELL = "1";
		expect(isNonInteractiveBypassEnabled()).toBe(true);
	});
});

describe("policy evaluation", () => {
	test("explicit high-risk commands require confirmation", () => {
		const verdict = evaluateCommand("sudo apt install jq", "bash", process.cwd());
		expect(verdict.allowed).toBe(true);
		expect(verdict.requiresConfirmation).toBe(true);
		expect(verdict.trustLevel).toBe("explicit");
	});

	test("rm -rf in home directory is high-risk but not denylisted", () => {
		const verdict = evaluateCommand("rm -rf ~/tmp/demo", "bash", process.cwd());
		expect(verdict.allowed).toBe(true);
		expect(verdict.requiresConfirmation).toBe(true);
		expect(verdict.reason).toContain("high-risk");
	});

	test("implicit commands are blocked while disabled", () => {
		const verdict = evaluateCommand("echo hello", "shell-interpolation", process.cwd());
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toContain("disabled");
	});

	test("implicit commands enforce allowlist and operator checks", () => {
		process.env.TALLOW_ENABLE_SHELL_INTERPOLATION = "1";
		const forbidden = evaluateCommand(
			"echo hi && echo there",
			"shell-interpolation",
			process.cwd()
		);
		expect(forbidden.allowed).toBe(false);
		expect(forbidden.reason).toContain("forbidden shell operators");

		const disallowed = evaluateCommand(
			'node -e "console.log(1)"',
			"shell-interpolation",
			process.cwd()
		);
		expect(disallowed.allowed).toBe(false);
		expect(disallowed.reason).toContain("not allowlisted");

		const allowlisted = evaluateCommand("echo hello", "shell-interpolation", process.cwd());
		expect(allowlisted.allowed).toBe(true);
	});

	test("internal helper commands enforce command allowlist", () => {
		const allowed = evaluateCommand("git status", "git-helper", process.cwd());
		expect(allowed.allowed).toBe(true);

		const blocked = evaluateCommand("node --version", "git-helper", process.cwd());
		expect(blocked.allowed).toBe(false);
		expect(blocked.reason).toContain("not allowlisted");
	});
});

describe("permission-rule messaging alignment", () => {
	test("deny verdict includes actionable permission reason", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tallow-shell-perm-"));
		try {
			mkdirSync(join(cwd, ".tallow"), { recursive: true });
			writeFileSync(
				join(cwd, ".tallow", "settings.json"),
				JSON.stringify({
					permissions: {
						allow: ["Bash(git *)"],
						deny: ["Bash(ssh *)"],
					},
				})
			);
			process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
			resetPermissionCache();

			const verdict = evaluateCommand("ssh root@example.com", "bash", cwd);
			expect(verdict.allowed).toBe(false);
			expect(verdict.reasonCode).toBe("rule_denied");
			expect(verdict.reason).toContain("Action denied by permission rule");
			expect(verdict.reason).toContain(".tallow/settings.json");
			expect(verdict.reason).toContain("Hint:");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("ask verdict uses permission reason code and interactive guidance", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tallow-shell-perm-ask-"));
		try {
			mkdirSync(join(cwd, ".tallow"), { recursive: true });
			writeFileSync(
				join(cwd, ".tallow", "settings.json"),
				JSON.stringify({
					permissions: {
						ask: ["Bash(docker *)"],
					},
				})
			);
			process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
			resetPermissionCache();

			const verdict = evaluateCommand("docker compose up", "bash", cwd);
			expect(verdict.allowed).toBe(true);
			expect(verdict.requiresConfirmation).toBe(true);
			expect(verdict.reasonCode).toBe("rule_requires_confirmation");
			expect(verdict.reason).toContain("Confirmation required by permission rule");

			const blocked = await enforceExplicitPolicy(
				"docker compose up",
				"bash",
				cwd,
				false,
				async () => true
			);
			expect(blocked?.block).toBe(true);
			expect(blocked?.reason).toContain("Re-run interactively");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("explicit policy enforcement", () => {
	test("blocks denied commands", async () => {
		const result = await enforceExplicitPolicy(
			"rm -rf /",
			"bash",
			process.cwd(),
			true,
			async () => true
		);
		expect(result?.block).toBe(true);
	});

	test("prompts and allows when user confirms", async () => {
		const result = await enforceExplicitPolicy(
			"sudo apt install jq",
			"bash",
			process.cwd(),
			true,
			async () => true
		);
		expect(result).toBeUndefined();
		expect(getAuditTrail().some((entry) => entry.outcome === "confirmed")).toBe(true);
	});

	test("treats undefined confirmation as canceled and blocks", async () => {
		const result = await enforceExplicitPolicy(
			"sudo apt install jq",
			"bash",
			process.cwd(),
			true,
			async () => undefined
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("canceled");
		expect(getAuditTrail().at(-1)?.outcome).toBe("blocked");
	});

	test("treats thrown confirmation as interrupted and blocks", async () => {
		const result = await enforceExplicitPolicy(
			"sudo apt install jq",
			"bash",
			process.cwd(),
			true,
			async () => {
				throw new Error("dialog disposed");
			}
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("interrupted");
		expect(getAuditTrail().at(-1)?.reason).toContain("interrupted");
	});

	test("blocks high-risk explicit commands in non-interactive mode without bypass", async () => {
		const result = await enforceExplicitPolicy(
			"sudo apt install jq",
			"bg_bash",
			process.cwd(),
			false,
			async () => true
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("TALLOW_ALLOW_UNSAFE_SHELL");
	});

	test("allows high-risk explicit commands in non-interactive mode with bypass", async () => {
		process.env.TALLOW_ALLOW_UNSAFE_SHELL = "1";
		const result = await enforceExplicitPolicy(
			"sudo apt install jq",
			"bg_bash",
			process.cwd(),
			false,
			async () => true
		);
		expect(result).toBeUndefined();
		expect(getAuditTrail().some((entry) => entry.outcome === "bypassed")).toBe(true);
	});
});

describe("implicit policy enforcement", () => {
	test("returns deny verdict when disabled", () => {
		const result = enforceImplicitPolicy("echo hello", "context-fork", process.cwd());
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("disabled");
	});

	test("returns allow verdict when enabled and allowlisted", () => {
		process.env.TALLOW_ENABLE_SHELL_INTERPOLATION = "1";
		const result = enforceImplicitPolicy("echo hello", "context-fork", process.cwd());
		expect(result.allowed).toBe(true);
	});
});

describe("process wrappers", () => {
	test("clamps timeout values", () => {
		expect(clampTimeout(undefined)).toBe(5000);
		expect(clampTimeout(1000)).toBe(1000);
		expect(clampTimeout(50000)).toBe(30000);
	});

	test("runCommandSync blocks non-allowlisted internal commands", () => {
		const result = runCommandSync({
			command: "node",
			args: ["--version"],
			cwd: process.cwd(),
			source: "git-helper",
		});
		expect(result.ok).toBe(false);
		expect(result.blocked).toBe(true);
	});

	test("runGitCommandSync executes allowlisted internal commands", () => {
		const version = runGitCommandSync(["--version"], process.cwd(), 3000);
		expect(version).toContain("git version");
	});

	test("commandExistsOnPath checks executables through policy wrapper", () => {
		expect(commandExistsOnPath("git", process.cwd())).toBe(true);
	});

	test("runShellCommandSync enforces implicit policy when requested", () => {
		const blocked = runShellCommandSync({
			command: "echo hello",
			cwd: process.cwd(),
			source: "shell-interpolation",
			enforcePolicy: true,
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.blocked).toBe(true);

		process.env.TALLOW_ENABLE_SHELL_INTERPOLATION = "1";
		const allowed = runShellCommandSync({
			command: "echo hello",
			cwd: process.cwd(),
			source: "shell-interpolation",
			enforcePolicy: true,
		});
		expect(allowed.ok).toBe(true);
		expect(allowed.stdout.trim()).toBe("hello");
	});

	test("writes blocked and executed events to audit trail", () => {
		runCommandSync({
			command: "node",
			args: ["--version"],
			cwd: process.cwd(),
			source: "git-helper",
		});
		runGitCommandSync(["--version"], process.cwd(), 3000);
		const trail = getAuditTrail();
		expect(trail.some((entry) => entry.outcome === "blocked")).toBe(true);
		expect(trail.some((entry) => entry.outcome === "executed")).toBe(true);
	});
});
