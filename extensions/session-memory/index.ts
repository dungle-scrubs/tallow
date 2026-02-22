/**
 * Session Memory — search and recall context from previous tallow sessions.
 *
 * Registers a single `session_recall` tool that:
 * 1. Builds/updates an FTS5 index over session JSONL files (incremental)
 * 2. Searches the index for relevant conversation turns
 * 3. Passes results through a curator LLM (Haiku) to filter noise
 * 4. Returns curated context to the main agent
 *
 * The main agent never sees raw search results — only curator-filtered excerpts.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import { MEMORY_RELEASE_EVENTS } from "../_shared/memory-release-events.js";
import { buildCuratorPrompt } from "./curator-prompt.js";
import { SessionIndexer } from "./indexer.js";
import type { SearchResult } from "./types.js";

/** Details attached to tool result for rendering. */
interface RecallDetails {
	query: string;
	matchCount: number;
	sessionCount: number;
	curatorModel?: string;
	status: "found" | "empty" | "error" | "fallback";
}

/** Singleton indexer — created on first tool call, reused across invocations. */
let indexer: SessionIndexer | null = null;

/**
 * Release the in-memory session indexer singleton.
 *
 * This closes the SQLite handle and drops the module-level reference so memory
 * can be reclaimed. The next session_recall call lazily recreates the indexer.
 *
 * @returns True when an indexer existed and was released
 */
function releaseSessionMemoryIndexer(): boolean {
	if (!indexer) return false;
	try {
		indexer.close();
	} catch {
		// Best-effort release — continue clearing the singleton reference.
	}
	indexer = null;
	return true;
}

/**
 * Read the current singleton indexer (test helper).
 *
 * @returns Active indexer reference or null
 */
export function getSessionMemoryIndexerForTests(): SessionIndexer | null {
	return indexer;
}

/**
 * Set the singleton indexer reference (test helper).
 *
 * @param nextIndexer - Indexer instance to set, or null to clear
 * @returns void
 */
export function setSessionMemoryIndexerForTests(nextIndexer: SessionIndexer | null): void {
	releaseSessionMemoryIndexer();
	indexer = nextIndexer;
}

/**
 * Resolve the tallow config directory.
 *
 * TALLOW_CODING_AGENT_DIR is set by tallow's bootstrap (src/config.ts) before
 * any extensions load. It accounts for per-project overrides from
 * ~/.config/tallow-work-dirs. All extensions should use this — never hardcode ~/.tallow.
 *
 * @returns Path to the tallow config directory (e.g., ~/.tallow or ~/.tallow-fuse)
 */
function getTallowHome(): string {
	return process.env.TALLOW_CODING_AGENT_DIR ?? join(homedir(), ".tallow");
}

/**
 * Discover ALL tallow session directories across all tallow homes.
 *
 * Tallow supports per-project config dirs via ~/.config/tallow-work-dirs.
 * Sessions from different projects live in different directories. We need
 * to search all of them for cross-project recall.
 *
 * @returns Array of session directory paths that exist
 */
function discoverAllSessionsDirs(): string[] {
	const dirs = new Set<string>();

	// Current tallow home (always included)
	const currentHome = getTallowHome();
	const currentSessions = join(currentHome, "sessions");
	if (existsSync(currentSessions)) dirs.add(currentSessions);

	// Default tallow home (if different from current)
	const defaultSessions = join(homedir(), ".tallow", "sessions");
	if (existsSync(defaultSessions)) dirs.add(defaultSessions);

	// All per-project tallow homes from work-dirs config
	const workDirsPath = join(homedir(), ".config", "tallow-work-dirs");
	try {
		const content = readFileSync(workDirsPath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const colonIdx = trimmed.indexOf(":");
			if (colonIdx === -1) continue;
			const configDir = trimmed.slice(colonIdx + 1);
			if (configDir) {
				const sessDir = join(configDir, "sessions");
				if (existsSync(sessDir)) dirs.add(sessDir);
			}
		}
	} catch {
		// File doesn't exist or isn't readable
	}

	return Array.from(dirs);
}

/**
 * Get or create the singleton SessionIndexer.
 * The database lives in the current tallow home, indexing sessions from ALL homes.
 *
 * @returns SessionIndexer instance
 */
function getIndexer(): SessionIndexer {
	if (!indexer) {
		const dbPath = join(getTallowHome(), "sessions", "index.db");
		indexer = new SessionIndexer(dbPath);
	}
	return indexer;
}

/**
 * Find a suitable curator model from the registry.
 * Prefers Haiku (cheap/fast), falls back to whatever is available.
 *
 * @param ctx - Extension context with model registry
 * @returns Model instance or undefined
 */
function findCuratorModel(ctx: ExtensionContext): Model<Api> | undefined {
	const registry = ctx.modelRegistry;

	// Preference order: Haiku → Sonnet → whatever's available
	const candidates = [
		["anthropic", "claude-haiku-4-5"],
		["anthropic", "claude-sonnet-4-5"],
		["anthropic", "claude-sonnet-4-5-20250514"],
	] as const;

	for (const [provider, modelId] of candidates) {
		const model = registry.find(provider, modelId);
		if (model) return model;
	}

	// Last resort: first available model
	const available = registry.getAvailable();
	return available.length > 0 ? available[0] : undefined;
}

