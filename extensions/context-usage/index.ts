/**
 * Context Usage Extension
 *
 * Provides a `/context` command that visualizes context window usage
 * with a waffle chart and per-category token breakdown.
 *
 * Categories:
 *   - System prompt (base instructions)
 *   - System tools (tool definitions)
 *   - Context files (AGENTS.md, CLAUDE.md)
 *   - Skills (available skill metadata in prompt)
 *   - Messages (conversation history)
 *   - Free space (remaining capacity)
 *   - Autocompact buffer (reserved for compaction, only when enabled)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ContextUsage, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS } from "@mariozechner/pi-coding-agent";
import { getIcon } from "../_icons/index.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Waffle chart grid dimensions */
const GRID_COLS = 10;

/** Chars/4 heuristic for token estimation */
const CHARS_PER_TOKEN = 4;

/** Marker key attached by sdk tool-result retention summarization. */
const TOOL_RESULT_RETENTION_MARKER = "__tallow_summarized_tool_result__";

// ── Settings ─────────────────────────────────────────────────────────────────

interface CompactionConfig {
	readonly enabled: boolean;
	readonly reserveTokens: number;
}

/** Tool-result payload memory summary for the active branch. */
export interface ToolResultMemoryStats {
	readonly reclaimedBytes: number;
	readonly retainedBytes: number;
	readonly summarizedResults: number;
	readonly totalResults: number;
}

/** Zero-value fallback for tool-result memory stats. */
const EMPTY_TOOL_RESULT_MEMORY_STATS: ToolResultMemoryStats = {
	reclaimedBytes: 0,
	retainedBytes: 0,
	summarizedResults: 0,
	totalResults: 0,
};

/**
 * Reads compaction settings from ~/.tallow/settings.json.
 * Falls back to DEFAULT_COMPACTION_SETTINGS if unreadable.
 */
function readCompactionConfig(): CompactionConfig {
	const settingsPath = path.join(os.homedir(), ".tallow", "settings.json");
	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as {
			compaction?: { enabled?: boolean; reserveTokens?: number };
		};
		return {
			enabled: settings.compaction?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
			reserveTokens:
				settings.compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
		};
	} catch {
		return {
			enabled: DEFAULT_COMPACTION_SETTINGS.enabled,
			reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
		};
	}
}

// ── Category definitions ─────────────────────────────────────────────────────

interface Category {
	readonly name: string;
	readonly icon: string;
	/** ANSI color code (foreground) */
	readonly color: string;
	readonly filledChar: string;
	readonly emptyChar: string;
	tokens: number;
}

/**
 * Creates the category list with initial zero tokens.
 * @returns Mutable category array for population
 */
function createCategories(includeAutocompact: boolean): Category[] {
	const cats: Category[] = [
		{
			name: "System prompt",
			icon: getIcon("in_progress"),
			color: "\x1b[38;2;139;213;202m",
			filledChar: getIcon("in_progress"),
			emptyChar: getIcon("idle"),
			tokens: 0,
		},
		{
			name: "System tools",
			icon: getIcon("in_progress"),
			color: "\x1b[38;2;166;209;137m",
			filledChar: getIcon("in_progress"),
			emptyChar: getIcon("idle"),
			tokens: 0,
		},
		{
			name: "Context files",
			icon: getIcon("in_progress"),
			color: "\x1b[38;2;229;200;144m",
			filledChar: getIcon("in_progress"),
			emptyChar: getIcon("idle"),
			tokens: 0,
		},
		{
			name: "Skills",
			icon: getIcon("in_progress"),
			color: "\x1b[38;2;244;184;228m",
			filledChar: getIcon("in_progress"),
			emptyChar: getIcon("idle"),
			tokens: 0,
		},
		{
			name: "Messages",
			icon: getIcon("in_progress"),
			color: "\x1b[38;2;198;160;246m",
			filledChar: getIcon("in_progress"),
			emptyChar: getIcon("idle"),
			tokens: 0,
		},
		{
			name: "Free space",
			icon: getIcon("idle"),
			color: "\x1b[38;2;100;100;100m",
			filledChar: getIcon("idle"),
			emptyChar: getIcon("idle"),
			tokens: 0,
		},
	];
	if (includeAutocompact) {
		cats.push({
			name: "Autocompact buffer",
			icon: getIcon("unavailable"),
			color: "\x1b[38;2;70;70;70m",
			filledChar: getIcon("unavailable"),
			emptyChar: getIcon("unavailable"),
			tokens: 0,
		});
	}
	return cats;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

// ── Token estimation ─────────────────────────────────────────────────────────

/**
 * Estimates token count from a string using chars/4 heuristic.
 * @internal
 * @param text - Input text
 * @returns Estimated token count
 */
export function estimateTokensFromText(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimates tokens for tool definitions (name + description + JSON schema).
 * @param tools - Array of tool info objects
 * @returns Estimated token count for all tool definitions
 */
function estimateToolTokens(
	tools: Array<{ name: string; description: string; parameters: unknown }>
): number {
	let total = 0;
	for (const tool of tools) {
		const schemaStr = JSON.stringify(tool.parameters);
		total += estimateTokensFromText(`${tool.name}\n${tool.description}\n${schemaStr}`);
	}
	return total;
}

/**
 * Estimate UTF-8 bytes for a JSON-serializable value.
 *
 * @param value - Any serializable value
 * @returns Byte length of JSON representation, or 0 when unavailable
 */
function safeJsonBytes(value: unknown): number {
	if (value == null) return 0;
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf-8");
	} catch {
		return 0;
	}
}

/**
 * Type guard for plain object records.
 *
 * @param value - Unknown value
 * @returns True when value is a non-null object and not an array
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Estimate current in-memory payload bytes for a tool-result message.
 *
 * @param message - Candidate message object
 * @returns Estimated payload bytes for content + details
 */
function estimateToolResultMessageBytes(message: Record<string, unknown>): number {
	const content = Array.isArray(message.content) ? message.content : [];
	let contentBytes = 0;

	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text") {
			contentBytes += Buffer.byteLength(typeof block.text === "string" ? block.text : "", "utf-8");
			continue;
		}
		if (block.type === "image") {
			contentBytes += Buffer.byteLength(typeof block.data === "string" ? block.data : "", "utf-8");
			contentBytes += Buffer.byteLength(
				typeof block.mimeType === "string" ? block.mimeType : "",
				"utf-8"
			);
		}
	}

	const detailsBytes = safeJsonBytes(message.details);
	return contentBytes + detailsBytes;
}

