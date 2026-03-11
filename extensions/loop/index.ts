/**
 * Loop Extension — `/loop` command
 *
 * Runs a prompt or slash command on a recurring interval within the
 * current session. The interval timer starts after the previous iteration
 * completes (post-completion delay), preventing overlapping runs.
 *
 * Supports optional limits and stop conditions:
 *   - `x<N>` — stop after N iterations
 *   - `until "<condition>"` — the model evaluates the condition each
 *     iteration and calls the `loop_stop` tool when it's met
 *
 * Usage:
 *   /loop 5m check the deploy status
 *   /loop 1m x10 run the test suite
 *   /loop 2m until "build is done" check fuse index progress
 *   /loop 1m x100 until "tests pass" run tests
 *   /loop 30s /stats
 *   /loop stop
 *   /loop status
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

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
	/** The base prompt text (without condition suffix). */
	prompt: string;
	/** The full prompt sent each iteration (includes condition instruction). */
	fullPrompt: string;
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
	/** Maximum iterations before auto-stop, or null for unlimited. */
	maxIterations: number | null;
	/** Stop condition for the model to evaluate, or null for none. */
	untilCondition: string | null;
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

/**
 * Parse an iteration count from a string like "x100" or "x5".
 *
 * @param s - Token to parse
 * @returns Positive integer count, or null if not a count token
 */
export function parseMaxIterations(s: string): number | null {
	const match = s.match(/^x(\d+)$/);
	if (!match) return null;
	const value = parseInt(match[1], 10);
	return value > 0 ? value : null;
}

/**
 * Extract an `until "..."` condition from a token array.
 *
 * Looks for the word "until" followed by a quoted string. Supports
 * both single and double quotes. Returns the condition text and the
 * remaining tokens with the `until "..."` portion removed.
 *
 * @param tokens - Array of whitespace-split tokens
 * @returns Object with condition (or null) and remaining tokens
 */