/** Max chars per result section sent to curator. Limits total payload size. */
const MAX_RESULT_CHARS = 8_000;

/**
 * Format search results as context for the curator LLM.
 *
 * Matched turns are sent untruncated — the curator's job is to extract
 * the right content, which it can't do if we pre-truncate. Context turns
 * are lightly trimmed. Total payload is bounded by result count (max 8)
 * and a per-result character cap.
 *
 * @param results - FTS5 search results (capped to 8)
 * @param query - Original user query
 * @returns Formatted string for the curator's user message
 */
function formatResultsForCurator(results: SearchResult[], query: string): string {
	const capped = results.slice(0, 8);
	const sections = capped.map((r, i) => {
		const date = new Date(r.date).toLocaleDateString("en-US", {
			weekday: "short",
			month: "short",
			day: "numeric",
			year: "numeric",
		});

		let section = `### Result ${i + 1} — ${r.project} (${date})\n`;
		section += `Session topic: ${r.firstMessage}\n\n`;

		if (r.contextBefore) {
			section += `[Context before]\n`;
			if (r.contextBefore.userText) section += `User: ${truncate(r.contextBefore.userText, 500)}\n`;
			if (r.contextBefore.assistantText)
				section += `Assistant: ${truncate(r.contextBefore.assistantText, 500)}\n`;
			section += "\n";
		}

		// Matched turn: untruncated — this is what the curator judges
		section += `[Matched turn]\n`;
		if (r.matchedTurn.userText) section += `User: ${r.matchedTurn.userText}\n`;
		if (r.matchedTurn.assistantText) section += `Assistant: ${r.matchedTurn.assistantText}\n`;

		if (r.contextAfter) {
			section += `\n[Context after]\n`;
			if (r.contextAfter.userText) section += `User: ${truncate(r.contextAfter.userText, 500)}\n`;
			if (r.contextAfter.assistantText)
				section += `Assistant: ${truncate(r.contextAfter.assistantText, 500)}\n`;
		}

		// Cap total section size to prevent one massive turn from dominating
		return section.length > MAX_RESULT_CHARS
			? `${section.slice(0, MAX_RESULT_CHARS)}…[truncated]`
			: section;
	});

	return `## Search Results for: "${query}"\n\n${sections.join("\n---\n\n")}`;
}

/**
 * Truncate a string to a maximum length, appending ellipsis if truncated.
 *
 * @param text - String to truncate
 * @param maxLength - Maximum character count
 * @returns Truncated string
 */
