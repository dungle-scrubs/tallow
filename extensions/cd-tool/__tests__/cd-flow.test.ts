import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import {
	registerWorkspaceTransitionHost,
	type WorkspaceTransitionRequest,
	type WorkspaceTransitionResult,
} from "../../../src/workspace-transition.js";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import cdTool from "../index.js";

interface NotifyCall {
	level: string;
	message: string;
}

let harness: ExtensionHarness;
let originalCwd: string;
let currentDir: string;
let targetDir: string;
let notifications: NotifyCall[];
let originalSessionWorktreePath: string | undefined;
let originalSessionWorktreeOriginalCwd: string | undefined;
let transitionResult: WorkspaceTransitionResult;
let transitionRequests: WorkspaceTransitionRequest[];

/**
 * Build a command context with notification capture.
 *
 * @param cwd - Context cwd exposed to the extension runtime
 * @returns Minimal command context for invoking /cd
 */
function createCommandContext(cwd: string = process.cwd()): ExtensionCommandContext {
	const ui: Partial<ExtensionUIContext> = {
		notify(message: string, level: string): void {
			notifications.push({ level, message });
		},
		async select(): Promise<string | undefined> {
			return undefined;
		},
		setWorkingMessage() {},
	};

	return {
		cwd,
		hasUI: true,
		ui: ui as ExtensionUIContext,
		sessionManager: {} as never,
		modelRegistry: {} as never,
		model: undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	} as ExtensionCommandContext;
}

beforeEach(async () => {
	harness = ExtensionHarness.create();
	await harness.loadExtension(cdTool);
	originalCwd = process.cwd();
	currentDir = realpathSync(mkdtempSync(join(tmpdir(), "cd-tool-current-")));
	targetDir = realpathSync(mkdtempSync(join(tmpdir(), "cd-tool-target-")));
	notifications = [];
	originalSessionWorktreePath = process.env.TALLOW_WORKTREE_PATH;
	originalSessionWorktreeOriginalCwd = process.env.TALLOW_WORKTREE_ORIGINAL_CWD;
	transitionRequests = [];
	transitionResult = { status: "completed", trustedOnEntry: true };
	process.chdir(currentDir);
	registerWorkspaceTransitionHost({
		async requestTransition(request): Promise<WorkspaceTransitionResult> {
			transitionRequests.push(request);
			return transitionResult;
		},
	});
});

afterEach(() => {
	registerWorkspaceTransitionHost(null);
	process.chdir(originalCwd);
	if (originalSessionWorktreePath === undefined) {
		delete process.env.TALLOW_WORKTREE_PATH;
	} else {
		process.env.TALLOW_WORKTREE_PATH = originalSessionWorktreePath;
	}
	if (originalSessionWorktreeOriginalCwd === undefined) {
		delete process.env.TALLOW_WORKTREE_ORIGINAL_CWD;
	} else {
		process.env.TALLOW_WORKTREE_ORIGINAL_CWD = originalSessionWorktreeOriginalCwd;
	}
	rmSync(currentDir, { force: true, recursive: true });
	rmSync(targetDir, { force: true, recursive: true });
});

describe("cd command flow", () => {
	it("delegates command transitions through the shared host", async () => {
		const command = harness.commands.get("cd");
		await command?.handler(targetDir, createCommandContext());

		expect(transitionRequests).toHaveLength(1);
		expect(transitionRequests[0]?.initiator).toBe("command");
		expect(transitionRequests[0]?.sourceCwd).toBe(currentDir);
		expect(transitionRequests[0]?.targetCwd).toBe(targetDir);
		expect(notifications.some((entry) => entry.message === `Changed to: ${targetDir}`)).toBe(true);
	});

	it("resolves relative paths from ctx.cwd instead of process.cwd", async () => {
		const nestedBaseDir = realpathSync(mkdtempSync(join(tmpdir(), "cd-tool-context-")));
		const nestedTargetDir = join(nestedBaseDir, "nested");
		mkdirSync(nestedTargetDir);

		const command = harness.commands.get("cd");
		await command?.handler("nested", createCommandContext(nestedBaseDir));

		expect(transitionRequests).toHaveLength(1);
		expect(transitionRequests[0]?.sourceCwd).toBe(nestedBaseDir);
		expect(transitionRequests[0]?.targetCwd).toBe(nestedTargetDir);
		rmSync(nestedBaseDir, { force: true, recursive: true });
	});

	it("warns when the target workspace remains untrusted", async () => {
		transitionResult = { status: "completed", trustedOnEntry: false };

		const command = harness.commands.get("cd");
		await command?.handler(targetDir, createCommandContext());

		expect(
			notifications.some((entry) =>
				entry.message.includes("Opened untrusted — repo-controlled project surfaces remain blocked")
			)
		).toBe(true);
	});

	it("reports cancellation without mutating cwd locally", async () => {
		transitionResult = { status: "cancelled" };

		const command = harness.commands.get("cd");
		await command?.handler(targetDir, createCommandContext());

		expect(process.cwd()).toBe(currentDir);
		expect(notifications.some((entry) => entry.message.includes("canceled"))).toBe(true);
	});
});

describe("cd tool", () => {
	it("requests a workspace transition and reports restarted-turn semantics", async () => {
		const tool = harness.tools.get("cd");
		const result = await tool?.execute(
			"tool-call-1",
			{ path: targetDir },
			undefined,
			undefined,
			createCommandContext()
		);

		expect(result?.isError).toBe(false);
		expect(transitionRequests).toHaveLength(1);
		expect(transitionRequests[0]?.initiator).toBe("tool");
		const textResult = result?.content[0];
		if (textResult?.type === "text") {
			expect(textResult.text).toContain("restart in the new workspace");
		}
	});

	it("keeps original-repo absolute paths inside the active session worktree", async () => {
		const originalRepoRoot = realpathSync(mkdtempSync(join(tmpdir(), "cd-tool-repo-")));
		const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), "cd-tool-worktree-")));
		const relativePath = join("packages", "app");
		const originalTargetDir = join(originalRepoRoot, relativePath);
		const worktreeTargetDir = join(worktreeRoot, relativePath);
		mkdirSync(originalTargetDir, { recursive: true });
		mkdirSync(worktreeTargetDir, { recursive: true });
		process.env.TALLOW_WORKTREE_ORIGINAL_CWD = originalRepoRoot;
		process.env.TALLOW_WORKTREE_PATH = worktreeRoot;

		const tool = harness.tools.get("cd");
		await tool?.execute(
			"tool-call-1",
			{ path: originalTargetDir },
			undefined,
			undefined,
			createCommandContext(worktreeRoot)
		);

		expect(transitionRequests).toHaveLength(1);
		expect(transitionRequests[0]?.targetCwd).toBe(worktreeTargetDir);
		rmSync(originalRepoRoot, { force: true, recursive: true });
		rmSync(worktreeRoot, { force: true, recursive: true });
	});

	it("surfaces host unavailability to the model", async () => {
		transitionResult = {
			reason: "Workspace transitions are unavailable in print mode.",
			status: "unavailable",
		};

		const tool = harness.tools.get("cd");
		const result = await tool?.execute(
			"tool-call-1",
			{ path: targetDir },
			undefined,
			undefined,
			createCommandContext()
		);

		expect(result?.isError).toBe(true);
		const textResult = result?.content[0];
		if (textResult?.type === "text") {
			expect(textResult.text).toContain("print mode");
		}
	});
});
