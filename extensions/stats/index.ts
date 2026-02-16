/**
 * Stats Extension
 *
 * Records session metadata to ~/.tallow/stats.jsonl on shutdown and
 * provides a `/stats` command for viewing usage statistics.
 *
 * Usage:
 *   /stats              — current session stats
 *   /stats today        — today's aggregate
 *   /stats week         — last 7 days
 *   /stats month        — last 30 days
 *   /stats all          — all time
 *   /stats range YYYY-MM-DD to YYYY-MM-DD
 *
 * Flags:
 *   --tools     — show detailed tool breakdown
 *   --json      — output raw JSON
 *   --model X   — filter by model name
 */

import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	aggregate,
	filterSessions,
	parseCustomRange,
	resolvePreset,
	type TimeRangePreset,
} from "./aggregator.js";
import { formatAggregated, formatCurrentSession, formatJson } from "./formatters.js";
import { appendStats, readAllStats, type SessionStats, type ToolCounts } from "./stats-log.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Serializable details for the custom message renderer. */
interface StatsDetails {
	readonly mode: "current" | "aggregate";
	readonly currentSession?: SessionStats;
	readonly aggregated?: ReturnType<typeof aggregate>;
	readonly showTools: boolean;
	readonly json: boolean;
}

// ── Session Data Extraction ──────────────────────────────────────────────────

/**
 * Extracts a SessionStats summary from the current session's entries.
 * Walks the session branch to count tokens, costs, messages, and tool usage.
 *
 * @param ctx - Extension context with session manager
 * @param modelId - Current model ID
 * @returns Session stats summary
 */
function extractCurrentSessionStats(ctx: ExtensionContext, modelId: string): SessionStats {
	const sm = ctx.sessionManager;
	const entries = sm.getEntries();

	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let messageCount = 0;
	const toolCounts: Record<string, number> = {};

	let firstTimestamp: string | null = null;
	let lastTimestamp: string | null = null;

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const msg = entry.message;

		if (msg.role === "user") {
			messageCount++;
			if (!firstTimestamp) firstTimestamp = entry.timestamp;
			lastTimestamp = entry.timestamp;
		}

		if (msg.role === "assistant") {
			const assistant = msg as AssistantMessage;
			messageCount++;
			lastTimestamp = entry.timestamp;

			totalInput += assistant.usage.input;
			totalOutput += assistant.usage.output;
			totalCacheRead += assistant.usage.cacheRead;
			totalCacheWrite += assistant.usage.cacheWrite;
			totalCost += assistant.usage.cost.total;

			// Count tool calls from assistant content
			for (const block of assistant.content) {
				if ((block as ToolCall).type === "toolCall") {
					const tc = block as ToolCall;
					toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
				}
			}
		}
	}

	// Sort tool counts by frequency
	const sortedToolCounts: ToolCounts = {};
	for (const [name, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
		sortedToolCounts[name] = count;
	}

	const now = new Date().toISOString();
	const startTime = firstTimestamp ?? now;
	const endTime = lastTimestamp ?? now;
	const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();

	return {
		sessionId: sm.getSessionId(),
		startTime,
		endTime,
		durationMs: Math.max(0, durationMs),
		model: modelId,
		cwd: ctx.cwd,
		totalInput,
		totalOutput,
		totalCacheRead,
		totalCacheWrite,
		totalCost,
		toolCounts: sortedToolCounts,
		messageCount,
	};
}

// ── Argument Parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
	preset?: TimeRangePreset;
	rangeStart?: string;
	rangeEnd?: string;
	modelFilter?: string;
	showTools: boolean;
	json: boolean;
}

/**
 * Parses /stats command arguments into structured options.
 *
 * @param args - Raw argument string from the command
 * @returns Parsed arguments
 */
function parseArgs(args: string): ParsedArgs {
	const result: ParsedArgs = { showTools: false, json: false };
	const tokens = args.trim().split(/\s+/).filter(Boolean);

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];

		if (token === "--tools") {
			result.showTools = true;
			i++;
		} else if (token === "--json") {
			result.json = true;
			i++;
		} else if (token === "--model" && i + 1 < tokens.length) {
			result.modelFilter = tokens[i + 1];
			i += 2;
		} else if (token === "range" && i + 3 < tokens.length && tokens[i + 2] === "to") {
			result.rangeStart = tokens[i + 1];
			result.rangeEnd = tokens[i + 3];
			i += 4;
		} else if (["today", "week", "month", "all"].includes(token)) {
			result.preset = token as TimeRangePreset;
			i++;
		} else {
			// Unknown token — skip
			i++;
		}
	}

	return result;
}

