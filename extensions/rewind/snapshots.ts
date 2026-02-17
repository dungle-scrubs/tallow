/**
 * Git Snapshot Manager
 *
 * Creates and restores lightweight git ref-based snapshots at conversation
 * turn boundaries. Uses a temporary GIT_INDEX_FILE to capture the full
 * working tree state (tracked + untracked) without touching the user's
 * staging area or polluting the reflog.
 *
 * Snapshot commits are created via `git write-tree` + `git commit-tree`
 * on the temporary index, then stored under a namespaced ref:
 *   refs/tallow/rewind/<session-id>/turn-<N>
 *
 * Why refs over stashes: stashes are LIFO, refs give O(1) random access
 * and don't pollute the user's stash list.
 */

import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
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

/** Metadata for a stored snapshot. */
export interface SnapshotInfo {
	turnIndex: number;
	ref: string;
	sha: string;
}

/**
 * Manages git ref-based snapshots for rewind functionality.
 *
 * Each snapshot captures the full working tree state at a turn boundary.
 * Snapshots are stored as lightweight refs that can be restored independently.
 */
export class SnapshotManager {
	private readonly cwd: string;
	private readonly refPrefix: string;

	/**
	 * Creates a new SnapshotManager.
	 *
	 * @param cwd - Working directory (must be inside a git repo)
	 * @param sessionId - Session ID for namespacing refs
	 */
	constructor(cwd: string, sessionId: string) {
		this.cwd = cwd;
		this.refPrefix = `refs/tallow/rewind/${sessionId}`;
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
	 * 1. Stage all files (tracked + untracked) into a temp index
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
		const tmpIndex = join(this.cwd, ".git", "tallow-snapshot-index");

		try {
			// Stage everything into the temp index (captures untracked files too)
			this.gitWithEnv(["add", "-A"], { GIT_INDEX_FILE: tmpIndex });

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
	 * Restores the working tree to the state captured in a snapshot.
	 *
	 * Strategy:
	 * 1. List files in the snapshot tree
	 * 2. List current working tree files (tracked + untracked)
	 * 3. Checkout all snapshot files from the ref
	 * 4. Delete files that exist now but didn't exist in the snapshot
	 * 5. Reset the index to HEAD (checkout stages files it touches)
	 *
	 * @param ref - The snapshot ref to restore (e.g. refs/tallow/rewind/.../turn-1)
	 * @returns Detailed restore result
	 * @throws {Error} If the ref doesn't exist or git commands fail
	 */
	restoreSnapshot(ref: string): RestoreResult {
		const snapshotFiles = this.getSnapshotFiles(ref);
		const currentFiles = this.getCurrentFiles();

		// Files to delete: exist now but not in snapshot
		const snapshotSet = new Set(snapshotFiles);
		const filesToDelete = currentFiles.filter((f) => !snapshotSet.has(f));

		// Restore all files from the snapshot commit's tree
		if (snapshotFiles.length > 0) {
			this.git(["checkout", ref, "--", "."]);
		}

		// Delete files that were created after the snapshot.
		// Use fs.unlinkSync for reliability — git rm only works for tracked files.
		for (const file of filesToDelete) {
			try {
				unlinkSync(join(this.cwd, file));
			} catch {
				// File might already be gone — best effort
			}
		}

		// Clean the index — `git checkout ref -- .` stages everything it touches.
		// This is intentional (we just replaced the working tree), so the staging
		// area reset is expected here.
		this.git(["reset", "HEAD", "--quiet"]);

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
	 * Gets all current files in the working tree (tracked + untracked).
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
	 * Executes a git command via arg-array spawn and returns trimmed stdout.
	 *
	 * @param args - Git subcommand and arguments as an array
	 * @returns Trimmed output, or null on failure
	 */
	private git(args: string[]): string | null {
		return runGitCommandSync(args, this.cwd, 10_000);
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
			cwd: this.cwd,
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: 10 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});

		if (result.error || result.status !== 0) return null;
		return (result.stdout ?? "").toString().trim() || null;
	}
}
