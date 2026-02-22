import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitCommandSync } from "../../_shared/shell-policy.js";
import { SnapshotManager } from "../snapshots.js";

/**
 * Helper to run a git command in a directory via arg-array spawn.
 *
 * @param args - Git subcommand and arguments as an array
 * @param cwd - Working directory
 * @returns Trimmed stdout
 * @throws {Error} If the git command exits non-zero
 */
function git(args: string[], cwd: string): string {
	const result = runGitCommandSync(args, cwd, 10_000);
	if (result === null) throw new Error(`git ${args.join(" ")} failed`);
	return result;
}

/**
 * Creates a temporary git repo for testing.
 *
 * @returns Path to the temp directory
 */
function createTempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "rewind-test-"));
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	// Create initial commit so HEAD exists
	writeFileSync(join(dir, ".gitkeep"), "");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	return dir;
}

describe("SnapshotManager", () => {
	let tmpDir: string;
	let mgr: SnapshotManager;

	beforeEach(() => {
		tmpDir = createTempRepo();
		mgr = new SnapshotManager(tmpDir, "test-session");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should detect a git repo", () => {
		expect(mgr.isGitRepo()).toBe(true);
	});

	it("should detect a non-git directory", () => {
		const nonGit = mkdtempSync(join(tmpdir(), "rewind-nogit-"));
		const nonGitMgr = new SnapshotManager(nonGit, "test");
		expect(nonGitMgr.isGitRepo()).toBe(false);
		rmSync(nonGit, { recursive: true, force: true });
	});

	it("should create a snapshot ref", () => {
		writeFileSync(join(tmpDir, "a.txt"), "changed");
		const ref = mgr.createSnapshot(1);

		expect(ref).toBe("refs/tallow/rewind/test-session/turn-1");

		// Verify ref exists in git
		const refOutput = git(["show-ref", "refs/tallow/rewind/test-session/turn-1"], tmpDir);
		expect(refOutput).toBeTruthy();
	});

	it("should return null when there are no changes", () => {
		// Working tree matches HEAD — nothing to snapshot
		const ref = mgr.createSnapshot(1);
		expect(ref).toBeNull();
	});

	it("should not leave index dirty after creating snapshot", () => {
		writeFileSync(join(tmpDir, "a.txt"), "changed");
		mgr.createSnapshot(1);

		const status = git(["status", "--porcelain"], tmpDir);
		// a.txt should show as untracked (??) not staged
		const lines = status.split("\n").filter(Boolean);
		for (const line of lines) {
			// Should not have staged (A/M in first column) entries for our file
			if (line.includes("a.txt")) {
				expect(line.startsWith("??")).toBe(true);
			}
		}
	});

	it("should restore a snapshot", () => {
		// Initial state: a.txt = "hello"
		writeFileSync(join(tmpDir, "a.txt"), "hello");
		git(["add", "a.txt"], tmpDir);
		git(["commit", "-m", "add a"], tmpDir);

		// Modify and snapshot at turn 1
		writeFileSync(join(tmpDir, "a.txt"), "state-at-turn-1");
		const ref = mgr.createSnapshot(1);
		expect(ref).not.toBeNull();

		// Modify further (simulating turn 2)
		writeFileSync(join(tmpDir, "a.txt"), "state-at-turn-2");

		// Rewind to turn 1
		expect(ref).toBeDefined();
		const result = mgr.restoreSnapshot(ref as string);
		const content = readFileSync(join(tmpDir, "a.txt"), "utf-8");
		expect(content).toBe("state-at-turn-1");
		expect(result.restored.length).toBeGreaterThan(0);
	});

	it("creates snapshots from nested subdirectories", () => {
		const subDir = join(tmpDir, "sub");
		mkdirSync(subDir, { recursive: true });

		writeFileSync(join(tmpDir, "root.txt"), "base-root");
		git(["add", "-A"], tmpDir);
		git(["commit", "-m", "base"], tmpDir);

		const subMgr = new SnapshotManager(subDir, "nested-session");
		writeFileSync(join(tmpDir, "root.txt"), "changed-from-subdir");

		const ref = subMgr.createSnapshot(1);
		expect(ref).toBe("refs/tallow/rewind/nested-session/turn-1");
	});

	it("restores full repo state when manager cwd is a subdirectory", () => {
		const subDir = join(tmpDir, "sub");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(join(tmpDir, "root.txt"), "base-root");
		writeFileSync(join(subDir, "a.txt"), "base-a");
		git(["add", "-A"], tmpDir);
		git(["commit", "-m", "base"], tmpDir);

		const subMgr = new SnapshotManager(subDir, "nested-session");
		writeFileSync(join(tmpDir, "root.txt"), "snap-root");
		writeFileSync(join(subDir, "a.txt"), "snap-a");
		writeFileSync(join(subDir, "new.txt"), "snap-new");
		const ref = subMgr.createSnapshot(1);
		expect(ref).not.toBeNull();

		writeFileSync(join(tmpDir, "root.txt"), "after-root");
		writeFileSync(join(subDir, "a.txt"), "after-a");
		writeFileSync(join(subDir, "after-only.txt"), "after-only");

		subMgr.restoreSnapshot(ref as string);

		expect(readFileSync(join(tmpDir, "root.txt"), "utf-8")).toBe("snap-root");
		expect(readFileSync(join(subDir, "a.txt"), "utf-8")).toBe("snap-a");
		expect(readFileSync(join(subDir, "new.txt"), "utf-8")).toBe("snap-new");
		expect(existsSync(join(subDir, "after-only.txt"))).toBe(false);
	});

	it("should remove files created after the snapshot point", () => {
		// Snapshot at turn 1 — no new-file.ts
		writeFileSync(join(tmpDir, "a.txt"), "v1");
		const ref = mgr.createSnapshot(1);
		expect(ref).not.toBeNull();

		// Create new-file.ts at "turn 2"
		writeFileSync(join(tmpDir, "new-file.ts"), "created after snapshot");

		// Rewind to turn 1
		expect(ref).toBeDefined();
		mgr.restoreSnapshot(ref as string);
		expect(existsSync(join(tmpDir, "new-file.ts"))).toBe(false);
	});

	it("should list snapshots ordered by turn index", () => {
		writeFileSync(join(tmpDir, "a.txt"), "v1");
		mgr.createSnapshot(1);
		writeFileSync(join(tmpDir, "a.txt"), "v2");
		mgr.createSnapshot(3);
		writeFileSync(join(tmpDir, "a.txt"), "v3");
		mgr.createSnapshot(2);

		const snapshots = mgr.listSnapshots();
		expect(snapshots).toHaveLength(3);
		expect(snapshots[0].turnIndex).toBe(1);
		expect(snapshots[1].turnIndex).toBe(2);
		expect(snapshots[2].turnIndex).toBe(3);
	});

	it("should return snapshot SHAs as 40-char hex", () => {
		writeFileSync(join(tmpDir, "a.txt"), "v1");
		mgr.createSnapshot(1);

		const snapshots = mgr.listSnapshots();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].sha).toMatch(/^[a-f0-9]{40}$/);
	});

	it("should clean up all refs for a session", () => {
		writeFileSync(join(tmpDir, "a.txt"), "v1");
		mgr.createSnapshot(1);
		writeFileSync(join(tmpDir, "a.txt"), "v2");
		mgr.createSnapshot(2);

		mgr.cleanup();

		const refs = git(["for-each-ref", "refs/tallow/rewind/test-session/"], tmpDir);
		expect(refs.trim()).toBe("");
	});

	it("should not interfere with other sessions' refs", () => {
		const otherMgr = new SnapshotManager(tmpDir, "other-session");

		writeFileSync(join(tmpDir, "a.txt"), "v1");
		mgr.createSnapshot(1);
		writeFileSync(join(tmpDir, "a.txt"), "v2");
		otherMgr.createSnapshot(1);

		// Clean up only our session
		mgr.cleanup();

		// Other session's refs should still exist
		const refs = git(["for-each-ref", "refs/tallow/rewind/other-session/"], tmpDir);
		expect(refs.trim()).not.toBe("");

		// Our refs should be gone
		const ourRefs = git(["for-each-ref", "refs/tallow/rewind/test-session/"], tmpDir);
		expect(ourRefs.trim()).toBe("");

		otherMgr.cleanup();
	});

	it("should return empty list when no snapshots exist", () => {
		expect(mgr.listSnapshots()).toHaveLength(0);
	});

	it("should preserve user-staged files during snapshot creation", () => {
		// User stages a file manually
		writeFileSync(join(tmpDir, "staged.txt"), "user content");
		git(["add", "staged.txt"], tmpDir);

		// Also create an untracked file to trigger a snapshot
		writeFileSync(join(tmpDir, "untracked.txt"), "other");

		// Verify staged.txt is in the index before snapshot
		const before = git(["diff", "--cached", "--name-only"], tmpDir);
		expect(before).toContain("staged.txt");

		// Create snapshot — this should NOT disturb the staging area
		const ref = mgr.createSnapshot(1);
		expect(ref).not.toBeNull();

		// Verify staged.txt is STILL in the index after snapshot
		const after = git(["diff", "--cached", "--name-only"], tmpDir);
		expect(after).toContain("staged.txt");
	});

	it("should not pollute the reflog during snapshot creation", () => {
		const reflogBefore = git(["reflog", "--format=%H"], tmpDir).split("\n").filter(Boolean).length;

		// Create multiple snapshots
		writeFileSync(join(tmpDir, "a.txt"), "v1");
		mgr.createSnapshot(1);
		writeFileSync(join(tmpDir, "a.txt"), "v2");
		mgr.createSnapshot(2);
		writeFileSync(join(tmpDir, "a.txt"), "v3");
		mgr.createSnapshot(3);

		const reflogAfter = git(["reflog", "--format=%H"], tmpDir).split("\n").filter(Boolean).length;

		// Snapshot creation should add zero reflog entries
		expect(reflogAfter).toBe(reflogBefore);
	});
});