/**
 * Compute tool-result payload memory stats from branch entries.
 *
 * @param branchEntries - Session branch entries from `sessionManager.getBranch()`
 * @returns Aggregated tool-result memory stats
 */
export function computeToolResultMemoryStats(
	branchEntries: Array<{ type: string; message?: unknown }>
): ToolResultMemoryStats {
	if (branchEntries.length === 0) return EMPTY_TOOL_RESULT_MEMORY_STATS;

	let reclaimedBytes = 0;
	let retainedBytes = 0;
	let summarizedResults = 0;
	let totalResults = 0;

	for (const entry of branchEntries) {
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "toolResult") continue;

		totalResults += 1;
		const currentBytes = estimateToolResultMessageBytes(entry.message);
		retainedBytes += currentBytes;

		const details = entry.message.details;
		if (!isRecord(details) || details[TOOL_RESULT_RETENTION_MARKER] !== true) continue;
		summarizedResults += 1;
		const originalBytes =
			typeof details.originalBytes === "number" && Number.isFinite(details.originalBytes)
				? Math.max(0, details.originalBytes)
				: 0;
		reclaimedBytes += Math.max(0, originalBytes - currentBytes);
	}

	return {
		reclaimedBytes,
		retainedBytes,
		summarizedResults,
		totalResults,
	};
}

// ── System prompt parsing ────────────────────────────────────────────────────

/** @internal */
export interface PromptBreakdown {
	basePromptTokens: number;
	contextFileTokens: number;
	skillTokens: number;
}

/**
 * Parses the system prompt to estimate token usage per section.
 * Looks for known section markers injected by tallow extensions.
 *
 * @internal
 * @param systemPrompt - Full system prompt string
 * @returns Token breakdown by section
 */
