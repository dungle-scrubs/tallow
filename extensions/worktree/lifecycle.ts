import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Managed worktree directory-name prefix in the system temp dir. */
export const TALLOW_WORKTREE_PREFIX = "tallow-worktree-";

/** Marker file written into managed worktrees for stale cleanup decisions. */
export const TALLOW_WORKTREE_MARKER_FILE = ".tallow-worktree.json";

/** Maximum runtime for git subprocess calls in milliseconds. */
const GIT_TIMEOUT_MS = 15_000;

/** Valid worktree isolation scopes. */
export type WorktreeScope = "session" | "subagent";

/** Options for creating a detached managed worktree. */
export interface CreateWorktreeOptions {
	readonly scope?: WorktreeScope;
	readonly id?: string;
	readonly agentId?: string;
	readonly timestampMs?: number;
}

/** Result from createWorktree. */
export interface CreatedWorktree {
	readonly id: string;
	readonly repoRoot: string;
	readonly scope: WorktreeScope;
	readonly timestampMs: number;
	readonly worktreePath: string;
}

/** Result from removeWorktree. */
export interface RemoveWorktreeResult {
	readonly method: "filesystem" | "git" | "none";
	readonly removed: boolean;
}

/** Aggregate stats from stale worktree cleanup. */
export interface WorktreeCleanupStats {
	readonly removedCount: number;
	readonly scannedCount: number;
}

/** On-disk marker payload used to identify managed worktrees. */
interface WorktreeMarker {
	readonly createdAt: string;
	readonly id: string;
	readonly pid: number;
	readonly repoRoot: string;
	readonly scope: WorktreeScope;
	agentId?: string;
}

/**
 * Validate that a working directory belongs to a git repository.
 *
 * @param cwd - Directory to validate
 * @returns Resolved git repository root
 * @throws {Error} When cwd is not inside a git repository
 */
export function validateGitRepo(cwd: string): { readonly repoRoot: string } {
	const resolvedCwd = resolve(cwd);
	const repoRoot = runGit(["-C", resolvedCwd, "rev-parse", "--show-toplevel"], resolvedCwd);
	if (!repoRoot) {
		throw new Error(`Not inside a git repository: ${resolvedCwd}`);
	}
	return { repoRoot: resolve(repoRoot) };
}

/**
 * Create a detached managed worktree for the given repository.
 *
 * @param repoRoot - Git repository root
 * @param options - Optional scope and identifier overrides
 * @returns Created worktree metadata
 * @throws {Error} When creation fails
 */
export function createWorktree(
	repoRoot: string,
	options: CreateWorktreeOptions = {}
): CreatedWorktree {
	const validatedRoot = validateGitRepo(repoRoot).repoRoot;
	const scope = options.scope ?? "session";
	const id = sanitizeSegment(options.id ?? randomUUID().slice(0, 8));
	const timestampMs = options.timestampMs ?? Date.now();
	const worktreePath = join(tmpdir(), `${TALLOW_WORKTREE_PREFIX}${scope}-${id}-${timestampMs}`);

	runGit(["-C", validatedRoot, "worktree", "add", "--detach", worktreePath, "HEAD"], validatedRoot);

	const marker: WorktreeMarker = {
		createdAt: new Date(timestampMs).toISOString(),
		id,
		pid: process.pid,
		repoRoot: validatedRoot,
		scope,
	};
	if (options.agentId) {
		marker.agentId = options.agentId;
	}
	writeMarkerFile(worktreePath, marker);

	return {
		id,
		repoRoot: validatedRoot,
		scope,
		timestampMs,
		worktreePath,
	};
}

/**
 * Remove a managed worktree path.
 *
 * Prefers `git worktree remove --force`. Falls back to filesystem deletion
 * plus `git worktree prune` when git removal fails.
 *
 * @param worktreePath - Worktree path to remove
 * @returns Removal outcome and method used
 */
export function removeWorktree(worktreePath: string): RemoveWorktreeResult {
	const absoluteWorktreePath = resolve(worktreePath);
	if (!existsSync(absoluteWorktreePath)) {
		return { method: "none", removed: false };
	}

	const marker = readMarkerFile(absoluteWorktreePath);
	const repoRootCandidates = new Set<string>();
	if (marker?.repoRoot) repoRootCandidates.add(resolve(marker.repoRoot));
	const inferredRoot = inferRepoRootFromWorktree(absoluteWorktreePath);
	if (inferredRoot) repoRootCandidates.add(inferredRoot);

	for (const repoRoot of repoRootCandidates) {
		try {
			runGit(["-C", repoRoot, "worktree", "remove", "--force", absoluteWorktreePath], repoRoot);
			pruneWorktrees(repoRoot);
			return { method: "git", removed: !existsSync(absoluteWorktreePath) };
		} catch {
			// Fall through to filesystem fallback.
		}
	}

	try {
		rmSync(absoluteWorktreePath, { force: true, recursive: true });
	} catch {
		// Best-effort fallback path.
	}
	for (const repoRoot of repoRootCandidates) {
		pruneWorktrees(repoRoot);
	}
	return { method: "filesystem", removed: !existsSync(absoluteWorktreePath) };
}

/**
 * Remove stale managed worktrees for a repository.
 *
 * A managed worktree is considered stale when either:
 * - it is not listed in `git worktree list --porcelain`, or
 * - its marker PID is not running anymore.
 *
 * @param repoRoot - Repository root to clean
 * @returns Number of scanned and removed worktrees
 */
