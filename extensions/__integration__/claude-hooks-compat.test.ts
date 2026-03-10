import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadHooksConfig } from "../hooks/index.js";

let cwd: string;
let homeDir: string;
let originalHome: string | undefined;
let originalTrustCwd: string | undefined;
let originalTrustStatus: string | undefined;

/**
 * Writes JSON with pretty formatting, creating parent directories as needed.
 *
 * @param filePath - Destination file path
 * @param value - JSON-serializable payload
 * @returns void
 */
function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "tallow-claude-hooks-cwd-"));
	homeDir = mkdtempSync(join(tmpdir(), "tallow-claude-hooks-home-"));
	originalHome = process.env.HOME;
	originalTrustCwd = process.env.TALLOW_PROJECT_TRUST_CWD;
	originalTrustStatus = process.env.TALLOW_PROJECT_TRUST_STATUS;
	process.env.HOME = homeDir;
	process.env.TALLOW_PROJECT_TRUST_CWD = cwd;
	process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
});

afterEach(() => {
	if (originalHome !== undefined) {
		process.env.HOME = originalHome;
	} else {
		delete process.env.HOME;
	}

	if (originalTrustCwd !== undefined) {
		process.env.TALLOW_PROJECT_TRUST_CWD = originalTrustCwd;
	} else {
		delete process.env.TALLOW_PROJECT_TRUST_CWD;
	}

	if (originalTrustStatus !== undefined) {
		process.env.TALLOW_PROJECT_TRUST_STATUS = originalTrustStatus;
	} else {
		delete process.env.TALLOW_PROJECT_TRUST_STATUS;
	}

	rmSync(cwd, { recursive: true, force: true });
	rmSync(homeDir, { recursive: true, force: true });
});

describe("Claude hooks compatibility integration", () => {
	it("loads and translates .claude/settings.json hook events", () => {
		writeJson(join(cwd, ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "echo pre" }],
					},
				],
				PostToolUseFailure: [
					{
						matcher: "Write",
						hooks: [{ type: "command", command: "echo fail" }],
					},
				],
			},
		});

		const config = loadHooksConfig(cwd);
		expect(config.tool_call).toHaveLength(1);
		expect(config.tool_result).toHaveLength(1);
		expect(config.tool_call[0]?.matcher).toBe("bash");
		expect(config.tool_result[0]?.matcher).toBe("write");
		expect(config.tool_call[0]?.hooks[0]?._claudeSource).toBe(true);
		expect(config.tool_call[0]?.hooks[0]?._claudeEventName).toBe("PreToolUse");
		expect(config.tool_result[0]?.hooks[0]?._claudeEventName).toBe("PostToolUseFailure");
	});

	it("keeps .tallow hooks ahead of .claude hooks for matching order", () => {
		writeJson(join(cwd, ".tallow", "hooks.json"), {
			tool_call: [
				{
					matcher: "bash",
					hooks: [{ type: "command", command: "echo tallow" }],
				},
			],
		});
		writeJson(join(cwd, ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "echo claude" }],
					},
				],
			},
		});

		const config = loadHooksConfig(cwd);
		const handlers = config.tool_call?.map((entry) => entry.hooks[0]?.command);
		expect(handlers).toEqual(["echo tallow", "echo claude"]);
	});

	it("allows native and Claude event names in the same .claude config", () => {
		writeJson(join(cwd, ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [
					{
						matcher: "Edit|Write",
						hooks: [{ type: "command", command: "echo claude" }],
					},
				],
				tool_call: [
					{
						matcher: "bash",
						hooks: [{ type: "command", command: "echo native" }],
					},
				],
			},
		});

		const config = loadHooksConfig(cwd);
		expect(config.tool_call).toHaveLength(2);
		expect(config.tool_call?.[0]?.matcher).toBe("edit|write");
		expect(config.tool_call?.[1]?.matcher).toBe("bash");
	});

	it("blocks project .tallow hooks when project is untrusted", () => {
		writeJson(join(homeDir, ".tallow", "hooks.json"), {
			tool_call: [{ matcher: "bash", hooks: [{ type: "command", command: "echo global" }] }],
		});
		writeJson(join(cwd, ".tallow", "hooks.json"), {
			tool_call: [{ matcher: "bash", hooks: [{ type: "command", command: "echo project" }] }],
		});

		process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";
		const config = loadHooksConfig(cwd);
		const handlers = config.tool_call?.map((entry) => entry.hooks[0]?.command);
		expect(handlers).toEqual(["echo global"]);
	});

	it("blocks project extension hooks when project is untrusted", () => {
		writeJson(join(homeDir, ".tallow", "extensions", "global-ext", "hooks.json"), {
			tool_call: [{ matcher: "read", hooks: [{ type: "command", command: "echo global-ext" }] }],
		});
		writeJson(join(cwd, ".tallow", "extensions", "project-ext", "hooks.json"), {
			tool_call: [{ matcher: "read", hooks: [{ type: "command", command: "echo project-ext" }] }],
		});

		process.env.TALLOW_PROJECT_TRUST_STATUS = "stale_fingerprint";
		const config = loadHooksConfig(cwd);
		const handlers = config.tool_call?.map((entry) => entry.hooks[0]?.command);
		expect(handlers).toContain("echo global-ext");
		expect(handlers).not.toContain("echo project-ext");
	});

	it("blocks project .claude hooks when project is untrusted", () => {
		writeJson(join(homeDir, ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "echo global-claude" }],
					},
				],
			},
		});
		writeJson(join(cwd, ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "echo project-claude" }],
					},
				],
			},
		});

		process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";
		const config = loadHooksConfig(cwd);
		const handlers = config.tool_call?.map((entry) => entry.hooks[0]?.command);
		expect(handlers).toContain("echo global-claude");
		expect(handlers).not.toContain("echo project-claude");
	});
});