function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}…`;
}

const SessionRecallParams = Type.Object({
	query: Type.String({
		description: "Keywords to match in previous sessions (used for FTS search)",
	}),
	looking_for: Type.String({
		description:
			"What kind of content you're looking for near those keywords. " +
			'Be specific about the content type: "an ASCII mockup of a UI design", ' +
			'"a decision about which database to use", "a list of API endpoints", ' +
			'"code for the auth flow". The curator uses this to extract the right content from matches.',
	}),
	project: Type.Optional(
		Type.String({ description: "Filter by project name (e.g., 'rack-warehouse', 'tallow')" })
	),
	date_from: Type.Optional(
		Type.String({ description: "Only search sessions after this date (ISO format)" })
	),
	date_to: Type.Optional(
		Type.String({ description: "Only search sessions before this date (ISO format)" })
	),
});

/**
 * Session Memory extension entry point.
 *
 * @param pi - Extension API for registering tools
 */
export default function (pi: ExtensionAPI) {
	pi.events.on(MEMORY_RELEASE_EVENTS.completed, () => {
		releaseSessionMemoryIndexer();
	});

	pi.on("session_shutdown", async () => {
		releaseSessionMemoryIndexer();
	});

	pi.registerTool({
		name: "session_recall",
		label: "session_recall",
		description:
			"Search and recall relevant context from previous tallow sessions. " +
			"Use when the user references something discussed in a prior session, or when you need " +
			"historical context about decisions, plans, or designs. Returns curated, filtered " +
			"excerpts — not raw search results. Searches across all sessions for the current project " +
			"by default, or specify a project name to search elsewhere.",
		parameters: SessionRecallParams,

		renderResult(result, _options, theme) {
			const d = result.details as RecallDetails | undefined;
			if (!d) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 1, 0);
			}

			// Truncate query for display — it can be very long
			const shortQuery = d.query.length > 40 ? `${d.query.slice(0, 40)}…` : d.query;

			let line: string;
			switch (d.status) {
				case "found": {
					const model = d.curatorModel ? theme.fg("muted", ` via ${d.curatorModel}`) : "";
					line =
						theme.fg("success", `${getIcon("success")} `) +
						theme.fg("accent", `"${shortQuery}"`) +
						theme.fg("muted", ` — ${d.matchCount} match(es), ${d.sessionCount} session(s)`) +
						model;
					break;
				}
				case "empty":
					line =
						theme.fg("warning", "∅ ") +
						theme.fg("muted", "No matches for ") +
						theme.fg("accent", `"${shortQuery}"`);
					break;
				case "fallback":
					line =
						theme.fg("warning", "⚠ ") +
						theme.fg("muted", "Curator unavailable — raw results for ") +
						theme.fg("accent", `"${shortQuery}"`);
					break;
				case "error":
					line =
						theme.fg("error", `${getIcon("error")} `) + theme.fg("muted", "Session recall failed");
					break;
				default:
					line = "";
			}

			return new Text(line, 1, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { query, looking_for, project, date_from, date_to } = params;

			try {
				// ── 1. Discover all session directories ────────────────────────
				const sessionsDirs = discoverAllSessionsDirs();
				if (sessionsDirs.length === 0) {
					return {
						content: [{ type: "text", text: "No sessions directories found." }],
						details: {
							query,
							matchCount: 0,
							sessionCount: 0,
							status: "empty",
						} satisfies RecallDetails,
					};
				}

				// ── 2. Build/update index across all tallow homes ──────────────
				ctx.ui.setWorkingMessage("Indexing sessions…");
				const idx = getIndexer();
				const currentSessionId = ctx.sessionManager.getSessionId();
				for (const dir of sessionsDirs) {
					await idx.indexSessions(dir, currentSessionId);
				}

				// ── 3. Search ──────────────────────────────────────────────────
				ctx.ui.setWorkingMessage("Searching sessions…");
				const results = idx.search(query, {
					project,
					dateFrom: date_from,
					dateTo: date_to,
					limit: 15,
				});

				if (results.length === 0) {
					ctx.ui.setWorkingMessage();
					return {
						content: [
							{
								type: "text",
								text: `No matching sessions found for "${query}"${project ? ` in project "${project}"` : ""}.`,
							},
						],
						details: {
							query,
							matchCount: 0,
							sessionCount: 0,
							status: "empty",
						} satisfies RecallDetails,
					};
				}

				// ── 4. Curator LLM call ────────────────────────────────────────
				ctx.ui.setWorkingMessage("Curating results…");
				const model = findCuratorModel(ctx);
				if (!model) {
					ctx.ui.setWorkingMessage();
					const sc = new Set(results.map((r) => r.sessionId)).size;
					return {
						content: [{ type: "text", text: formatRawFallback(results, query) }],
						details: {
							query,
							matchCount: results.length,
							sessionCount: sc,
							status: "fallback",
						} satisfies RecallDetails,
					};
				}

				const apiKey = await ctx.modelRegistry.getApiKey(model);
				if (!apiKey) {
					ctx.ui.setWorkingMessage();
					const sc = new Set(results.map((r) => r.sessionId)).size;
					return {
						content: [{ type: "text", text: formatRawFallback(results, query) }],
						details: {
							query,
							matchCount: results.length,
							sessionCount: sc,
							status: "fallback",
						} satisfies RecallDetails,
					};
				}

				const curatorInput = formatResultsForCurator(results, query);
				let curatorResponse: AssistantMessage;

				try {
					curatorResponse = await completeSimple(
						model,
						{
							systemPrompt: buildCuratorPrompt(looking_for),
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: curatorInput }],
									timestamp: Date.now(),
								},
							],
						},
						{ apiKey }
					);
				} catch (_err) {
					ctx.ui.setWorkingMessage();
					const sc = new Set(results.map((r) => r.sessionId)).size;
					return {
						content: [{ type: "text", text: formatRawFallback(results, query) }],
						details: {
							query,
							matchCount: results.length,
							sessionCount: sc,
							status: "fallback",
						} satisfies RecallDetails,
					};
				}

				ctx.ui.setWorkingMessage();

				// Extract text from curator response
				const curatorText = curatorResponse.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();

				const sessionCount = new Set(results.map((r) => r.sessionId)).size;

				return {
					content: [{ type: "text", text: curatorText }],
					details: {
						query,
						matchCount: results.length,
						sessionCount,
						curatorModel: model.id,
						status: "found",
					} satisfies RecallDetails,
				};
			} catch (err) {
				ctx.ui.setWorkingMessage();
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Session recall error: ${message}` }],
					details: {
						query,
						matchCount: 0,
						sessionCount: 0,
						status: "error",
					} satisfies RecallDetails,
					isError: true,
				};
			}
		},
	});
}

/**
 * Format raw search results as a fallback when the curator LLM is unavailable.
 *
 * @param results - FTS5 search results
 * @param query - Original query
 * @returns Formatted text with top results
 */
function formatRawFallback(results: SearchResult[], query: string): string {
	const sessionCount = new Set(results.map((r) => r.sessionId)).size;
	return `Found ${results.length} match(es) across ${sessionCount} session(s) for "${query}", but the curator model is unavailable to extract the relevant content. Try again or check model configuration.`;
}
