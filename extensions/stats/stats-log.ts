/**
 * Stats Log Persistence
 *
 * Append-only JSONL store for session summaries.
 * Each line is a JSON object representing one completed session's stats.
 * File location: ~/.tallow/stats.jsonl
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Schema ───────────────────────────────────────────────────────────────────

/** Tool usage counts keyed by tool name. */
export type ToolCounts = Record<string, number>;

/** A single session's statistics summary. */
export interface SessionStats {
	/** Unique session identifier */
	readonly sessionId: string;
	/** ISO timestamp of first user message */
	readonly startTime: string;
	/** ISO timestamp of last assistant message */
	readonly endTime: string;
	/** Duration in milliseconds */
	readonly durationMs: number;
	/** Model ID used (primary model for the session) */
	readonly model: string;
	/** Working directory */
	readonly cwd: string;
	/** Total input tokens */
	readonly totalInput: number;
	/** Total output tokens */
	readonly totalOutput: number;
	/** Total cache read tokens */
	readonly totalCacheRead: number;
	/** Total cache write tokens */
	readonly totalCacheWrite: number;
	/** Total cost in USD */
	readonly totalCost: number;
	/** Tool invocation counts */
	readonly toolCounts: ToolCounts;
	/** Number of user+assistant messages (excluding tool results) */
	readonly messageCount: number;
}

// ── Log Path ─────────────────────────────────────────────────────────────────

/**
 * Resolves the stats log file path.
 * Uses TALLOW_HOME env var if set, otherwise ~/.tallow.
 *
 * @returns Absolute path to stats.jsonl
 */
export function getStatsLogPath(): string {
	const tallowHome = process.env.TALLOW_CODING_AGENT_DIR || path.join(os.homedir(), ".tallow");
	return path.join(tallowHome, "stats.jsonl");
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Appends a session stats record to the JSONL log.
 * Creates the file and parent directories if they don't exist.
 *
 * @param stats - Session statistics to persist
 * @param logPath - Override log path (for testing)
 */
export function appendStats(stats: SessionStats, logPath?: string): void {
	const filePath = logPath ?? getStatsLogPath();
	const dir = path.dirname(filePath);

	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const line = `${JSON.stringify(stats)}\n`;
	fs.appendFileSync(filePath, line, "utf-8");
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Reads all session stats from the JSONL log.
 * Skips malformed lines silently.
 *
 * @param logPath - Override log path (for testing)
 * @returns Array of parsed session stats, oldest first
 */
export function readAllStats(logPath?: string): SessionStats[] {
	const filePath = logPath ?? getStatsLogPath();

	if (!fs.existsSync(filePath)) {
		return [];
	}

	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n").filter((line) => line.trim().length > 0);
	const results: SessionStats[] = [];

	for (const line of lines) {
		try {
			results.push(JSON.parse(line) as SessionStats);
		} catch {
			// Skip malformed lines
		}
	}

	return results;
}

/**
 * Returns the number of sessions in the stats log without parsing all data.
 * Counts non-empty lines in the file.
 *
 * @param logPath - Override log path (for testing)
 * @returns Number of recorded sessions
 */
export function countSessions(logPath?: string): number {
	const filePath = logPath ?? getStatsLogPath();

	if (!fs.existsSync(filePath)) {
		return 0;
	}

	const content = fs.readFileSync(filePath, "utf-8");
	return content.split("\n").filter((line) => line.trim().length > 0).length;
}
