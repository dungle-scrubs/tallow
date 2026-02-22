import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";
import { createSessionRunner, type SessionRunner } from "../../test-utils/session-runner.js";
import worktreeExtension from "../worktree/index.js";
import { createWorktree, removeWorktree } from "../worktree/lifecycle.js";

/**
 * Run a git command and return trimmed stdout.
 *
 * @param cwd - Working directory
 * @param args - Git command args
 * @returns Trimmed stdout
 */
function git(cwd: string, ...args: string[]): string {
	const output = execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return output.trim();
}

/**
 * Create a temporary git repo with one commit.
 *
 * @returns Repository root path
 */
function createTempRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "tallow-worktree-integration-"));
	git(repo, "init");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test User");
	writeFileSync(join(repo, "README.md"), "# test\n", "utf-8");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "init");
	return repo;
}

describe("worktree extension integration", () => {
	let repoRoot = "";
	let runner: SessionRunner | undefined;
	let sessionWorktreePath = "";
	let previousEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		repoRoot = createTempRepo();
		const created = createWorktree(repoRoot, { scope: "session" });
		sessionWorktreePath = created.worktreePath;
		previousEnv = {
			TALLOW_WORKTREE_ORIGINAL_CWD: process.env.TALLOW_WORKTREE_ORIGINAL_CWD,
			TALLOW_WORKTREE_PATH: process.env.TALLOW_WORKTREE_PATH,
		};
		process.env.TALLOW_WORKTREE_ORIGINAL_CWD = repoRoot;
		process.env.TALLOW_WORKTREE_PATH = sessionWorktreePath;
	});

	afterEach(() => {
		runner?.dispose();
		runner = undefined;
		removeWorktree(sessionWorktreePath);
		rmSync(repoRoot, { force: true, recursive: true });
		if (previousEnv.TALLOW_WORKTREE_ORIGINAL_CWD === undefined) {
			delete process.env.TALLOW_WORKTREE_ORIGINAL_CWD;
		} else {
			process.env.TALLOW_WORKTREE_ORIGINAL_CWD = previousEnv.TALLOW_WORKTREE_ORIGINAL_CWD;
		}
		if (previousEnv.TALLOW_WORKTREE_PATH === undefined) {
			delete process.env.TALLOW_WORKTREE_PATH;
		} else {
			process.env.TALLOW_WORKTREE_PATH = previousEnv.TALLOW_WORKTREE_PATH;
		}
	});

	it("binds and runs with session worktree metadata enabled", async () => {
		runner = await createSessionRunner({
			cwd: sessionWorktreePath,
			extensionFactories: [worktreeExtension],
			streamFn: createScriptedStreamFn([{ text: "ok" }]),
		});

		const result = await runner.run("hello");
		expect(result.events.length).toBeGreaterThan(0);
	});
});
