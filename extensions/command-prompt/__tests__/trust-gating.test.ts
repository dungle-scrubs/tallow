import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import commandPromptExtension from "../index.js";

let originalCwd: string;
let originalTrustCwd: string | undefined;
let originalTrustStatus: string | undefined;
let originalCodingAgentDir: string | undefined;
let tmpRoot: string;
let projectDir: string;
let homeDir: string;

beforeEach(() => {
	originalCwd = process.cwd();
	originalTrustCwd = process.env.TALLOW_PROJECT_TRUST_CWD;
	originalTrustStatus = process.env.TALLOW_PROJECT_TRUST_STATUS;
	originalCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

	tmpRoot = mkdtempSync(join(tmpdir(), "command-prompt-trust-"));
	projectDir = join(tmpRoot, "project");
	homeDir = join(tmpRoot, "home");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	process.chdir(projectDir);
	process.env.PI_CODING_AGENT_DIR = homeDir;
	process.env.TALLOW_PROJECT_TRUST_CWD = projectDir;
});

afterEach(() => {
	process.chdir(originalCwd);
	if (originalTrustCwd !== undefined) process.env.TALLOW_PROJECT_TRUST_CWD = originalTrustCwd;
	else delete process.env.TALLOW_PROJECT_TRUST_CWD;
	if (originalTrustStatus !== undefined) {
		process.env.TALLOW_PROJECT_TRUST_STATUS = originalTrustStatus;
	} else delete process.env.TALLOW_PROJECT_TRUST_STATUS;
	if (originalCodingAgentDir !== undefined)
		process.env.PI_CODING_AGENT_DIR = originalCodingAgentDir;
	else delete process.env.PI_CODING_AGENT_DIR;
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("command-prompt trust gating", () => {
	test("blocks project-local .tallow/.claude commands when project is untrusted", async () => {
		mkdirSync(join(projectDir, ".tallow", "commands"), { recursive: true });
		mkdirSync(join(projectDir, ".claude", "commands"), { recursive: true });
		mkdirSync(join(homeDir, "commands"), { recursive: true });
		writeFileSync(join(projectDir, ".tallow", "commands", "project-cmd.md"), "Project command");
		writeFileSync(join(projectDir, ".claude", "commands", "claude-cmd.md"), "Claude command");
		writeFileSync(join(homeDir, "commands", "global-cmd.md"), "Global command");

		process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";
		const harness = ExtensionHarness.create();
		await harness.loadExtension(commandPromptExtension);

		expect(harness.commands.has("project-cmd")).toBe(false);
		expect(harness.commands.has("claude-cmd")).toBe(false);
	});

	test("loads project-local commands when project is trusted", async () => {
		mkdirSync(join(projectDir, ".tallow", "commands"), { recursive: true });
		mkdirSync(join(projectDir, ".claude", "commands"), { recursive: true });
		writeFileSync(join(projectDir, ".tallow", "commands", "project-cmd.md"), "Project command");
		writeFileSync(join(projectDir, ".claude", "commands", "claude-cmd.md"), "Claude command");

		process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
		const harness = ExtensionHarness.create();
		await harness.loadExtension(commandPromptExtension);

		expect(harness.commands.has("project-cmd")).toBe(true);
		expect(harness.commands.has("claude-cmd")).toBe(true);
	});
});
