/**
 * Loop Extension — `/loop` command
 *
 * Runs a prompt or slash command on a recurring interval within the
 * current session. The interval timer starts after the previous iteration
 * completes (post-completion delay), preventing overlapping runs.
 *
 * Usage:
 *   /loop 5m check the deploy status
 *   /loop 30s /stats
 *   /loop stop
 *   /loop status
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────────────

/** Status bar slot name for the loop indicator. */
const STATUS_SLOT = "loop";

/** ANSI escape codes for status bar styling. */
const FG_CYAN = "\x1b[36m";
const FG_DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// ── Types ────────────────────────────────────────────────────────────────────

/** Mutable state for an active loop. */
interface LoopState {
	/** The prompt text sent each iteration. */
	prompt: string;
	/** Interval in milliseconds between iterations. */
	intervalMs: number;
	/** Original interval string (e.g. "5m") for display. */
	intervalLabel: string;
	/** Handle for the pending setTimeout (next iteration trigger). */
	timer: ReturnType<typeof setTimeout> | null;
	/** Handle for the 1-second countdown display interval. */
	countdownTimer: ReturnType<typeof setInterval> | null;
	/** Timestamp (Date.now()) when the next iteration will fire. */
	nextRunAt: number;
	/** True while the agent is processing a loop-triggered prompt. */
	awaitingCompletion: boolean;
	/** Number of completed iterations. */
	iterationCount: number;
}

// ── Module State ─────────────────────────────────────────────────────────────

/** The single active loop, or null when no loop is running. */
let activeLoop: LoopState | null = null;

// ── Interval Parsing ─────────────────────────────────────────────────────────

/** Multipliers from unit suffix to milliseconds. */
const UNIT_MS: Readonly<Record<string, number>> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
};

/**
 * Parse a human-readable interval string into milliseconds.
 *
 * Accepts formats like `30s`, `5m`, `1h`. Rejects bare numbers,
 * unknown units, or non-positive values.
 *
 * @param s - Interval string
 * @returns Milliseconds, or null if the string is invalid
 */
export function parseInterval(s: string): number | null {
	const match = s.match(/^(\d+)(s|m|h)$/);
	if (!match) return null;
	const value = parseInt(match[1], 10);
	if (value <= 0) return null;
	const multiplier = UNIT_MS[match[2]];
	if (!multiplier) return null;
	return value * multiplier;
}

// ── Countdown Formatting ─────────────────────────────────────────────────────

/**
 * Format a millisecond duration into a compact human-readable countdown.
 *
 * @param ms - Remaining milliseconds
 * @returns Formatted string like "now", "30s", "2m15s", "1h5m"
 */
