/**
 * Git Status Extension for Pi
 *
 * Shows git information in the status bar:
 * - Current branch name
 * - Dirty state (* if uncommitted changes)
 * - Ahead/behind remote
 * - PR status (if GitHub CLI is available and responsive)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getIcon } from "../_icons/index.js";
import { runCommand, runGitCommand } from "../_shared/shell-policy.js";

// Catppuccin Macchiato colors
const C_TEAL = "\x1b[38;2;139;213;202m"; // teal #8bd5ca
const C_YELLOW = "\x1b[38;2;238;212;159m"; // yellow #eed49f
const C_GREEN = "\x1b[38;2;166;218;149m"; // green #a6da95
const C_RED = "\x1b[38;2;237;135;150m"; // red #ed8796
const C_MAUVE = "\x1b[38;2;198;160;246m"; // mauve #c6a0f6
const C_GRAY = "\x1b[38;2;128;135;162m"; // overlay1 #8087a2
const C_RESET = "\x1b[0m";

const STATUS_REFRESH_INTERVAL_MS = 10_000;
const PR_REFRESH_INTERVAL_MS = 60_000;
const PR_TIMEOUT_MS = 1_500;
const PR_ERROR_COOLDOWN_MS = 5 * 60_000;

type PullRequestState = "open" | "merged" | "closed" | "draft" | null;

/** Represents the current state of a git repository. */
export interface GitState {
	branch: string | null;
	dirty: boolean;
	ahead: number;
	behind: number;
	prState: PullRequestState;
	prNumber: number | null;
}

interface PullRequestInfo {
	prState: PullRequestState;
	prNumber: number | null;
}

interface GitStatusGlobals {
	__piGitStatusInterval?: ReturnType<typeof setInterval> | null;
}

const G = globalThis as typeof globalThis & GitStatusGlobals;
if (G.__piGitStatusInterval) {
	clearInterval(G.__piGitStatusInterval);
	G.__piGitStatusInterval = null;
}

let lastCwd = "";
let cachedState: GitState | null = null;
let activeRefresh: Promise<void> | null = null;
let queuedRefresh: { ctx: ExtensionContext; revision: number } | null = null;
let sessionRevision = 0;
let lastPrRefreshAt = 0;
let prCooldownUntil = 0;

/**
 * Parse `git status --porcelain=v2 --branch` output into a base git state.
 *
 * @param raw - Raw porcelain-v2 status output
 * @returns Parsed git state without PR metadata, or null when no branch is found
 */
export function parseGitStatus(raw: string): GitState | null {
	let branch: string | null = null;
	let ahead = 0;
	let behind = 0;
	let dirty = false;

	for (const line of raw.split("\n")) {
		if (line.startsWith("# branch.head ")) {
			branch = line.slice("# branch.head ".length);
		} else if (line.startsWith("# branch.ab ")) {
			const match = line.match(/\+(\d+) -(\d+)/);
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
		} else if (line.length > 0 && !line.startsWith("#")) {
			dirty = true;
		}
	}

	if (!branch) return null;
	return { branch, dirty, ahead, behind, prState: null, prNumber: null };
}

/**
 * Parse `gh pr view --json state,number,isDraft` output.
 *
 * @param raw - Raw gh JSON output
 * @returns Parsed pull-request metadata, or null when unavailable
 */
export function parsePullRequestInfo(raw: string): PullRequestInfo | null {
	const parsed = JSON.parse(raw) as {
		number?: number;
		isDraft?: boolean;
		state?: string;
	};
	if (!parsed.number) return null;
	if (parsed.isDraft) {
		return { prState: "draft", prNumber: parsed.number };
	}
	if (!parsed.state) return null;
	return {
		prState: parsed.state.toLowerCase() as Exclude<PullRequestState, null>,
		prNumber: parsed.number,
	};
}

/**
 * Returns whether a gh stderr payload means “no PR” rather than a broken CLI.
 *
 * @param stderr - gh stderr text
 * @returns True when the branch simply has no associated pull request
 */
function isNoPullRequestError(stderr: string): boolean {
	return /no pull requests? found/i.test(stderr);
}

/**
 * Returns whether a gh failure should trigger a long retry cooldown.
 *
 * @param result - Process result from the gh invocation
 * @returns True when failures are likely environmental or timeout-related
 */
