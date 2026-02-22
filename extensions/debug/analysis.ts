/**
 * Log analysis utilities for the debug extension.
 *
 * Transforms raw JSONL log entries into human-readable summaries:
 * tool timing histograms, error grouping, and turn efficiency metrics.
 * All output is markdown-formatted for model consumption.
 */

import type { LogEntry } from "./logger.js";

// ── Tool Timing Analysis ─────────────────────────────────────

/** Aggregated timing statistics for a single tool. */
interface ToolTimingStats {
	name: string;
	callCount: number;
	totalMs: number;
	minMs: number;
	maxMs: number;
	avgMs: number;
	p50Ms: number;
	p95Ms: number;
	totalPayloadBytes: number;
	avgPayloadBytes: number;
	summarizedCount: number;
}

/**
 * Computes a specific percentile from a sorted array of numbers.
 *
 * @param sorted - Pre-sorted numeric array (ascending)
 * @param p - Percentile to compute (0–100)
 * @returns The value at the given percentile
 */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

/**
 * Format bytes with compact units for table output.
 *
 * @param count - Byte count
 * @returns Human-readable byte string
 */
function formatBytes(count: number): string {
	if (count < 1024) return `${count}B`;
	if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)}KB`;
	return `${(count / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Computes per-tool timing statistics from tool result log entries.
 *
 * Only considers entries with a valid `durationMs` field. Tools with
 * no timing data are excluded from results.
 *
 * @param entries - Log entries (pre-filtered to category "tool" recommended)
 * @returns Array of timing stats sorted by total time descending
 */
export function summarizeToolTimings(entries: LogEntry[]): ToolTimingStats[] {
	const timingsByTool = new Map<
		string,
		{ durations: number[]; payloadBytes: number; summarizedCount: number }
	>();

	for (const entry of entries) {
		if (entry.cat !== "tool" || entry.evt !== "result") continue;
		const { durationMs, name, payloadBytes, summarizedByRetention } = entry.data as {
			durationMs?: number;
			name?: string;
			payloadBytes?: number;
			summarizedByRetention?: boolean;
		};
		if (!name || durationMs == null) continue;

		const existing = timingsByTool.get(name);
		if (existing) {
			existing.durations.push(durationMs);
			existing.payloadBytes += typeof payloadBytes === "number" ? Math.max(0, payloadBytes) : 0;
			existing.summarizedCount += summarizedByRetention ? 1 : 0;
		} else {
			timingsByTool.set(name, {
				durations: [durationMs],
				payloadBytes: typeof payloadBytes === "number" ? Math.max(0, payloadBytes) : 0,
				summarizedCount: summarizedByRetention ? 1 : 0,
			});
		}
	}

	const stats: ToolTimingStats[] = [];
	for (const [name, values] of timingsByTool) {
		values.durations.sort((a, b) => a - b);
		const totalMs = values.durations.reduce((sum, d) => sum + d, 0);

		stats.push({
			name,
			callCount: values.durations.length,
			totalMs,
			minMs: values.durations[0],
			maxMs: values.durations[values.durations.length - 1],
			avgMs: Math.round(totalMs / values.durations.length),
			p50Ms: percentile(values.durations, 50),
			p95Ms: percentile(values.durations, 95),
			totalPayloadBytes: values.payloadBytes,
			avgPayloadBytes:
				values.durations.length > 0 ? Math.round(values.payloadBytes / values.durations.length) : 0,
			summarizedCount: values.summarizedCount,
		});
	}

	// Sort by total time descending — slowest tools first
	stats.sort((a, b) => b.totalMs - a.totalMs);
	return stats;
}

/**
 * Formats tool timing stats as a markdown table.
 *
 * @param stats - Tool timing statistics from summarizeToolTimings()
 * @returns Markdown table string, or a "no data" message
 */
export function formatToolTimings(stats: ToolTimingStats[]): string {
	if (stats.length === 0) return "No tool timing data found.";

	const lines = [
		"| Tool | Calls | Total (ms) | Avg (ms) | p50 (ms) | p95 (ms) | Max (ms) | Avg payload | Summarized |",
		"|------|-------|------------|----------|----------|----------|----------|-------------|------------|",
	];

	for (const s of stats) {
		lines.push(
			`| ${s.name} | ${s.callCount} | ${s.totalMs} | ${s.avgMs} | ${s.p50Ms} | ${s.p95Ms} | ${s.maxMs} | ${formatBytes(s.avgPayloadBytes)} | ${s.summarizedCount} |`
		);
	}

	return lines.join("\n");
}

// ── Error Grouping ───────────────────────────────────────────

/** A group of similar errors deduplicated by message. */
interface ErrorGroup {
	message: string;
	count: number;
	firstSeen: string;
	lastSeen: string;
	eventTypes: string[];
	/** First stack trace in the group (if available). */
	stack?: string;
}

/**
 * Groups error log entries by message similarity.
 *
 * Errors are deduplicated by their `message` field. Each group tracks
 * occurrence count, time range, and the distinct event types that produced it.
 *
 * @param entries - Log entries (pre-filtered to category "error" recommended)
 * @returns Array of error groups sorted by count descending
 */
export function groupErrors(entries: LogEntry[]): ErrorGroup[] {
	const groups = new Map<string, ErrorGroup>();

	for (const entry of entries) {
		if (entry.cat !== "error") continue;
		const { message, stack } = entry.data as { message?: string; stack?: string };
		const msg = message ?? "Unknown error";

		const existing = groups.get(msg);
		if (existing) {
			existing.count++;
			existing.lastSeen = entry.ts;
			if (!existing.eventTypes.includes(entry.evt)) {
				existing.eventTypes.push(entry.evt);
			}
		} else {
			groups.set(msg, {
				message: msg,
				count: 1,
				firstSeen: entry.ts,
				lastSeen: entry.ts,
				eventTypes: [entry.evt],
				stack: stack?.split("\n").slice(0, 5).join("\n"),
			});
		}
	}

	return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * Formats error groups as a markdown summary.
 *
 * @param groups - Error groups from groupErrors()
 * @returns Markdown string with error details
 */
export function formatErrors(groups: ErrorGroup[]): string {
	if (groups.length === 0) return "No errors found in the log.";

	const lines: string[] = [`**${groups.length} distinct error(s):**\n`];

	for (const g of groups) {
		lines.push(`- **${g.message}** (×${g.count})`);
		lines.push(`  - Events: ${g.eventTypes.join(", ")}`);
		lines.push(`  - First: ${g.firstSeen}, Last: ${g.lastSeen}`);
		if (g.stack) {
			lines.push(`  - Stack:\n    \`\`\`\n    ${g.stack}\n    \`\`\``);
		}
	}

	return lines.join("\n");
}

// ── Turn Efficiency Metrics ──────────────────────────────────

/** Session-level turn efficiency metrics. */
interface TurnMetrics {
	totalTurns: number;
	totalToolCalls: number;
	avgToolsPerTurn: number;
	avgTurnDurationMs: number;
	/** Turns with zero tool calls. */
	emptyTurns: number;
}

/**
 * Calculates turn efficiency metrics from log entries.
 *
 * Correlates turn_start/turn_end events with tool calls to compute
 * per-turn tool usage and timing.
 *
 * @param entries - All log entries (unfiltered — needs both turn and tool events)
 * @returns Aggregated turn metrics
 */
export function calculateTurnMetrics(entries: LogEntry[]): TurnMetrics {
	// Entries arrive newest-first from queryLog; reverse to chronological
	const chronological = [...entries].reverse();

	let totalTurns = 0;
	let totalToolCalls = 0;
	let totalTurnDurationMs = 0;
	let emptyTurns = 0;

	let currentTurnStart: string | null = null;
	let currentTurnToolCount = 0;

	for (const entry of chronological) {
		if (entry.cat === "turn" && entry.evt === "start") {
			currentTurnStart = entry.ts;
			currentTurnToolCount = 0;
			totalTurns++;
		} else if (entry.cat === "turn" && entry.evt === "end") {
			if (currentTurnStart) {
				const durationMs = new Date(entry.ts).getTime() - new Date(currentTurnStart).getTime();
				totalTurnDurationMs += durationMs;
			}
			if (currentTurnToolCount === 0) emptyTurns++;
			currentTurnStart = null;
		} else if (entry.cat === "tool" && entry.evt === "call") {
			totalToolCalls++;
			currentTurnToolCount++;
		}
	}

	return {
		totalTurns,
		totalToolCalls,
		avgToolsPerTurn: totalTurns > 0 ? Math.round((totalToolCalls / totalTurns) * 10) / 10 : 0,
		avgTurnDurationMs: totalTurns > 0 ? Math.round(totalTurnDurationMs / totalTurns) : 0,
		emptyTurns,
	};
}

/**
 * Formats turn metrics as a markdown summary.
 *
 * @param metrics - Turn metrics from calculateTurnMetrics()
 * @returns Markdown string with metrics
 */
export function formatTurnMetrics(metrics: TurnMetrics): string {
	if (metrics.totalTurns === 0) return "No turn data found.";

	return [
		`**Turn Efficiency:**`,
		`- Total turns: ${metrics.totalTurns}`,
		`- Total tool calls: ${metrics.totalToolCalls}`,
		`- Avg tools/turn: ${metrics.avgToolsPerTurn}`,
		`- Avg turn duration: ${metrics.avgTurnDurationMs}ms`,
		`- Empty turns (no tools): ${metrics.emptyTurns}`,
	].join("\n");
}

// ── Generic Entry Formatter ──────────────────────────────────

/**
 * Formats raw log entries as a human-readable markdown list.
 *
 * Each entry is rendered as a single line with timestamp, category/event,
 * and a compact representation of key data fields.
 *
 * @param entries - Log entries to format
 * @returns Markdown-formatted string
 */
export function formatEntries(entries: LogEntry[]): string {
	if (entries.length === 0) return "No matching log entries found.";

	const lines: string[] = [`**${entries.length} log entries:**\n`];

	for (const entry of entries) {
		const data = entry.data;
		// Pick interesting fields for compact display
		const highlights: string[] = [];
		if (data.name) highlights.push(`name=${data.name}`);
		if (data.durationMs != null) highlights.push(`${data.durationMs}ms`);
		if (typeof data.payloadBytes === "number") {
			highlights.push(`payload=${formatBytes(Math.max(0, data.payloadBytes))}`);
		}
		if (data.ok !== undefined) highlights.push(data.ok ? "ok" : "FAILED");
		if (data.summarizedByRetention === true) highlights.push("summarized");
		if (data.message) highlights.push(`"${String(data.message).slice(0, 80)}"`);
		if (data.agentId) highlights.push(`agent=${data.agentId}`);
		if (data.exitCode !== undefined) highlights.push(`exit=${data.exitCode}`);

		const detail = highlights.length > 0 ? ` — ${highlights.join(", ")}` : "";
		lines.push(`- \`[${entry.ts}]\` **${entry.cat}/${entry.evt}**${detail}`);
	}

	return lines.join("\n");
}
