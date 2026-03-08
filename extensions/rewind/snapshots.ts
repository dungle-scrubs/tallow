/**
 * Git Snapshot Manager
 *
 * Creates and restores lightweight git ref-based snapshots at conversation
 * turn boundaries. Uses a temporary GIT_INDEX_FILE to capture git's tracked
 * + unignored working tree view without touching the user's staging area or
 * polluting the reflog.
 *
 * Snapshot commits are created via `git write-tree` + `git commit-tree`
 * on the temporary index, then stored under a namespaced ref:
 *   refs/tallow/rewind/<session-id>/turn-<N>
 *
 * Why refs over stashes: stashes are LIFO, refs give O(1) random access
 * and don't pollute the user's stash list.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runGitCommandSync } from "../_shared/shell-policy.js";

/** Result of restoring a snapshot. */
export interface RestoreResult {
	/** Files restored to snapshot state. */
	restored: string[];
	/** Files deleted because they didn't exist at snapshot time. */
	deleted: string[];
	/** Total file count in the snapshot. */
	snapshotFileCount: number;
}

/** Result of creating a turn snapshot. */
export interface TurnSnapshotResult {
	/** The ref name for the snapshot. */
	ref: string;
	/** True when the snapshot fell back to HEAD because createSnapshot failed. */
	headFallback: boolean;
}

/** Metadata for a stored snapshot. */
export interface SnapshotInfo {
	turnIndex: number;
	ref: string;
	sha: string;
}

/** Saved real-index state restored after destructive checkout operations. */
interface GitIndexBackup {
	backupPath: string;
	indexPath: string;
}

/**
 * Manages git ref-based snapshots for rewind functionality.
 *
 * Each snapshot captures git's tracked + unignored view of the working tree
 * at a turn boundary. Ignored files remain outside the snapshot model.
 * Snapshots are stored as lightweight refs that can be restored independently.
 */
export class SnapshotManager {
	private readonly repoRoot: string;
	private readonly refPrefix: string;

	/**
	 * Creates a new SnapshotManager.
	 *
	 * @param cwd - Working directory (must be inside a git repo)
	 * @param sessionId - Session ID for namespacing refs
	 */
	constructor(cwd: string, sessionId: string) {
		this.repoRoot = this.resolveRepoRoot(cwd) ?? cwd;
		this.refPrefix = `refs/tallow/rewind/${sessionId}`;
	}

	/**
	 * Resolve the canonical git repository root for the manager's cwd.
	 *
	 * @param cwd - Working directory that may be a nested subdirectory
	 * @returns Absolute repo root path, or null when outside a git worktree
	 */
	private resolveRepoRoot(cwd: string): string | null {
		return runGitCommandSync(["rev-parse", "--show-toplevel"], cwd, 10_000);
	}

	/**
	 * Checks whether the cwd is inside a git repository.
	 *
	 * @returns True if inside a git repo
	 */
	isGitRepo(): boolean {
		return this.git(["rev-parse", "--is-inside-work-tree"]) === "true";
	}

	/**
	 * Creates a snapshot of the current working tree state.
	 *
	 * Uses a temporary GIT_INDEX_FILE so the real index (user's staging
	 * area) is never touched and no reflog entries are created.
	 *
	 * Strategy:
	 * 1. Stage all tracked + unignored files into a temp index
	 * 2. Write a tree object from that temp index
	 * 3. Compare against HEAD's tree — bail if identical
	 * 4. Create a commit from the tree, parented on HEAD
	 * 5. Store the commit SHA under a namespaced ref
	 * 6. Clean up the temp index file
	 *
	 * @param turnIndex - The conversation turn being snapshotted
	 * @returns The ref name, or null if nothing to snapshot
	 */
	createSnapshot(turnIndex: number): string | null {
		const tmpIndex = join(tmpdir(), `tallow-snapshot-index-${process.pid}-${randomUUID()}`);

		try {
			// Stage everything into the temp index (captures untracked files too)
			const addResult = this.gitWithEnv(["add", "-A"], { GIT_INDEX_FILE: tmpIndex });
			if (addResult === null) return null;

			// Write a tree object from the temp index
			const tree = this.gitWithEnv(["write-tree"], { GIT_INDEX_FILE: tmpIndex });
			if (!tree) return null;

			// Compare against HEAD's tree — skip if nothing changed
			const headTree = this.git(["rev-parse", "HEAD^{tree}"]);
			if (tree === headTree) return null;

			// Create a commit from the tree, parented on HEAD
			const sha = this.git([
				"commit-tree",
				tree,
				"-p",
				"HEAD",
				"-m",
				`tallow rewind: turn ${turnIndex}`,
			]);
			if (!sha) return null;

			const ref = `${this.refPrefix}/turn-${turnIndex}`;
			this.git(["update-ref", ref, sha]);

			return ref;
		} finally {
			// Always clean up the temp index
			try {
				unlinkSync(tmpIndex);
			} catch {
				// May not exist if git add -A failed early
			}
		}
	}

