import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupStaleWorktrees,
	createWorktree,
	removeWorktree,
	TALLOW_WORKTREE_MARKER_FILE,
	validateGitRepo,
} from "../lifecycle.js";

/**
 * Run a git command and return trimmed stdout.
 *
 * @param cwd - Working directory
 * @param args - Git arguments
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
 * Create a temporary git repository with an initial commit.
 *
 * @returns Repo root path
 */
function createTempRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "tallow-worktree-test-"));
	git(repo, "init");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test User");
	writeFileSync(join(repo, "README.md"), "# test\n", "utf-8");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "init");
	return repo;
}

describe("worktree lifecycle", () => {
	let repoRoot = "";

	beforeEach(() => {
		repoRoot = createTempRepo();
	});

	afterEach(() => {
		rmSync(repoRoot, { force: true, recursive: true });
	});

	it("creates a detached worktree inside a git repo", () => {
		const created = createWorktree(repoRoot, { scope: "subagent" });
		expect(existsSync(created.worktreePath)).toBe(true);
		expect(created.scope).toBe("subagent");
		const markerPath = join(created.worktreePath, TALLOW_WORKTREE_MARKER_FILE);
		expect(existsSync(markerPath)).toBe(true);
		removeWorktree(created.worktreePath);
	});

	it("fails validation outside git repositories", () => {
		const outside = mkdtempSync(join(tmpdir(), "tallow-worktree-nogit-"));
		try {
			expect(() => validateGitRepo(outside)).toThrow(
				/not inside a git repository|not a git repository/i
			);
		} finally {
			rmSync(outside, { force: true, recursive: true });
		}
	});

	it("removes worktrees and is idempotent for missing paths", () => {
		const created = createWorktree(repoRoot, { scope: "session" });
		const first = removeWorktree(created.worktreePath);
		expect(first.removed).toBe(true);
		expect(existsSync(created.worktreePath)).toBe(false);

		const second = removeWorktree(created.worktreePath);
		expect(second.method).toBe("none");
		expect(second.removed).toBe(false);
	});

	it("resolves repository root from nested directories", () => {
		const nested = join(repoRoot, "nested", "child");
		mkdirSync(nested, { recursive: true });
		const root = validateGitRepo(nested).repoRoot;
		expect(realpathSync(root)).toBe(realpathSync(repoRoot));
	});

	it("prunes stale managed worktrees whose owner pid is gone", () => {
		const created = createWorktree(repoRoot, { scope: "session" });
		const markerPath = join(created.worktreePath, TALLOW_WORKTREE_MARKER_FILE);
		const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
		marker.pid = 999_999_999;
		writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");

		const cleaned = cleanupStaleWorktrees(repoRoot);
		expect(cleaned.scannedCount).toBeGreaterThan(0);
		expect(cleaned.removedCount).toBeGreaterThanOrEqual(1);
		expect(existsSync(created.worktreePath)).toBe(false);
	});
});