describe("Package hooks with Claude format", () => {
	it("translates Claude event names in package hooks.json", () => {
		const pkgDir = join(cwd, "my-package");
		writeJson(join(pkgDir, "hooks.json"), {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [{ type: "command", command: "echo pkg-pre" }],
				},
			],
			Stop: [
				{
					hooks: [{ type: "command", command: "echo pkg-stop" }],
				},
			],
		});

		writeJson(join(homeDir, ".tallow", "settings.json"), {
			packages: [pkgDir],
		});

		const config = loadHooksConfig(cwd);
		expect(config.tool_call).toHaveLength(1);
		expect(config.tool_call[0]?.matcher).toBe("bash");
		expect(config.tool_call[0]?.hooks[0]?.command).toBe("echo pkg-pre");
		expect(config.tool_call[0]?.hooks[0]?._claudeSource).toBe(true);
		expect(config.tool_call[0]?.hooks[0]?._claudeEventName).toBe("PreToolUse");
		expect(config.agent_end).toHaveLength(1);
		expect(config.agent_end[0]?.hooks[0]?.command).toBe("echo pkg-stop");
	});

	it("does not double-translate native tallow hooks in packages", () => {
		const pkgDir = join(cwd, "native-package");
		writeJson(join(pkgDir, "hooks.json"), {
			tool_call: [
				{
					matcher: "bash",
					hooks: [{ type: "command", command: "echo native" }],
				},
			],
		});

		writeJson(join(homeDir, ".tallow", "settings.json"), {
			packages: [pkgDir],
		});

		const config = loadHooksConfig(cwd);
		expect(config.tool_call).toHaveLength(1);
		expect(config.tool_call[0]?.matcher).toBe("bash");
		expect(config.tool_call[0]?.hooks[0]?.command).toBe("echo native");
		expect(config.tool_call[0]?.hooks[0]?._claudeSource).toBeUndefined();
	});

	it("handles mixed Claude and native events in a package hooks.json", () => {
		const pkgDir = join(cwd, "mixed-package");
		writeJson(join(pkgDir, "hooks.json"), {
			PreToolUse: [
				{
					matcher: "Edit|Write",
					hooks: [{ type: "command", command: "echo claude-pre" }],
				},
			],
			tool_call: [
				{
					matcher: "bash",
					hooks: [{ type: "command", command: "echo native-tool" }],
				},
			],
		});

		writeJson(join(homeDir, ".tallow", "settings.json"), {
			packages: [pkgDir],
		});

		const config = loadHooksConfig(cwd);
		expect(config.tool_call).toHaveLength(2);
		const commands = config.tool_call.map((entry) => entry.hooks[0]?.command);
		expect(commands).toContain("echo claude-pre");
		expect(commands).toContain("echo native-tool");
	});

	it("translates Claude hooks from project-level package settings", () => {
		const pkgDir = join(cwd, "proj-pkg");
		writeJson(join(pkgDir, "hooks.json"), {
			UserPromptSubmit: [
				{
					hooks: [{ type: "command", command: "echo proj-input" }],
				},
			],
		});

		writeJson(join(cwd, ".tallow", "settings.json"), {
			packages: [pkgDir],
		});

		const config = loadHooksConfig(cwd);
		expect(config.input).toHaveLength(1);
		expect(config.input[0]?.hooks[0]?.command).toBe("echo proj-input");
		expect(config.input[0]?.hooks[0]?._claudeEventName).toBe("UserPromptSubmit");
	});

	it("blocks untrusted project package hooks with Claude format", () => {
		const pkgDir = join(cwd, "untrusted-pkg");
		writeJson(join(pkgDir, "hooks.json"), {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [{ type: "command", command: "echo untrusted" }],
				},
			],
		});

		writeJson(join(cwd, ".tallow", "settings.json"), {
			packages: [pkgDir],
		});

		process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";
		const config = loadHooksConfig(cwd);
		expect(config.tool_call ?? []).toHaveLength(0);
	});
});

describe("Extension hooks with Claude format", () => {
	it("translates Claude event names in extension hooks.json", () => {
		writeJson(join(homeDir, ".tallow", "extensions", "my-ext", "hooks.json"), {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [{ type: "command", command: "echo ext-pre" }],
				},
			],
		});

		const config = loadHooksConfig(cwd);
		expect(config.tool_call).toHaveLength(1);
		expect(config.tool_call[0]?.matcher).toBe("bash");
		expect(config.tool_call[0]?.hooks[0]?._claudeSource).toBe(true);
	});

	it("translates Claude hooks in project extension hooks.json", () => {
		writeJson(join(cwd, ".tallow", "extensions", "proj-ext", "hooks.json"), {
			PostToolUse: [
				{
					matcher: "Write",
					hooks: [{ type: "command", command: "echo proj-ext-post" }],
				},
			],
		});

		const config = loadHooksConfig(cwd);
		expect(config.tool_result).toHaveLength(1);
		expect(config.tool_result[0]?.matcher).toBe("write");
		expect(config.tool_result[0]?.hooks[0]?._claudeEventName).toBe("PostToolUse");
	});
});
