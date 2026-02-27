/**
 * Query, verify integrity, and export audit trail files.
 *
 * All operations are read-only — the audit trail is append-only by design.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { computeEntryHash } from "./logger.js";
import type {
	AuditEntry,
	AuditExportFormat,
	AuditFileInfo,
	AuditQueryOptions,
	IntegrityResult,
} from "./types.js";

/**
 * Parse all entries from an audit JSONL file.
 * Malformed lines are silently skipped.
 */
function parseAuditFile(filePath: string): AuditEntry[] {
	if (!existsSync(filePath)) return [];

	const content = readFileSync(filePath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);
	const entries: AuditEntry[] = [];

	for (const line of lines) {
		try {
			entries.push(JSON.parse(line) as AuditEntry);
		} catch {
			// skip malformed lines
		}
	}

	return entries;
}

/**
 * Query audit trail entries from a JSONL file.
 *
 * Returns entries matching all specified filters, newest first.
 *
 * @param filePath - Absolute path to the audit JSONL file
 * @param options - Filter criteria
 * @returns Matching entries, newest first
 */
export function queryAuditTrail(filePath: string, options: AuditQueryOptions = {}): AuditEntry[] {
	const entries = parseAuditFile(filePath);

	const sinceMs = options.since ? new Date(options.since).getTime() : null;
	const untilMs = options.until ? new Date(options.until).getTime() : null;
	const searchLower = options.search?.toLowerCase();

	const matched: AuditEntry[] = [];

	for (const entry of entries) {
		if (options.category && entry.category !== options.category) continue;
		if (options.event && entry.event !== options.event) continue;
		if (options.actor && entry.actor !== options.actor) continue;
		if (options.outcome && entry.outcome !== options.outcome) continue;

		if (sinceMs !== null) {
			const entryMs = new Date(entry.ts).getTime();
			if (entryMs < sinceMs) continue;
		}

		if (untilMs !== null) {
			const entryMs = new Date(entry.ts).getTime();
			if (entryMs > untilMs) continue;
		}

		if (searchLower) {
			const serialized = JSON.stringify(entry).toLowerCase();
			if (!serialized.includes(searchLower)) continue;
		}

		matched.push(entry);
	}

	// Return newest first
	matched.reverse();

	if (options.limit && options.limit > 0) {
		return matched.slice(0, options.limit);
	}

	return matched;
}

/**
 * Verify the integrity of an audit trail file's hash chain.
 *
 * Recomputes each entry's hash and verifies it chains correctly.
 *
 * @param filePath - Absolute path to the audit JSONL file
 * @returns Integrity verification result
 */
export function verifyIntegrity(filePath: string): IntegrityResult {
	const entries = parseAuditFile(filePath);

	if (entries.length === 0) {
		return { valid: true, totalEntries: 0 };
	}

	let prevHash = "";

	for (const entry of entries) {
		// Verify prevHash chain
		if (entry.prevHash !== prevHash) {
			return {
				valid: false,
				totalEntries: entries.length,
				firstBrokenSeq: entry.seq,
				errorMessage: `Entry seq=${entry.seq}: prevHash mismatch (expected "${prevHash.slice(0, 16)}...", got "${entry.prevHash.slice(0, 16)}...")`,
			};
		}

		// Recompute hash: strip `hash` field, keep everything else
		const { hash: _storedHash, ...rest } = entry;
		const expectedHash = computeEntryHash(rest as Omit<AuditEntry, "hash">);

		if (entry.hash !== expectedHash) {
			return {
				valid: false,
				totalEntries: entries.length,
				firstBrokenSeq: entry.seq,
				errorMessage: `Entry seq=${entry.seq}: hash mismatch (entry was tampered with)`,
			};
		}

		prevHash = entry.hash;
	}

	return { valid: true, totalEntries: entries.length };
}

/**
 * List all audit trail files in a directory with metadata.
 *
 * @param dir - Absolute path to the audit directory
 * @returns Array of file metadata, sorted by date descending
 */
export function listAuditFiles(dir: string): AuditFileInfo[] {
	if (!existsSync(dir)) return [];

	const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	const results: AuditFileInfo[] = [];

	for (const file of files) {
		const filePath = join(dir, file);
		const stat = statSync(filePath);

		// Filename format: {sessionId}-{YYYY-MM-DD}.jsonl
		const match = file.match(/^(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$/);
		if (!match) continue;

		const content = readFileSync(filePath, "utf-8");
		const lineCount = content.trim().split("\n").filter(Boolean).length;

		results.push({
			path: filePath,
			sessionId: match[1],
			date: match[2],
			sizeBytes: stat.size,
			entryCount: lineCount,
		});
	}

	// Sort by date descending (newest first)
	results.sort((a, b) => b.date.localeCompare(a.date));
	return results;
}

/**
 * Export an audit trail file to the specified format.
 *
 * @param filePath - Absolute path to the audit JSONL file
 * @param format - Output format (jsonl, csv, json)
 * @param options - Optional query filters to apply before export
 * @returns Exported content as a string
 */
export function exportAuditTrail(
	filePath: string,
	format: AuditExportFormat = "jsonl",
	options?: AuditQueryOptions
): string {
	const entries = options ? queryAuditTrail(filePath, options) : parseAuditFile(filePath);

	switch (format) {
		case "jsonl":
			return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");

		case "json":
			return `${JSON.stringify(entries, null, 2)}\n`;

		case "csv": {
			const headers = [
				"seq",
				"ts",
				"sessionId",
				"category",
				"event",
				"actor",
				"outcome",
				"reason",
				"hash",
			];
			const csvLines = [headers.join(",")];
			for (const entry of entries) {
				const row = headers.map((h) => {
					const val = entry[h as keyof AuditEntry];
					if (val === undefined || val === null) return "";
					const str = String(val);
					// Escape CSV values containing commas, quotes, or newlines
					if (str.includes(",") || str.includes('"') || str.includes("\n")) {
						return `"${str.replace(/"/g, '""')}"`;
					}
					return str;
				});
				csvLines.push(row.join(","));
			}
			return `${csvLines.join("\n")}\n`;
		}

		default:
			return "";
	}
}
