/**
 * Git Status Extension for Pi
 *
 * Shows git information in the status bar:
 * - Current branch name
 * - Dirty state (* if uncommitted changes)
 * - Ahead/behind remote
 * - PR status (if GitHub CLI available)
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getIcon } from "../_icons/index.js";

// Catppuccin Macchiato colors
const C_TEAL = "\x1b[38;2;139;213;202m"; // teal #8bd5ca
const C_YELLOW = "\x1b[38;2;238;212;159m"; // yellow #eed49f
const C_GREEN = "\x1b[38;2;166;218;149m"; // green #a6da95
const C_RED = "\x1b[38;2;237;135;150m"; // red #ed8796
const C_MAUVE = "\x1b[38;2;198;160;246m"; // mauve #c6a0f6
const C_GRAY = "\x1b[38;2;128;135;162m"; // overlay1 #8087a2
const C_RESET = "\x1b[0m";

/** Represents the current state of a git repository */
interface GitState {
	branch: string | null;
	dirty: boolean;
	ahead: number;
	behind: number;
	prState: "open" | "merged" | "closed" | "draft" | null;
	prNumber: number | null;
}

// Store interval on globalThis to clear across reloads
const G = globalThis;
if (G.__piGitStatusInterval) {
	clearInterval(G.__piGitStatusInterval);
	G.__piGitStatusInterval = null;
}
let lastCwd = "";
let cachedState: GitState | null = null;

/**
 * Executes a git command in the specified directory.
 * @param cmd - The git command to run (without 'git' prefix)
 * @param cwd - The working directory to run the command in
 * @returns The trimmed stdout output, or null if the command failed
 */
function runGit(cmd: string, cwd: string): string | null {
	try {
		return execSync(`git ${cmd}`, {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Retrieves the current git state for a directory.
 * Includes branch name, dirty status, ahead/behind counts, and PR info.
 * @param cwd - The working directory to check
 * @returns The git state object, or null if not a git repository
 */
function getGitState(cwd: string): GitState | null {
	// Single command: branch, ahead/behind, and porcelain status
	const raw = runGit("status --porcelain=v2 --branch", cwd);
	if (raw === null) return null;

	let branch: string | null = null;
	let ahead = 0;
	let behind = 0;
	let dirty = false;

	for (const line of raw.split("\n")) {
		if (line.startsWith("# branch.head ")) {
			branch = line.slice("# branch.head ".length);
			if (branch === "(detached)") {
				const sha = runGit("rev-parse --short HEAD", cwd);
				branch = sha ? `(${sha})` : branch;
			}
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

	// Try to get PR status using GitHub CLI
	let prState: GitState["prState"] = null;
	let prNumber: number | null = null;

	try {
		const prJson = execSync(`gh pr view --json state,number,isDraft 2>/dev/null || echo "{}"`, {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
		}).trim();

		if (prJson && prJson !== "{}") {
			const pr = JSON.parse(prJson);
			if (pr.number) {
				prNumber = pr.number;
				if (pr.isDraft) {
					prState = "draft";
				} else if (pr.state) {
					prState = pr.state.toLowerCase() as GitState["prState"];
				}
			}
		}
	} catch {
		// gh CLI not available or not in a GitHub repo
	}

	return { branch, dirty, ahead, behind, prState, prNumber };
}

/**
 * Formats the git state into a colored status string for display.
 * @param state - The git state to format
 * @returns A formatted string with ANSI color codes
 */
function formatStatus(state: GitState): string {
	const parts: string[] = [];

	// Branch name with dirty indicator
	let branchDisplay = `${C_TEAL}${state.branch}${C_RESET}`;
	if (state.dirty) {
		branchDisplay += `${C_YELLOW}*${C_RESET}`;
	}
	parts.push(branchDisplay);

	// Ahead/behind
	if (state.ahead > 0 || state.behind > 0) {
		const arrows: string[] = [];
		if (state.ahead > 0) arrows.push(`${C_GREEN}↑${state.ahead}${C_RESET}`);
		if (state.behind > 0) arrows.push(`${C_RED}↓${state.behind}${C_RESET}`);
		parts.push(arrows.join(""));
	}

	// PR status
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
 * Updates the git status in the UI status bar.
 * Caches the state to avoid redundant git calls.
 * @param ctx - The extension context providing UI access
 */
async function updateStatus(ctx: ExtensionContext): Promise<void> {
	const cwd = ctx.cwd;

	// Only update if cwd changed or no cache
	if (cwd !== lastCwd || !cachedState) {
		lastCwd = cwd;
		cachedState = getGitState(cwd);
	} else {
		// Refresh state periodically
		cachedState = getGitState(cwd);
	}

	if (cachedState) {
		ctx.ui.setStatus("git", formatStatus(cachedState));
	} else {
		ctx.ui.setStatus("git", undefined);
	}
}

/**
 * Registers the git status extension with Pi.
 * Sets up event handlers for session lifecycle and git state updates.
 * @param pi - The Pi extension API
 */
export default function gitStatus(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		await updateStatus(ctx);

		// Update every 10 seconds
		if (G.__piGitStatusInterval) clearInterval(G.__piGitStatusInterval);
		G.__piGitStatusInterval = setInterval(() => updateStatus(ctx), 10_000);
	});

	pi.on("session_shutdown", async () => {
		if (G.__piGitStatusInterval) {
			clearInterval(G.__piGitStatusInterval);
			G.__piGitStatusInterval = null;
		}
	});

	// Update after each agent turn (files may have changed)
	pi.on("agent_end", async (_event, ctx) => {
		// Clear cache to force refresh
		cachedState = null;
		await updateStatus(ctx);
	});

	// Update when directory changes
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "bash") {
			// Might have changed directory or git state
			cachedState = null;
			await updateStatus(ctx);
		}
	});
}
