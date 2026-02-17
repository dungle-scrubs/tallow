/**
 * Custom Responsive Footer Extension
 *
 * Wide layout (2-3 lines):
 *   ~/dev/project                                                  main*
 *   ↑1.2k ↓39k R12M W708k $11.444 68.4%/200k (auto) tp:ok   model • high
 *   @main @alice @bob · 3 teammates                      ─ Session Name
 *
 * Line 3 only appears when agents or session name exist.
 *
 * Narrow layout (4-5 lines):
 *   ~/dev/project
 *    main*
 *   ↑1.2k ↓39k R12M W708k $11.444 68.4%/200k (auto)
 *   model • high
 *   @main @alice · 2 teammates               ─ Session Name
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { runGitCommandSync } from "../_shared/shell-policy.js";

/** Cached git repository state for the footer display. */
interface GitState {
	branch: string | null;
	dirty: boolean;
	ahead: number;
	behind: number;
	isWorktree: boolean;
}

// Cache git state to avoid running git on every render
let cachedGitState: GitState | null = null;
let cachedCwd: string | null = null;
let lastGitCheck = 0;
const GIT_CACHE_TTL = 5000; // 5 seconds

/**
 * Runs a git command via arg-array spawn and returns output or null on error.
 *
 * @param args - Git subcommand and arguments as an array
 * @returns Trimmed stdout output, or null if command failed
 */
function runGit(args: string[]): string | null {
	return runGitCommandSync(args, process.cwd(), 2000);
}

/**
 * Gets git state with caching. Only runs git commands if cache is stale.
 * @param forceRefresh - Force a refresh of the cache
 * @returns Git state object or null if not in a git repo
 */
