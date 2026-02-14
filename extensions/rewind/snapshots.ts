/**
 * Git Snapshot Manager
 *
 * Creates and restores lightweight git ref-based snapshots at conversation
 * turn boundaries. Uses `git stash create` to capture working tree state
 * without modifying the index, then stores the SHA under a namespaced ref.
 *
 * Refs are stored at: refs/tallow/rewind/<session-id>/turn-<N>
 *
 * Why refs over stashes: stashes are LIFO, refs give O(1) random access
 * and don't pollute the user's stash list.
 */

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
	 * Uses `git stash create` to produce a commit object capturing the
	 * working tree + index without modifying either. If there are no
	 * changes from HEAD, returns null.
	 *
	 * @param turnIndex - The conversation turn being snapshotted
	 * @returns The ref name, or null if nothing to snapshot
	 */
	createSnapshot(turnIndex: number): string | null {
		// Stage everything so stash create captures untracked files too
		this.git(["add", "-A"]);

		const sha = this.git(["stash", "create"]);
		if (!sha) {
			// Nothing to stash — working tree matches HEAD
			// Unstage what we just staged
			this.git(["reset", "HEAD", "--quiet"]);
			return null;
		}

		// Unstage — we don't want to leave the index dirty
		this.git(["reset", "HEAD", "--quiet"]);

		const ref = `${this.refPrefix}/turn-${turnIndex}`;
		this.git(["update-ref", ref, sha]);

		return ref;
	}

	/**
	 * Restores the working tree to the state captured in a snapshot.
	 *
	 * Strategy:
	 * 1. List files in the snapshot tree
	 * 2. List current working tree files (tracked + untracked)
	 * 3. Checkout all snapshot files from the ref
	 * 4. Delete files that exist now but didn't exist in the snapshot
	 *
	 * @param ref - The snapshot ref to restore (e.g. refs/tallow/rewind/.../turn-1)
	 * @returns Detailed restore result
	 * @throws {Error} If the ref doesn't exist or git commands fail
	 */
	restoreSnapshot(ref: string): RestoreResult {
		// Get the tree SHA from the snapshot commit.
		// `git stash create` produces a merge commit: parent[0] = HEAD, parent[1] = index,
		// parent[2] = untracked. The working tree state is in the commit's own tree,
		// but we need to check the third parent for untracked files too.
		const snapshotFiles = this.getSnapshotFiles(ref);
		const currentFiles = this.getCurrentFiles();

		// Files to delete: exist now but not in snapshot
		const snapshotSet = new Set(snapshotFiles);
		const filesToDelete = currentFiles.filter((f) => !snapshotSet.has(f));

		// Restore all files from the snapshot
		// Use git checkout from the stash ref — this handles tracked file contents
		if (snapshotFiles.length > 0) {
			// Checkout the working tree state from the stash commit
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

		// Clean the index so we don't leave staged changes
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
	 * @param ref - Snapshot ref
	 * @returns Array of file paths relative to the repo root
	 */
	private getSnapshotFiles(ref: string): string[] {
		// The stash commit's tree contains the working tree state.
		// Also check the 3rd parent (untracked files) if it exists.
		const tracked = this.git(["ls-tree", "-r", "--name-only", ref]);
		const files = new Set(tracked ? tracked.split("\n").filter(Boolean) : []);

		// Check for untracked files parent (3rd parent of stash commit)
		const untrackedParent = this.git(["rev-parse", "--verify", `${ref}^3`]);
		if (untrackedParent) {
			const untracked = this.git(["ls-tree", "-r", "--name-only", untrackedParent]);
			if (untracked) {
				for (const f of untracked.split("\n").filter(Boolean)) {
					files.add(f);
				}
			}
		}

		return [...files];
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
}