	/**
	 * Ensure a turn has a stable rewind ref, even when the working tree matches HEAD.
	 *
	 * When no file content changed relative to HEAD, the turn still needs a rewind target.
	 * In that case, store a namespaced ref that points directly at the current HEAD commit.
	 *
	 * @param turnIndex - The conversation turn being snapshotted
	 * @returns Snapshot result with ref and fallback flag, or null if HEAD cannot be resolved
	 */
	createTurnSnapshot(turnIndex: number): TurnSnapshotResult | null {
		if (!this.hasSnapshotRelevantChanges()) {
			const headSha = this.git(["rev-parse", "HEAD"]);
			if (!headSha) return null;

			const ref = `${this.refPrefix}/turn-${turnIndex}`;
			this.git(["update-ref", ref, headSha]);
			return { ref, headFallback: false };
		}

		const createdRef = this.createSnapshot(turnIndex);
		if (createdRef) return { ref: createdRef, headFallback: false };

		// createSnapshot failed despite relevant changes — fall back to HEAD.
		// This means the snapshot may not capture uncommitted working tree state.
		const headSha = this.git(["rev-parse", "HEAD"]);
		if (!headSha) return null;

		const ref = `${this.refPrefix}/turn-${turnIndex}`;
		this.git(["update-ref", ref, headSha]);
		return { ref, headFallback: true };
	}

	/**
	 * Check whether the working tree differs from HEAD for rewind purposes.
	 *
	 * Uses `git status --porcelain` as a cheap preflight so turns without file
	 * changes do not pay the cost of a temp-index `git add -A` snapshot.
	 *
	 * @returns True when tracked or unignored files changed since HEAD
	 */
	private hasSnapshotRelevantChanges(): boolean {
		const status = this.git(["status", "--porcelain", "--untracked-files=all"]);
		return status !== null && status.length > 0;
	}

	/**
	 * Restores the working tree to the state captured in a snapshot.
	 *
	 * Strategy:
	 * 1. List files in the snapshot tree
	 * 2. List current working tree files (tracked + unignored)
	 * 3. Checkout all snapshot files from the ref
	 * 4. Delete files that exist now but didn't exist in the snapshot
	 * 5. Restore the user's original git index so staged work survives rewind
	 *
	 * @param ref - The snapshot ref to restore (e.g. refs/tallow/rewind/.../turn-1)
	 * @returns Detailed restore result
	 * @throws {Error} If the ref doesn't exist or git commands fail
	 */
	restoreSnapshot(ref: string): RestoreResult {
		const snapshotFiles = this.getSnapshotFiles(ref);
		const currentFiles = this.getCurrentFiles();
		const indexBackup = this.backupGitIndex();

		// Files to delete: exist now but not in snapshot
		const snapshotSet = new Set(snapshotFiles);
		const filesToDelete = currentFiles.filter((f) => !snapshotSet.has(f));

		try {
			// Restore all files from the snapshot commit's tree
			if (snapshotFiles.length > 0) {
				const checkoutResult = this.git(["checkout", ref, "--", "."]);
				if (checkoutResult === null) {
					throw new Error(`git checkout failed for ref ${ref} — files were not restored`);
				}
			}

			// Delete files that were created after the snapshot.
			// Use fs.unlinkSync for reliability — git rm only works for tracked files.
			for (const file of filesToDelete) {
				try {
					unlinkSync(join(this.repoRoot, file));
				} catch {
					// File might already be gone — best effort
				}
			}
		} finally {
			this.restoreGitIndex(indexBackup);
		}

		return {
			restored: snapshotFiles,
			deleted: filesToDelete,
			snapshotFileCount: snapshotFiles.length,
		};
	}