function getGitState(forceRefresh = false): GitState | null {
	const now = Date.now();
	const cwd = process.cwd();

	// Return cached state if valid
	if (
		!forceRefresh &&
		cachedGitState !== null &&
		cachedCwd === cwd &&
		now - lastGitCheck < GIT_CACHE_TTL
	) {
		return cachedGitState;
	}

	// Refresh cache
	cachedCwd = cwd;
	lastGitCheck = now;

	const gitDir = runGit(["rev-parse", "--git-dir"]);
	if (!gitDir) {
		cachedGitState = null;
		return null;
	}

	let branch = runGit(["branch", "--show-current"]);
	if (!branch) {
		branch = runGit(["rev-parse", "--short", "HEAD"]);
		if (branch) branch = `(${branch})`;
	}
	if (!branch) {
		cachedGitState = null;
		return null;
	}

	const status = runGit(["status", "--porcelain"]);
	const dirty = status !== null && status.length > 0;

	let ahead = 0;
	let behind = 0;
	const upstream = runGit(["rev-parse", "--abbrev-ref", "@{upstream}"]);
	if (upstream) {
		const aheadBehind = runGit(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
		if (aheadBehind) {
			const [a, b] = aheadBehind.split(/\s+/).map(Number);
			ahead = a || 0;
			behind = b || 0;
		}
	}

	// Check worktree
	const isWorktree = gitDir.includes("/worktrees/");

	cachedGitState = { branch, dirty, ahead, behind, isWorktree };
	return cachedGitState;
}

/**
 * Invalidate the git cache (call after file operations)
 */
function invalidateGitCache(): void {
	lastGitCheck = 0;
}

// Minimum width for side-by-side layout
const MIN_WIDE_WIDTH = 100;

/**
 * Formats token counts with k/M suffixes for readability.
 * @param count - Token count to format
 * @returns Formatted string (e.g., "1.2k", "5M")
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/**
 * Sanitizes text for single-line display by collapsing whitespace.
 * @param text - Text to sanitize
 * @returns Cleaned single-line string
 */
function sanitize(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Aligns left and right content with padding between.
 * @param left - Left-aligned content
 * @param right - Right-aligned content
 * @param width - Total width to fill
 * @returns Padded string with left and right content
 */
function alignLeftRight(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const padding = Math.max(1, width - leftWidth - rightWidth);
	return left + " ".repeat(padding) + right;
}

/**
 * Registers a custom responsive footer showing git, tokens, and model info.
 * @param pi - Extension API for registering event handlers
 */
export default function customFooterExtension(pi: ExtensionAPI): void {
	let extensionCtx: ExtensionContext | null = null;
	const autoCompactEnabled = true;

	// Invalidate git cache after file operations
	pi.on("tool_result", async (event, _ctx) => {
		if (["write", "edit", "bash"].includes(event.toolName)) {
			invalidateGitCache();
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		extensionCtx = ctx;

		// Initial git state fetch
		getGitState(true);

		ctx.ui.setFooter((tui, theme, footerData) => {
			let disposeHandler: (() => void) | undefined;

			return {
				render(width: number): string[] {
					if (!extensionCtx) return [theme.fg("dim", "loading...")];

					const sessionManager = extensionCtx.sessionManager;
					const model = extensionCtx.model;

					// Calculate cumulative usage from session
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const usage = entry.message.usage;
							totalInput += usage.input;
							totalOutput += usage.output;
							totalCacheRead += usage.cacheRead;
							totalCacheWrite += usage.cacheWrite;
							totalCost += usage.cost.total;
						}
					}

					// Get context percentage from last assistant message
					const branch = sessionManager.getBranch();
					const lastAssistant = branch
						.slice()
						.reverse()
						.find(
							(e) =>
								e.type === "message" &&
								e.message.role === "assistant" &&
								(e.message as unknown as Record<string, string>).stopReason !== "aborted"
						);

					let contextTokens = 0;
					if (lastAssistant?.type === "message" && lastAssistant.message.role === "assistant") {
						const u = lastAssistant.message.usage;
						contextTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
					}

					const contextWindow = model?.contextWindow || 0;
					const contextPercentValue = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

					// Build path (replace home with ~)
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}

					// Demo mode: sanitize any remaining username references
					// (paths outside $HOME that weren't shortened to ~)
					const isDemo = process.env.IS_DEMO === "1" || process.env.TALLOW_DEMO === "1";
					if (isDemo) {
						const user = process.env.USER || process.env.USERNAME;
						if (user && pwd.includes(user)) {
							pwd = pwd.replaceAll(user, "demo");
						}
					}

					// Git branch with status symbols (cached!)
					const gitState = getGitState();
					let gitBranch = "";
					if (gitState?.branch) {
						const parts: string[] = [];
						// Worktree badge (teal bg, dark text) - to the left of branch
						if (gitState.isWorktree) {
							parts.push("\x1b[48;2;94;234;212m\x1b[38;2;19;78;74m worktree \x1b[0m");
						}
						// Branch icon and name (teal)
						parts.push(`\x1b[38;2;139;213;202m ${gitState.branch}\x1b[0m`);
						// Dirty indicator
						if (gitState.dirty) parts.push(theme.fg("warning", "*"));
						// Ahead/behind
						if (gitState.ahead > 0) parts.push(theme.fg("success", `↑${gitState.ahead}`));
						if (gitState.behind > 0) parts.push(theme.fg("error", `↓${gitState.behind}`));
						gitBranch = parts.join("");
					}

					// Build stats
					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
					if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

					// Context percentage with color
					const autoIndicator = autoCompactEnabled ? " (auto)" : "";
					const contextDisplay = `${contextPercentValue.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`;
					let contextStr: string;
					if (contextPercentValue > 90) {
						contextStr = theme.fg("error", contextDisplay);
					} else if (contextPercentValue > 70) {
						contextStr = theme.fg("warning", contextDisplay);
					} else {
						contextStr = contextDisplay;
					}
					statsParts.push(contextStr);

					// Extension statuses (exclude git — shown in top right; exclude agents — shown on line 3)
					const extensionStatuses = footerData.getExtensionStatuses();
					const statusParts: string[] = [];
					for (const [key, status] of extensionStatuses) {
						if (status && key !== "git" && key !== "agents") statusParts.push(sanitize(status));
					}
					const statusStr = statusParts.join(" ");

					// Agent bar (team/teammate names) — rendered on line 3 instead of line 2
					const agentsStatus = extensionStatuses.get("agents") ?? "";

					// Stats + statuses combined
					const statsAndStatus = statsParts.join(" ") + (statusStr ? ` ${statusStr}` : "");

					// Model + thinking level
					const modelName = model?.id || "no-model";
					let modelStr = modelName;
					if (model?.reasoning) {
						const thinkingLevel =
							(extensionCtx as unknown as Record<string, string>).thinkingLevel ||
							pi.getThinkingLevel() ||
							"off";
						modelStr =
							thinkingLevel === "off"
								? `${modelName} • thinking off`
								: `${modelName} • ${thinkingLevel}`;
					}
					if (isDemo) modelStr = `[DEMO] ${modelStr}`;

					// Session name (set by session-namer extension)
					const sessionName = sessionManager.getSessionName?.() ?? "";

					// Responsive layout
					const useWide = width >= MIN_WIDE_WIDTH;

					if (useWide) {
						// 2-line layout (+ optional 3rd for agents / session name)
						const line1 = alignLeftRight(
							theme.fg("dim", truncateToWidth(pwd, width - visibleWidth(gitBranch) - 2, "...")),
							gitBranch,
							width
						);
						const line2 = alignLeftRight(
							theme.fg("dim", truncateToWidth(statsAndStatus, width - modelStr.length - 2, "...")),
							theme.fg("dim", modelStr),
							width
						);

						// Line 3: agents (left) | session name (right)
						const hasAgents = agentsStatus.length > 0;
						const hasSession = sessionName.length > 0;
						if (!hasAgents && !hasSession) return [line1, line2];

						let leftPart = hasAgents ? agentsStatus : "";
						const rightPart = hasSession ? theme.fg("dim", `─ ${sessionName}`) : "";

						// Truncate agents bar if it would overlap with session name
						if (hasAgents && hasSession) {
							const rightWidth = visibleWidth(rightPart);
							const maxLeft = width - rightWidth - 2;
							leftPart = truncateToWidth(leftPart, maxLeft, "...");
						}

						return [line1, line2, alignLeftRight(leftPart, rightPart, width)];
					}
					// Narrow stacked layout (+ optional row for session name)
					const lines = [
						theme.fg("dim", truncateToWidth(pwd, width, "...")),
						theme.fg("accent", gitBranch || "(no branch)"),
						theme.fg("dim", truncateToWidth(statsAndStatus, width, "...")),
						theme.fg("dim", truncateToWidth(modelStr, width, "...")),
					];
					const hasAgents = agentsStatus.length > 0;
					const hasSession = sessionName.length > 0;
					if (hasAgents || hasSession) {
						let leftPart = hasAgents
							? truncateToWidth(agentsStatus, Math.floor(width * 0.6), "...")
							: "";
						const rightPart = hasSession ? theme.fg("dim", `─ ${sessionName}`) : "";

						// Further truncate agents if both are present and they'd overlap
						if (hasAgents && hasSession) {
							const rightWidth = visibleWidth(rightPart);
							const maxLeft = width - rightWidth - 2;
							leftPart = truncateToWidth(leftPart, maxLeft, "...");
						}
						lines.push(alignLeftRight(leftPart, rightPart, width));
					}
					return lines;
				},

				invalidate(): void {
					// Force git refresh on next render
					invalidateGitCache();
				},

				dispose: (() => {
					disposeHandler = footerData.onBranchChange(() => tui.requestRender());
					return disposeHandler;
				})(),
			};
		});
	});
}