function shouldCooldownPullRequestChecks(result: {
	reason?: string;
	stderr: string;
	exitCode: number | null;
}): boolean {
	if (result.reason?.includes("timed out")) return true;
	if (result.reason?.includes("ENOENT")) return true;
	if (result.exitCode === null && result.reason) return true;
	return /could not resolve to a repository|no git remotes found|not a git repository/i.test(
		result.stderr
	);
}

/**
 * Execute a git command asynchronously.
 *
 * @param args - Git subcommand and arguments
 * @param cwd - Working directory
 * @param timeoutMs - Optional timeout override
 * @returns Trimmed stdout output, or null on failure
 */
async function runGit(
	args: readonly string[],
	cwd: string,
	timeoutMs = 3_000
): Promise<string | null> {
	return await runGitCommand(args, cwd, timeoutMs);
}

/**
 * Read branch, ahead/behind, and dirty state without blocking the UI thread.
 *
 * @param cwd - Working directory to inspect
 * @returns Base git state, or null when not inside a git repository
 */
async function getBaseGitState(cwd: string): Promise<GitState | null> {
	const raw = await runGit(["status", "--porcelain=v2", "--branch"], cwd);
	if (raw === null) return null;

	const state = parseGitStatus(raw);
	if (!state) return null;
	if (state.branch !== "(detached)") return state;

	const sha = await runGit(["rev-parse", "--short", "HEAD"], cwd);
	if (sha) {
		state.branch = `(${sha})`;
	}
	return state;
}

/**
 * Resolve pull-request metadata for the current branch.
 *
 * @param cwd - Working directory to inspect
 * @returns PR metadata, null for no PR / unavailable data, and cooldown on repeated failures
 */
async function getPullRequestInfoForBranch(cwd: string): Promise<PullRequestInfo | null> {
	const result = await runCommand({
		command: "gh",
		args: ["pr", "view", "--json", "state,number,isDraft"],
		cwd,
		source: "git-helper",
		timeoutMs: PR_TIMEOUT_MS,
	});
	if (result.ok && result.stdout) {
		try {
			return parsePullRequestInfo(result.stdout);
		} catch {
			prCooldownUntil = Date.now() + PR_ERROR_COOLDOWN_MS;
			return null;
		}
	}

	if (isNoPullRequestError(result.stderr)) {
		return null;
	}

	if (shouldCooldownPullRequestChecks(result)) {
		prCooldownUntil = Date.now() + PR_ERROR_COOLDOWN_MS;
	}
	return null;
}

/**
 * Returns whether PR metadata should be refreshed for the current branch.
 *
 * @param baseState - Freshly computed base git state
 * @param previousState - Previously cached state before the current refresh
 * @returns True when a PR refresh is worth attempting
 */
function shouldRefreshPullRequest(baseState: GitState, previousState: GitState | null): boolean {
	if (baseState.branch === null) return false;
	if (Date.now() < prCooldownUntil) return false;
	if (!previousState) return true;
	if (previousState.branch !== baseState.branch) return true;
	return Date.now() - lastPrRefreshAt >= PR_REFRESH_INTERVAL_MS;
}

/**
 * Formats the git state into a colored status string for display.
 *
 * @param state - The git state to format
 * @returns A formatted string with ANSI color codes
 */
export function formatStatus(state: GitState): string {
	const parts: string[] = [];

	let branchDisplay = `${C_TEAL}${state.branch}${C_RESET}`;
	if (state.dirty) {
		branchDisplay += `${C_YELLOW}*${C_RESET}`;
	}
	parts.push(branchDisplay);

	if (state.ahead > 0 || state.behind > 0) {
		const arrows: string[] = [];
		if (state.ahead > 0) arrows.push(`${C_GREEN}↑${state.ahead}${C_RESET}`);
		if (state.behind > 0) arrows.push(`${C_RED}↓${state.behind}${C_RESET}`);
		parts.push(arrows.join(""));
	}

	if (state.prState && state.prNumber) {
		let prDisplay: string;
		switch (state.prState) {
			case "open":
				prDisplay = `${C_GREEN}PR#${state.prNumber}${C_RESET}`;
				break;
			case "draft":
				prDisplay = `${C_GRAY}PR#${state.prNumber}(draft)${C_RESET}`;
				break;
			case "merged":
				prDisplay = `${C_MAUVE}PR#${state.prNumber}${getIcon("success")}${C_RESET}`;
				break;
			case "closed":
				prDisplay = `${C_RED}PR#${state.prNumber}${getIcon("error")}${C_RESET}`;
				break;
			default:
				prDisplay = "";
		}
		if (prDisplay) parts.push(prDisplay);
	}

	return parts.join(" ");
}