	/**
	 * Lists all snapshots for the current session.
	 *
	 * @returns Array of snapshot info, ordered by turn index
	 */
	listSnapshots(): SnapshotInfo[] {
		const raw = this.git(["for-each-ref", "--format=%(refname)", `${this.refPrefix}/`]);
		if (!raw) return [];

		return raw
			.split("\n")
			.map((l) => l.replace(/^"|"$/g, "").trim())
			.filter(Boolean)
			.map((ref) => {
				const match = ref.match(/turn-(\d+)$/);
				if (!match) return null;
				const sha = this.git(["rev-parse", ref]);
				if (!sha) return null;
				return {
					turnIndex: Number(match[1]),
					ref,
					sha,
				};
			})
			.filter((s): s is SnapshotInfo => s !== null)
			.sort((a, b) => a.turnIndex - b.turnIndex);
	}

	/**
	 * Removes all refs for the current session.
	 */
	cleanup(): void {
		const snapshots = this.listSnapshots();
		for (const snap of snapshots) {
			this.git(["update-ref", "-d", snap.ref]);
		}
	}

	/**
	 * Gets the list of files in a snapshot's tree.
	 *
	 * Snapshot commits are regular commits (not stashes), so all files —
	 * including previously-untracked ones — are in the main tree.
	 *
	 * @param ref - Snapshot ref
	 * @returns Array of file paths relative to the repo root
	 */
	private getSnapshotFiles(ref: string): string[] {
		const output = this.git(["ls-tree", "-r", "--name-only", ref]);
		return output ? output.split("\n").filter(Boolean) : [];
	}

	/**
	 * Gets all current files in the working tree (tracked + unignored).
	 *
	 * @returns Array of file paths relative to the repo root
	 */
	private getCurrentFiles(): string[] {
		// Tracked files
		const tracked = this.git(["ls-files"]);
		const files = new Set(tracked ? tracked.split("\n").filter(Boolean) : []);

		// Untracked files (excluding ignored)
		const untracked = this.git(["ls-files", "--others", "--exclude-standard"]);
		if (untracked) {
			for (const f of untracked.split("\n").filter(Boolean)) {
				files.add(f);
			}
		}

		return [...files];
	}

	/**
	 * Resolve the real git index path for the current repository/worktree.
	 *
	 * @returns Absolute path to the live git index, or null when unavailable
	 */
	private resolveGitIndexPath(): string | null {
		const indexPath = this.git(["rev-parse", "--git-path", "index"]);
		if (!indexPath) return null;
		return isAbsolute(indexPath) ? indexPath : resolve(this.repoRoot, indexPath);
	}

	/**
	 * Save the current git index so restore operations can put it back unchanged.
	 *
	 * @returns Backup metadata, or null when the index cannot be backed up
	 */
	private backupGitIndex(): GitIndexBackup | null {
		const indexPath = this.resolveGitIndexPath();
		if (!indexPath || !existsSync(indexPath)) return null;

		const backupPath = join(tmpdir(), `tallow-index-backup-${process.pid}-${randomUUID()}`);
		copyFileSync(indexPath, backupPath);
		return { backupPath, indexPath };
	}

	/**
	 * Restore a previously saved git index backup and remove the temp copy.
	 *
	 * @param backup - Backup metadata returned by {@link backupGitIndex}
	 * @returns void
	 */
	private restoreGitIndex(backup: GitIndexBackup | null): void {
		if (!backup) return;
		try {
			copyFileSync(backup.backupPath, backup.indexPath);
		} finally {
			try {
				unlinkSync(backup.backupPath);
			} catch {
				// Best-effort temp cleanup only.
			}
		}
	}

	/**
	 * Executes a git command via arg-array spawn and returns trimmed stdout.
	 *
	 * @param args - Git subcommand and arguments as an array
	 * @returns Trimmed output, or null on failure
	 */
	private git(args: string[]): string | null {
		return runGitCommandSync(args, this.repoRoot, 10_000);
	}

	/**
	 * Executes a git command with custom environment variables.
	 *
	 * Used for operations that need GIT_INDEX_FILE isolation to avoid
	 * disturbing the user's staging area.
	 *
	 * @param args - Git subcommand and arguments as an array
	 * @param env - Additional environment variables to set
	 * @returns Trimmed output, or null on failure
	 */
	private gitWithEnv(args: string[], env: Record<string, string>): string | null {
		const result = spawnSync("git", args, {
			cwd: this.repoRoot,
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: 10 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});

		if (result.error || result.status !== 0) return null;
		return (result.stdout ?? "").toString().trim();
	}
}
