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

// ── Settings ─────────────────────────────────────────────────────────────────

interface CompactionConfig {
	readonly enabled: boolean;
	readonly reserveTokens: number;
}

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
 * @param text - Input text
 * @returns Estimated token count
 */
function estimateTokensFromText(text: string): number {
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

// ── System prompt parsing ────────────────────────────────────────────────────

interface PromptBreakdown {
	basePromptTokens: number;
	contextFileTokens: number;
	skillTokens: number;
}

/**
 * Parses the system prompt to estimate token usage per section.
 * Looks for known section markers injected by tallow extensions.
 *
 * @param systemPrompt - Full system prompt string
 * @returns Token breakdown by section
 */
function parsePromptSections(systemPrompt: string): PromptBreakdown {
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
 * @param count - Token count
 * @returns Human-readable token string
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
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
	usedPercent: number
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

			const details = buildDetails(usage, systemPrompt, tools, modelId);

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
 * @returns Details object for the message renderer
 */
function buildDetails(
	usage: ContextUsage,
	systemPrompt: string,
	tools: Array<{ name: string; description: string; parameters: unknown }>,
	modelId: string
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

	const staticTokens =
		categories[0].tokens + categories[1].tokens + categories[2].tokens + categories[3].tokens;
	const messageTokens = Math.max(0, usage.tokens - staticTokens);
	categories[4].tokens = messageTokens;

	const freeTokens = Math.max(0, contextWindow - usage.tokens - reserveTokens);
	categories[5].tokens = freeTokens;

	return {
		modelId,
		contextWindow,
		usedTokens: usage.tokens,
		categories: categories.map((c) => ({
			name: c.name,
			icon: c.icon,
			color: c.color,
			filledChar: c.filledChar,
			emptyChar: c.emptyChar,
			tokens: c.tokens,
		})),
	};
}

/**
 * Renders the context usage display from pre-computed details.
 * @param details - Pre-computed context usage details
 * @returns Array of rendered lines
 */
function renderFromDetails(details: ContextUsageDetails): string[] {
	const { categories, contextWindow, modelId, usedTokens } = details;
	const usedPercent = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0;

	const lines: string[] = [];
	lines.push("");
	lines.push(`  ${BOLD}Context Usage${RESET}`);

	const chartLines = renderWaffleChart(categories, contextWindow);
	const legendLines = buildLegend(categories, contextWindow, modelId, usedTokens, usedPercent);

	const maxLines = Math.max(chartLines.length, legendLines.length);
	for (let i = 0; i < maxLines; i++) {
		const chart = i < chartLines.length ? chartLines[i] : "                          ";
		const legend = i < legendLines.length ? legendLines[i] : "";
		lines.push(`${chart}    ${legend}`);
	}

	lines.push("");
	return lines;
}