export function parsePromptSections(systemPrompt: string): PromptBreakdown {
	let contextFileTokens = 0;
	let skillTokens = 0;

	// Extract context files section (added by context-files extension)
	const contextFileMarker = "# Additional Project Context";
	const contextIdx = systemPrompt.indexOf(contextFileMarker);

	// Extract skills section (available_skills block)
	const skillStartMarker = "<available_skills>";
	const skillEndMarker = "</available_skills>";
	const skillStart = systemPrompt.indexOf(skillStartMarker);
	const skillEnd = systemPrompt.indexOf(skillEndMarker);

	if (skillStart !== -1 && skillEnd !== -1) {
		const skillSection = systemPrompt.slice(skillStart, skillEnd + skillEndMarker.length);
		skillTokens = estimateTokensFromText(skillSection);
	}

	// Context files: from marker to either skills section or end
	if (contextIdx !== -1) {
		const contextEnd = skillStart !== -1 ? skillStart : systemPrompt.length;
		const contextSection = systemPrompt.slice(contextIdx, contextEnd);
		contextFileTokens = estimateTokensFromText(contextSection);
	}

	// Also check for "# Project Context" marker (pi native)
	const projectContextMarker = "# Project Context";
	const projectIdx = systemPrompt.indexOf(projectContextMarker);
	if (projectIdx !== -1 && contextIdx === -1) {
		// If no "Additional Project Context" but "Project Context" exists
		const contextEnd = skillStart !== -1 ? skillStart : systemPrompt.length;
		const contextSection = systemPrompt.slice(projectIdx, contextEnd);
		contextFileTokens = estimateTokensFromText(contextSection);
	}

	// Base prompt = total - context files - skills
	const totalPromptTokens = estimateTokensFromText(systemPrompt);
	const basePromptTokens = Math.max(0, totalPromptTokens - contextFileTokens - skillTokens);

	return { basePromptTokens, contextFileTokens, skillTokens };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Formats a token count with k/M suffixes.
 * @internal
 * @param count - Token count
 * @returns Human-readable token string
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Formats byte counts with compact units.
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
 * Renders the waffle chart grid.
 * Each cell represents a proportional slice of the context window.
 *
 * @param categories - Categories with token counts
 * @param contextWindow - Total context window size
 * @returns Array of rendered grid lines
 */
function renderWaffleChart(categories: readonly Category[], contextWindow: number): string[] {
	// Calculate how many cells each category gets
	const totalCells = GRID_COLS * GRID_COLS;
	const cells: { color: string; char: string }[] = [];

	for (const cat of categories) {
		const proportion = cat.tokens / contextWindow;
		const cellCount = Math.round(proportion * totalCells);
		for (let i = 0; i < cellCount && cells.length < totalCells; i++) {
			cells.push({ color: cat.color, char: cat.filledChar });
		}
	}

	// Fill remaining with empty
	while (cells.length < totalCells) {
		cells.push({ color: "\x1b[38;2;100;100;100m", char: getIcon("idle") });
	}

	// Render grid rows
	const lines: string[] = [];
	for (let row = 0; row < GRID_COLS; row++) {
		let line = "    ";
		for (let col = 0; col < GRID_COLS; col++) {
			const cell = cells[row * GRID_COLS + col];
			line += `${cell.color}${cell.char}${RESET} `;
		}
		lines.push(line);
	}

	return lines;
}

/**
 * Builds the legend/breakdown that appears next to the waffle chart.
 *
 * @param categories - Categories with token counts
 * @param contextWindow - Total context window size
 * @param modelId - Model identifier string
 * @param usedTokens - Total tokens currently used
 * @param usedPercent - Percentage of context used
 * @returns Array of legend lines
 */
function buildLegend(
	categories: readonly Category[],
	contextWindow: number,
	modelId: string,
	usedTokens: number,
	usedPercent: number,
	toolResultMemory: ToolResultMemoryStats
): string[] {
	const lines: string[] = [];

	// Model and usage summary
	lines.push(
		`${modelId} · ${formatTokens(usedTokens)}/${formatTokens(contextWindow)} tokens (${usedPercent.toFixed(0)}%)`
	);
	lines.push("");
	lines.push(`${DIM}Estimated usage by category${RESET}`);

	// Category breakdown
	for (const cat of categories) {
		if (cat.tokens === 0) continue;
		const percent = contextWindow > 0 ? (cat.tokens / contextWindow) * 100 : 0;
		const percentStr = percent < 0.1 ? "0.0" : percent.toFixed(1);
		lines.push(
			`${cat.color}${cat.icon}${RESET} ${cat.name}: ${formatTokens(cat.tokens)} tokens (${percentStr}%)`
		);
	}

	if (toolResultMemory.totalResults > 0) {
		lines.push("");
		lines.push(`${DIM}Historical tool-result payloads${RESET}`);
		lines.push(
			`${getIcon("in_progress")} results: ${toolResultMemory.totalResults} total, ` +
				`${toolResultMemory.summarizedResults} summarized`
		);
		lines.push(
			`${getIcon("in_progress")} retained bytes: ${formatBytes(toolResultMemory.retainedBytes)}`
		);
		if (toolResultMemory.reclaimedBytes > 0) {
			lines.push(
				`${getIcon("success")} reclaimed bytes: ${formatBytes(toolResultMemory.reclaimedBytes)}`
			);
		}
	}

	return lines;
}

// ── Extension entry point ────────────────────────────────────────────────────

// ── Message renderer details ─────────────────────────────────────────────────

interface ContextUsageDetails {
	readonly modelId: string;
	readonly contextWindow: number;
	readonly usedTokens: number;
	readonly categories: ReadonlyArray<{
		readonly name: string;
		readonly icon: string;
		readonly color: string;
		readonly filledChar: string;
		readonly emptyChar: string;
		readonly tokens: number;
	}>;
	readonly toolResultMemory: ToolResultMemoryStats;
}

/**
 * Registers the /context command for visualizing context window usage.
 * @param pi - Extension API
 */
export default function contextUsageExtension(pi: ExtensionAPI): void {
	// Register message renderer so context usage appears as a scrollable chat message
	pi.registerMessageRenderer<ContextUsageDetails>("context-usage", (message, _options, _theme) => {
		const details = message.details;
		if (!details) {
			return {
				render(_width: number): string[] {
					return ["No context usage data."];
				},
				invalidate() {},
			};
		}

		return {
			/**
			 * Renders the context usage waffle chart and legend.
			 * @param _width - Available terminal width
			 * @returns Array of rendered lines
			 */
			render(_width: number): string[] {
				return renderFromDetails(details);
			},
			invalidate() {},
		};
	});

	pi.registerCommand("context", {
		description: "Show context window usage breakdown",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			if (!usage) {
				ctx.ui.notify("No context usage data available yet. Send a message first.", "warning");
				return;
			}

			const systemPrompt = ctx.getSystemPrompt();
			const tools = pi.getAllTools();
			const modelId = ctx.model?.id ?? "unknown-model";
			const branchEntries = ctx.sessionManager.getBranch() as Array<{
				type: string;
				message?: unknown;
			}>;

			const details = buildDetails(usage, systemPrompt, tools, modelId, branchEntries);

			pi.sendMessage({
				customType: "context-usage",
				content: "Context usage breakdown",
				display: true,
				details,
			});
		},
	});
}