export function formatCountdown(ms: number): string {
	if (ms <= 0) return "now";
	const totalSeconds = Math.ceil(ms / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

// ── Argument Parsing ─────────────────────────────────────────────────────────

/** Parsed result from `/loop` argument text. */
export type LoopArgs =
	| { action: "status" }
	| { action: "stop" }
	| { action: "start"; intervalMs: number; intervalLabel: string; prompt: string };

/**
 * Parse the argument string passed to `/loop`.
 *
 * @param args - Raw argument text (everything after `/loop `)
 * @returns Parsed action with relevant parameters
 */
export function parseLoopArgs(args: string): LoopArgs | { action: "error"; message: string } {
	const trimmed = args.trim();

	if (!trimmed) {
		return { action: "status" };
	}

	if (trimmed === "stop" || trimmed === "off") {
		return { action: "stop" };
	}

	if (trimmed === "status") {
		return { action: "status" };
	}

	// Expect: <interval> <prompt...>
	const spaceIdx = trimmed.indexOf(" ");
	if (spaceIdx === -1) {
		// Could be just an interval with no prompt
		const ms = parseInterval(trimmed);
		if (ms !== null) {
			return { action: "error", message: "Missing prompt. Usage: /loop 5m <prompt>" };
		}
		return { action: "error", message: `Invalid interval "${trimmed}". Use format: 30s, 5m, 1h` };
	}

	const intervalStr = trimmed.slice(0, spaceIdx);
	const prompt = trimmed.slice(spaceIdx + 1).trim();

	const ms = parseInterval(intervalStr);
	if (ms === null) {
		return {
			action: "error",
			message: `Invalid interval "${intervalStr}". Use format: 30s, 5m, 1h`,
		};
	}

	if (!prompt) {
		return { action: "error", message: "Missing prompt. Usage: /loop 5m <prompt>" };
	}

	return { action: "start", intervalMs: ms, intervalLabel: intervalStr, prompt };
}

// ── Loop Lifecycle ───────────────────────────────────────────────────────────

/**
 * Update the status bar with the current loop state.
 *
 * Shows a countdown during wait periods and a "running" indicator
 * while the agent processes a loop prompt.
 *
 * @param ctx - Extension context for UI access
 */
function updateStatus(ctx: ExtensionContext): void {
	if (!activeLoop) {
		ctx.ui.setStatus(STATUS_SLOT, undefined);
		return;
	}

	const promptPreview =
		activeLoop.prompt.length > 30 ? `${activeLoop.prompt.slice(0, 27)}...` : activeLoop.prompt;

	if (activeLoop.awaitingCompletion) {
		const iter = activeLoop.iterationCount + 1;
		ctx.ui.setStatus(STATUS_SLOT, `${FG_CYAN}🔄 running: "${promptPreview}" (#${iter})${RESET}`);
		return;
	}

	const remaining = activeLoop.nextRunAt - Date.now();
	const countdown = formatCountdown(remaining);
	ctx.ui.setStatus(
		STATUS_SLOT,
		`${FG_CYAN}🔄 ${activeLoop.intervalLabel}: ${FG_DIM}"${promptPreview}"${RESET}${FG_CYAN} (next in ${countdown})${RESET}`
	);
}

/**
 * Start the 1-second countdown timer that refreshes the status bar.
 *
 * @param ctx - Extension context for UI access
 */
function startCountdown(ctx: ExtensionContext): void {
	if (activeLoop?.countdownTimer) {
		clearInterval(activeLoop.countdownTimer);
	}
	if (!activeLoop) return;

	activeLoop.countdownTimer = setInterval(() => {
		updateStatus(ctx);
	}, 1_000);
}

/**
 * Clear all timers associated with the active loop.
 *
 * Does not null out `activeLoop` — caller is responsible for that.
 */
function clearTimers(): void {
	if (!activeLoop) return;
	if (activeLoop.timer) {
		clearTimeout(activeLoop.timer);
		activeLoop.timer = null;
	}
	if (activeLoop.countdownTimer) {
		clearInterval(activeLoop.countdownTimer);
		activeLoop.countdownTimer = null;
	}
}

/**
 * Schedule the next loop iteration after the configured interval.
 *
 * Sets a timeout that fires `sendUserMessage` with the loop prompt,
 * then waits for `agent_end` to schedule the subsequent iteration.
 *
 * @param pi - Extension API for sending messages
 * @param ctx - Extension context for UI access
 */
function scheduleNext(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!activeLoop) return;

	activeLoop.nextRunAt = Date.now() + activeLoop.intervalMs;
	updateStatus(ctx);
	startCountdown(ctx);

	activeLoop.timer = setTimeout(() => {
		if (!activeLoop) return;

		activeLoop.awaitingCompletion = true;

		// Stop countdown while running
		if (activeLoop.countdownTimer) {
			clearInterval(activeLoop.countdownTimer);
			activeLoop.countdownTimer = null;
		}

		updateStatus(ctx);

		ctx.ui.notify(`Loop iteration #${activeLoop.iterationCount + 1}: ${activeLoop.prompt}`, "info");

		pi.sendUserMessage(activeLoop.prompt, { deliverAs: "followUp" });
	}, activeLoop.intervalMs);
}

/**
 * Stop the active loop, clear all timers, and update the UI.
 *
 * Safe to call when no loop is active (no-op).
 *
 * @param ctx - Extension context for UI access
 * @param reason - Human-readable stop reason for the notification
 */
function stopLoop(ctx: ExtensionContext, reason: string = "Loop stopped"): void {
	if (!activeLoop) return;
	clearTimers();
	activeLoop = null;
	ctx.ui.setStatus(STATUS_SLOT, undefined);
	ctx.ui.notify(reason, "info");
}

// ── Extension Entry Point ────────────────────────────────────────────────────

/**
 * Loop extension factory.
 *
 * Registers the `/loop` command, `agent_end` handler for iteration
 * scheduling, and cleanup handlers for session lifecycle events.
 *
 * @param pi - Extension API
 */
export default function loopExtension(pi: ExtensionAPI): void {
	// ── /loop command ────────────────────────────────────────────────────

	pi.registerCommand("loop", {
		description: "Run a prompt on a recurring interval (e.g. /loop 5m check deploy)",
		handler: async (args, ctx) => {
			const parsed = parseLoopArgs(args);

			switch (parsed.action) {
				case "error":
					ctx.ui.notify(parsed.message, "error");
					return;

				case "stop":
					if (!activeLoop) {
						ctx.ui.notify("No active loop", "info");
						return;
					}
					stopLoop(ctx);
					return;

				case "status":
					if (!activeLoop) {
						ctx.ui.notify("No active loop. Usage: /loop 5m <prompt>", "info");
						return;
					}
					{
						const remaining = activeLoop.nextRunAt - Date.now();
						const state = activeLoop.awaitingCompletion
							? `running iteration #${activeLoop.iterationCount + 1}`
							: `next in ${formatCountdown(remaining)}`;
						ctx.ui.notify(
							`Loop: every ${activeLoop.intervalLabel} → "${activeLoop.prompt}" | ${state} | ${activeLoop.iterationCount} completed`,
							"info"
						);
					}
					return;

				case "start": {
					// Replace existing loop if active
					if (activeLoop) {
						clearTimers();
						ctx.ui.notify(
							`Replacing active loop (was: ${activeLoop.intervalLabel} → "${activeLoop.prompt}")`,
							"info"
						);
					}

					activeLoop = {
						prompt: parsed.prompt,
						intervalMs: parsed.intervalMs,
						intervalLabel: parsed.intervalLabel,
						timer: null,
						countdownTimer: null,
						nextRunAt: 0,
						awaitingCompletion: false,
						iterationCount: 0,
					};

					ctx.ui.notify(`Loop started: every ${parsed.intervalLabel} → "${parsed.prompt}"`, "info");

					scheduleNext(pi, ctx);
					return;
				}
			}
		},
		getArgumentCompletions(prefix: string) {
			const options = ["stop", "off", "status", "5s", "10s", "30s", "1m", "5m", "10m", "30m", "1h"];
			return options.filter((o) => o.startsWith(prefix)).map((o) => ({ label: o, value: o }));
		},
	});

	// ── agent_end: schedule next iteration after completion ───────────

	pi.on("agent_end", async (_event, ctx) => {
		if (!activeLoop?.awaitingCompletion) return;

		activeLoop.awaitingCompletion = false;
		activeLoop.iterationCount++;

		ctx.ui.notify(`Loop iteration #${activeLoop.iterationCount} complete`, "info");

		scheduleNext(pi, ctx);
	});

	// ── Lifecycle cleanup ────────────────────────────────────────────────

	pi.on("session_shutdown", async (_event, ctx) => {
		stopLoop(ctx, "Loop stopped (session shutdown)");
	});

	pi.on("session_switch", async (_event, ctx) => {
		stopLoop(ctx, "Loop stopped (session switch)");
	});
}