// ── Extension Entry Point ────────────────────────────────────────────────────

/**
 * Stats extension factory.
 * Records session metadata on shutdown and provides the /stats command.
 *
 * @param pi - Extension API
 */
export default function statsExtension(pi: ExtensionAPI): void {
	let extensionCtx: ExtensionContext | null = null;

	pi.on("session_start", async (_event, ctx) => {
		extensionCtx = ctx;
	});

	// Persist stats on shutdown
	pi.on("session_shutdown", async () => {
		if (!extensionCtx) return;

		const modelId = extensionCtx.model?.id ?? "unknown";
		const stats = extractCurrentSessionStats(extensionCtx, modelId);

		// Only write if there was actual usage (at least one message exchange)
		if (stats.messageCount >= 2) {
			try {
				appendStats(stats);
			} catch {
				// Silently fail — stats are best-effort, don't block shutdown
			}
		}
	});

	// Register custom message renderer
	pi.registerMessageRenderer<StatsDetails>("stats", (message, _options, _theme) => {
		const details = message.details;
		if (!details) {
			return {
				render(): string[] {
					return ["No stats data."];
				},
				invalidate() {},
			};
		}

		return {
			/**
			 * Renders stats display.
			 * @param _width - Available terminal width
			 * @returns Array of rendered lines
			 */
			render(_width: number): string[] {
				if (details.json) {
					const data = details.mode === "current" ? details.currentSession : details.aggregated;
					return data ? formatJson(data).split("\n") : ["{}"];
				}

				if (details.mode === "current" && details.currentSession) {
					return formatCurrentSession(details.currentSession);
				}

				if (details.mode === "aggregate" && details.aggregated) {
					return formatAggregated(details.aggregated, details.showTools);
				}

				return ["No stats data."];
			},
			invalidate() {},
		};
	});

	// Register /stats command
	pi.registerCommand("stats", {
		description: "Show usage statistics (today, week, month, all, range)",

		getArgumentCompletions(prefix: string) {
			const options = ["today", "week", "month", "all", "range", "--tools", "--json", "--model"];
			return options.filter((o) => o.startsWith(prefix)).map((o) => ({ label: o, value: o }));
		},

		handler: async (args, ctx) => {
			const parsed = parseArgs(args);

			// No arguments → current session stats
			if (!parsed.preset && !parsed.rangeStart) {
				const modelId = ctx.model?.id ?? "unknown";
				const currentSession = extractCurrentSessionStats(ctx, modelId);

				const details: StatsDetails = {
					mode: "current",
					currentSession,
					showTools: parsed.showTools,
					json: parsed.json,
				};

				pi.sendMessage({
					customType: "stats",
					content: "Session statistics",
					display: true,
					details,
				});
				return;
			}

			// Aggregate mode
			const allSessions = readAllStats();
			let range: ReturnType<typeof resolvePreset> | null = null;

			if (parsed.rangeStart && parsed.rangeEnd) {
				range = parseCustomRange(parsed.rangeStart, parsed.rangeEnd);
				if (!range) {
					ctx.ui.notify(`Invalid date range: ${parsed.rangeStart} to ${parsed.rangeEnd}`, "error");
					return;
				}
			} else if (parsed.preset) {
				range = resolvePreset(parsed.preset);
			} else {
				range = resolvePreset("all");
			}

			const filtered = filterSessions(allSessions, range, parsed.modelFilter);
			const aggregated = aggregate(filtered, allSessions, range, parsed.preset);

			const details: StatsDetails = {
				mode: "aggregate",
				aggregated,
				showTools: parsed.showTools || !parsed.preset || parsed.preset !== "today",
				json: parsed.json,
			};

			pi.sendMessage({
				customType: "stats",
				content: "Usage statistics",
				display: true,
				details,
			});
		},
	});
}