/**
 * Builds the serializable details payload from live session data.
 * @param usage - Context usage from the session
 * @param systemPrompt - Current system prompt
 * @param tools - Registered tools
 * @param modelId - Current model identifier
 * @param branchEntries - Current session branch entries
 * @returns Details object for the message renderer
 */
function buildDetails(
	usage: ContextUsage,
	systemPrompt: string,
	tools: Array<{ name: string; description: string; parameters: unknown }>,
	modelId: string,
	branchEntries: Array<{ type: string; message?: unknown }>
): ContextUsageDetails {
	const compaction = readCompactionConfig();
	const includeAutocompact = compaction.enabled;
	const categories = createCategories(includeAutocompact);
	const contextWindow = usage.contextWindow;

	const promptBreakdown = parsePromptSections(systemPrompt);
	const toolTokens = estimateToolTokens(tools);

	categories[0].tokens = promptBreakdown.basePromptTokens;
	categories[1].tokens = toolTokens;
	categories[2].tokens = promptBreakdown.contextFileTokens;
	categories[3].tokens = promptBreakdown.skillTokens;

	const reserveTokens = includeAutocompact ? compaction.reserveTokens : 0;
	if (includeAutocompact) {
		categories[6].tokens = reserveTokens;
	}

	const usedTokens = usage.tokens ?? 0;
	const staticTokens =
		categories[0].tokens + categories[1].tokens + categories[2].tokens + categories[3].tokens;
	const messageTokens = Math.max(0, usedTokens - staticTokens);
	categories[4].tokens = messageTokens;

	const freeTokens = Math.max(0, contextWindow - usedTokens - reserveTokens);
	categories[5].tokens = freeTokens;

	const toolResultMemory = computeToolResultMemoryStats(branchEntries);

	return {
		modelId,
		contextWindow,
		usedTokens,
		categories: categories.map((c) => ({
			name: c.name,
			icon: c.icon,
			color: c.color,
			filledChar: c.filledChar,
			emptyChar: c.emptyChar,
			tokens: c.tokens,
		})),
		toolResultMemory,
	};
}

/**
 * Renders the context usage display from pre-computed details.
 * @param details - Pre-computed context usage details
 * @returns Array of rendered lines
 */
function renderFromDetails(details: ContextUsageDetails): string[] {
	const { categories, contextWindow, modelId, toolResultMemory, usedTokens } = details;
	const usedPercent = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0;

	const lines: string[] = [];
	lines.push("");
	lines.push(`  ${BOLD}Context Usage${RESET}`);

	const chartLines = renderWaffleChart(categories, contextWindow);
	const legendLines = buildLegend(
		categories,
		contextWindow,
		modelId,
		usedTokens,
		usedPercent,
		toolResultMemory
	);

	const maxLines = Math.max(chartLines.length, legendLines.length);
	for (let i = 0; i < maxLines; i++) {
		const chart = i < chartLines.length ? chartLines[i] : "                          ";
		const legend = i < legendLines.length ? legendLines[i] : "";
		lines.push(`${chart}    ${legend}`);
	}

	lines.push("");
	return lines;
}