/**
 * Push the current cached status into the UI.
 *
 * @param ctx - Extension context providing the UI surface
 * @param revision - Session revision that must still be current
 * @returns Nothing
 */
function renderCachedStatus(ctx: ExtensionContext, revision: number): void {
	if (revision !== sessionRevision) return;
	if (ctx.cwd !== lastCwd || !cachedState) {
		ctx.ui.setStatus("git", undefined);
		return;
	}
	ctx.ui.setStatus("git", formatStatus(cachedState));
}

/**
 * Refresh the git status cache without blocking terminal input.
 *
 * Concurrent refreshes are coalesced so timer ticks, agent-end hooks, and bash
 * results cannot stack multiple in-flight `git`/`gh` subprocesses.
 *
 * @param ctx - Extension context providing cwd + ui access
 * @param revision - Session revision that must remain current while refreshing
 * @returns Promise resolving after the latest queued refresh finishes
 */
async function refreshStatus(ctx: ExtensionContext, revision: number): Promise<void> {
	if (activeRefresh) {
		queuedRefresh = { ctx, revision };
		return;
	}

	const cwd = ctx.cwd;
	activeRefresh = (async () => {
		const baseState = await getBaseGitState(cwd);
		if (revision !== sessionRevision || ctx.cwd !== cwd) return;

		lastCwd = cwd;
		if (!baseState) {
			cachedState = null;
			renderCachedStatus(ctx, revision);
			return;
		}

		const previousState = cachedState;
		cachedState = {
			...baseState,
			prState: previousState?.branch === baseState.branch ? previousState.prState : null,
			prNumber: previousState?.branch === baseState.branch ? previousState.prNumber : null,
		};
		renderCachedStatus(ctx, revision);

		if (!shouldRefreshPullRequest(baseState, previousState)) {
			return;
		}

		const prInfo = await getPullRequestInfoForBranch(cwd);
		if (revision !== sessionRevision || ctx.cwd !== cwd) return;
		if (!cachedState || cachedState.branch !== baseState.branch) return;

		cachedState = {
			...cachedState,
			prState: prInfo?.prState ?? null,
			prNumber: prInfo?.prNumber ?? null,
		};
		lastPrRefreshAt = Date.now();
		renderCachedStatus(ctx, revision);
	})().finally(() => {
		activeRefresh = null;
		const nextRefresh = queuedRefresh;
		queuedRefresh = null;
		if (nextRefresh) {
			void refreshStatus(nextRefresh.ctx, nextRefresh.revision);
		}
	});

	await activeRefresh;
}

/**
 * Invalidate caches that should be recomputed on the next refresh.
 *
 * @returns Nothing
 */
function invalidateStatusCache(): void {
	cachedState = null;
	lastPrRefreshAt = 0;
}

/**
 * Registers the git status extension with Pi.
 *
 * @param pi - The Pi extension API
 * @returns Nothing
 */
export default function gitStatus(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const revision = ++sessionRevision;
		renderCachedStatus(ctx, revision);
		void refreshStatus(ctx, revision);

		if (G.__piGitStatusInterval) clearInterval(G.__piGitStatusInterval);
		G.__piGitStatusInterval = setInterval(() => {
			void refreshStatus(ctx, revision);
		}, STATUS_REFRESH_INTERVAL_MS);
	});

	pi.on("session_shutdown", () => {
		sessionRevision += 1;
		queuedRefresh = null;
		if (G.__piGitStatusInterval) {
			clearInterval(G.__piGitStatusInterval);
			G.__piGitStatusInterval = null;
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		invalidateStatusCache();
		void refreshStatus(ctx, sessionRevision);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "bash") return;
		invalidateStatusCache();
		void refreshStatus(ctx, sessionRevision);
	});
}