export function cleanupStaleWorktrees(repoRoot: string): WorktreeCleanupStats {
	const validatedRoot = validateGitRepo(repoRoot).repoRoot;
	pruneWorktrees(validatedRoot);
	const activeWorktrees = listActiveWorktrees(validatedRoot);
	const managedWorktrees = listManagedWorktreePaths();

	let removedCount = 0;
	let scannedCount = 0;

	for (const worktreePath of managedWorktrees) {
		const marker = readMarkerFile(worktreePath);
		if (marker && resolve(marker.repoRoot) !== validatedRoot) continue;

		scannedCount += 1;
		const isActive = activeWorktrees.has(worktreePath);
		const hasLiveOwnerPid = marker ? isProcessAlive(marker.pid) : false;
		if (isActive && hasLiveOwnerPid) continue;
		if (isActive && !marker) continue;
		if (!marker && !isActive) continue;

		const removal = removeWorktree(worktreePath);
		if (removal.removed) {
			removedCount += 1;
		}
	}

	pruneWorktrees(validatedRoot);
	return { removedCount, scannedCount };
}

/**
 * List active git worktrees for a repository.
 *
 * @param repoRoot - Repository root
 * @returns Absolute worktree paths currently registered with git
 */
function listActiveWorktrees(repoRoot: string): Set<string> {
	const output = runGit(["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot);
	const active = new Set<string>();
	for (const line of output.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		const value = line.slice("worktree ".length).trim();
		if (!value) continue;
		active.add(resolve(value));
	}
	return active;
}

/**
 * Enumerate managed worktree directories in the system temp directory.
 *
 * @returns Absolute paths for managed worktree directories
 */
function listManagedWorktreePaths(): string[] {
	const root = tmpdir();
	const entries = readdirSync(root, { withFileTypes: true });
	const paths: string[] = [];
	for (const entry of entries) {
		if (!entry.name.startsWith(TALLOW_WORKTREE_PREFIX)) continue;
		const fullPath = join(root, entry.name);
		const isDirectory =
			entry.isDirectory() || (entry.isSymbolicLink() && safeIsDirectory(fullPath));
		if (!isDirectory) continue;
		paths.push(resolve(fullPath));
	}
	return paths;
}

/**
 * Check whether a path currently resolves to a directory.
 *
 * @param pathValue - Candidate directory path
 * @returns True when the path is a directory
 */
function safeIsDirectory(pathValue: string): boolean {
	try {
		return statSync(pathValue).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Parse a managed worktree marker file.
 *
 * @param worktreePath - Worktree directory path
 * @returns Marker payload when present and valid
 */
function readMarkerFile(worktreePath: string): WorktreeMarker | undefined {
	const markerPath = join(worktreePath, TALLOW_WORKTREE_MARKER_FILE);
	if (!existsSync(markerPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as Partial<WorktreeMarker>;
		if (!parsed || typeof parsed !== "object") return undefined;
		if (parsed.scope !== "session" && parsed.scope !== "subagent") return undefined;
		if (typeof parsed.repoRoot !== "string") return undefined;
		if (typeof parsed.id !== "string") return undefined;
		if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return undefined;
		if (typeof parsed.createdAt !== "string") return undefined;
		return {
			agentId: typeof parsed.agentId === "string" ? parsed.agentId : undefined,
			createdAt: parsed.createdAt,
			id: parsed.id,
			pid: Math.floor(parsed.pid),
			repoRoot: resolve(parsed.repoRoot),
			scope: parsed.scope,
		};
	} catch {
		return undefined;
	}
}

/**
 * Write marker metadata into a managed worktree directory.
 *
 * @param worktreePath - Worktree directory path
 * @param marker - Marker payload
 */
function writeMarkerFile(worktreePath: string, marker: WorktreeMarker): void {
	const markerPath = join(worktreePath, TALLOW_WORKTREE_MARKER_FILE);
	writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
}

/**
 * Infer repository root from a worktree path.
 *
 * @param worktreePath - Worktree directory path
 * @returns Repository root when detectable
 */
function inferRepoRootFromWorktree(worktreePath: string): string | undefined {
	try {
		const output = runGit(["-C", worktreePath, "rev-parse", "--show-toplevel"], worktreePath);
		return output ? resolve(output) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Run `git worktree prune` for a repository root.
 *
 * @param repoRoot - Repository root
 */
function pruneWorktrees(repoRoot: string): void {
	try {
		runGit(["-C", repoRoot, "worktree", "prune"], repoRoot);
	} catch {
		// Best-effort cleanup path.
	}
}

/**
 * Check whether a PID appears alive.
 *
 * @param pid - Process identifier
 * @returns True when the process is alive
 */
function isProcessAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Sanitize a user-provided segment for safe path construction.
 *
 * @param value - Raw segment value
 * @returns Safe kebab-style segment
 */
function sanitizeSegment(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!normalized) return "task";
	return normalized.slice(0, 48);
}

/**
 * Execute a git command and return trimmed stdout.
 *
 * @param args - Git command arguments
 * @param cwd - Working directory
 * @returns Trimmed command output
 * @throws {Error} When git exits non-zero
 */
function runGit(args: string[], cwd: string): string {
	const options: ExecFileSyncOptions = {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
	};
	try {
		const output = execFileSync("git", args, options) as string;
		return output.trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`git ${args.join(" ")} failed: ${message}`);
	}
}