export function extractUntilCondition(tokens: string[]): {
	condition: string | null;
	remaining: string[];
} {
	const untilIdx = tokens.findIndex((t) => t.toLowerCase() === "until");
	if (untilIdx === -1) {
		return { condition: null, remaining: tokens };
	}

	// Everything after "until" is the condition + prompt
	const afterUntil = tokens.slice(untilIdx + 1);
	const beforeUntil = tokens.slice(0, untilIdx);

	if (afterUntil.length === 0) {
		return { condition: null, remaining: tokens };
	}

	// Check if the condition is quoted
	const first = afterUntil[0];
	const quoteChar = first[0] === '"' || first[0] === "'" ? first[0] : null;

	if (quoteChar) {
		// Find the closing quote
		const conditionTokens: string[] = [];
		let closingIdx = -1;

		for (let i = 0; i < afterUntil.length; i++) {
			conditionTokens.push(afterUntil[i]);
			if (i > 0 && afterUntil[i].endsWith(quoteChar)) {
				closingIdx = i;
				break;
			}
			if (i === 0 && afterUntil[i].length > 1 && afterUntil[i].endsWith(quoteChar)) {
				closingIdx = i;
				break;
			}
		}

		if (closingIdx === -1) {
			// No closing quote — treat everything as condition
			const raw = conditionTokens.join(" ");
			const condition = raw.slice(1); // strip opening quote
			return { condition, remaining: beforeUntil };
		}

		const raw = conditionTokens.join(" ");
		const condition = raw.slice(1, -1); // strip both quotes
		const afterCondition = afterUntil.slice(closingIdx + 1);
		return { condition, remaining: [...beforeUntil, ...afterCondition] };
	}

	// No quotes — single word is the condition
	const condition = first;
	const afterCondition = afterUntil.slice(1);
	return { condition, remaining: [...beforeUntil, ...afterCondition] };
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
	| {
			action: "start";
			intervalMs: number;
			intervalLabel: string;
			prompt: string;
			maxIterations: number | null;
			untilCondition: string | null;
	  };

/**
 * Parse the argument string passed to `/loop`.
 *
 * Syntax: /loop <interval> [x<N>] [until "<condition>"] <prompt...>
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

	const tokens = trimmed.split(/\s+/);

	// First token must be the interval
	const intervalStr = tokens[0];
	const ms = parseInterval(intervalStr);
	if (ms === null) {
		return {
			action: "error",
			message: `Invalid interval "${intervalStr}". Use format: 30s, 5m, 1h`,
		};
	}

	let rest = tokens.slice(1);
	if (rest.length === 0) {
		return { action: "error", message: "Missing prompt. Usage: /loop 5m <prompt>" };
	}

	// Check for x<N> max iterations (can appear anywhere before the prompt)
	let maxIterations: number | null = null;
	const maxIdx = rest.findIndex((t) => parseMaxIterations(t) !== null);
	if (maxIdx !== -1) {
		maxIterations = parseMaxIterations(rest[maxIdx]);
		rest = [...rest.slice(0, maxIdx), ...rest.slice(maxIdx + 1)];
	}

	// Check for until "condition"
	const { condition, remaining } = extractUntilCondition(rest);

	const prompt = remaining.join(" ").trim();
	if (!prompt) {
		return { action: "error", message: "Missing prompt. Usage: /loop 5m <prompt>" };
	}

	return {
		action: "start",
		intervalMs: ms,
		intervalLabel: intervalStr,
		prompt,
		maxIterations,
		untilCondition: condition,
	};
}

// ── Loop Lifecycle ───────────────────────────────────────────────────────────

/**
 * Build a display label summarizing the loop configuration.
 *
 * @param loop - Active loop state
 * @returns Human-readable summary like "every 5m x10 until 'build done'"
 */
function buildLabel(loop: LoopState): string {
	let label = `every ${loop.intervalLabel}`;
	if (loop.maxIterations !== null) {
		label += ` x${loop.maxIterations}`;
	}
	if (loop.untilCondition) {
		label += ` until "${loop.untilCondition}"`;
	}
	return label;
}

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

	const iterInfo =
		activeLoop.maxIterations !== null
			? ` ${activeLoop.iterationCount}/${activeLoop.maxIterations}`
			: ` #${activeLoop.iterationCount}`;

	if (activeLoop.awaitingCompletion) {
		const iter = activeLoop.iterationCount + 1;
		ctx.ui.setStatus(
			STATUS_SLOT,
			`${FG_CYAN}🔄 running: "${promptPreview}" (#${iter}${activeLoop.maxIterations ? `/${activeLoop.maxIterations}` : ""})${RESET}`
		);
		return;
	}

	const remaining = activeLoop.nextRunAt - Date.now();
	const countdown = formatCountdown(remaining);
	ctx.ui.setStatus(
		STATUS_SLOT,
		`${FG_CYAN}🔄 ${activeLoop.intervalLabel}${iterInfo}: ${FG_DIM}"${promptPreview}"${RESET}${FG_CYAN} (next in ${countdown})${RESET}`
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

		const iterLabel = activeLoop.maxIterations
			? `#${activeLoop.iterationCount + 1}/${activeLoop.maxIterations}`
			: `#${activeLoop.iterationCount + 1}`;
		ctx.ui.notify(`Loop iteration ${iterLabel}: ${activeLoop.prompt}`, "info");

		pi.sendUserMessage(activeLoop.fullPrompt, { deliverAs: "followUp" });
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

/** TypeBox schema for the loop_stop tool parameters. */
const LoopStopParams = Type.Object({
	reason: Type.String({ description: "Why the stop condition was met" }),
});

/**
 * Loop extension factory.
 *
 * Registers the `/loop` command, `loop_stop` tool, `agent_end` handler
 * for iteration scheduling, and cleanup handlers for session lifecycle.
 *
 * @param pi - Extension API
 */
export default function loopExtension(pi: ExtensionAPI): void {
	// ── loop_stop tool — lets the model stop the loop when a condition is met

	pi.registerTool({
		name: "loop_stop",
		label: "Stop Loop",
		description:
			"Stop the active /loop because its stop condition has been met. " +
			"Only call this tool when a /loop is running with an `until` condition " +
			"and you have determined the condition is satisfied.",
		parameters: LoopStopParams,
		async execute(_toolCallId, params: Static<typeof LoopStopParams>, _signal, _onUpdate, ctx) {
			if (!activeLoop) {
				return {
					content: [{ type: "text" as const, text: "No active loop to stop." }],
					details: undefined,
				};
			}
			const reason = `Loop stopped: condition met — ${params.reason}`;
			stopLoop(ctx, reason);
			return {
				content: [{ type: "text" as const, text: `Loop stopped. Reason: ${params.reason}` }],
				details: undefined,
			};
		},
	});

	// ── /loop command ────────────────────────────────────────────────────

	pi.registerCommand("loop", {
		description:
			"Run a prompt on a recurring interval. " +
			'Syntax: /loop <interval> [x<N>] [until "<condition>"] <prompt>',
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
						ctx.ui.notify(
							'No active loop. Usage: /loop 5m <prompt>\n  Options: x<N> (max iterations), until "<condition>" (auto-stop)',
							"info"
						);
						return;
					}
					{
						const remaining = activeLoop.nextRunAt - Date.now();
						const state = activeLoop.awaitingCompletion
							? `running iteration #${activeLoop.iterationCount + 1}`
							: `next in ${formatCountdown(remaining)}`;
						let info = `Loop: ${buildLabel(activeLoop)} → "${activeLoop.prompt}" | ${state} | ${activeLoop.iterationCount} completed`;
						if (activeLoop.maxIterations) {
							info += ` of ${activeLoop.maxIterations}`;
						}
						ctx.ui.notify(info, "info");
					}
					return;

				case "start": {
					// Replace existing loop if active
					if (activeLoop) {
						clearTimers();
						ctx.ui.notify(
							`Replacing active loop (was: ${buildLabel(activeLoop)} → "${activeLoop.prompt}")`,
							"info"
						);
					}

					// Build the full prompt with condition instruction
					let fullPrompt = parsed.prompt;
					if (parsed.untilCondition) {
						fullPrompt +=
							`\n\n---\nLoop stop condition: "${parsed.untilCondition}"\n` +
							`After completing the task above, evaluate whether this condition is now met. ` +
							`If it IS met, call the loop_stop tool with the reason. ` +
							`If it is NOT yet met, do nothing — the loop will continue automatically.`;
					}

					activeLoop = {
						prompt: parsed.prompt,
						fullPrompt,
						intervalMs: parsed.intervalMs,
						intervalLabel: parsed.intervalLabel,
						timer: null,
						countdownTimer: null,
						nextRunAt: 0,
						awaitingCompletion: false,
						iterationCount: 0,
						maxIterations: parsed.maxIterations,
						untilCondition: parsed.untilCondition,
					};

					ctx.ui.notify(`Loop started: ${buildLabel(activeLoop)} → "${parsed.prompt}"`, "info");

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

		// Check max iterations limit
		if (
			activeLoop.maxIterations !== null &&
			activeLoop.iterationCount >= activeLoop.maxIterations
		) {
			stopLoop(
				ctx,
				`Loop complete: ${activeLoop.iterationCount}/${activeLoop.maxIterations} iterations`
			);
			return;
		}

		const iterLabel = activeLoop.maxIterations
			? `${activeLoop.iterationCount}/${activeLoop.maxIterations}`
			: `${activeLoop.iterationCount}`;
		ctx.ui.notify(`Loop iteration ${iterLabel} complete`, "info");

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
