import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import {
	bashTool,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	codingTools,
	createAgentSession,
	createEventBus,
	DefaultPackageManager,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	editTool,
	findTool,
	grepTool,
	type LoadExtensionsResult,
	lsTool,
	ModelRegistry,
	type PromptTemplate,
	readOnlyTools,
	readTool,
	SessionManager,
	SettingsManager,
	type Skill,
	writeTool,
} from "@mariozechner/pi-coding-agent";
import * as PiTui from "@mariozechner/pi-tui";
import { atomicWriteFileSync } from "./atomic-write.js";
import { createSecureAuthStorage, resolveRuntimeApiKeyFromEnv } from "./auth-hardening.js";
import { applyAgentSessionCompactionCancelPatch } from "./compaction-cancel-patch.js";
import {
	BUNDLED,
	bootstrap,
	getRuntimeTallowHome,
	resolveOpSecrets,
	TALLOW_VERSION,
} from "./config.js";
import { applyInteractiveModeStaleUiPatch } from "./interactive-mode-patch.js";
import { cleanupOrphanPids } from "./pid-manager.js";
import {
	extractClaudePluginResources,
	type ResolvedPlugin,
	readPluginManifest,
	resolvePlugins,
	type TallowExtensionManifest,
} from "./plugins.js";
import {
	applyProjectTrustContextToEnv,
	type ProjectTrustContext,
	type ProjectTrustStatus,
	resolveProjectTrust,
	trustProject,
	untrustProject,
} from "./project-trust.js";
import { buildProjectTrustBannerPayload } from "./project-trust-banner.js";
import { PROJECT_TRUST_API_CHANNELS } from "./project-trust-interop.js";
import { migrateSessionsToPerCwdDirs } from "./session-migration.js";
import { createSessionWithId, findSessionById } from "./session-utils.js";
import { normalizeStartupProfile, type StartupProfile } from "./startup-profile.js";
import { emitStartupTiming, isStartupTimingEnabled } from "./startup-timing.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Startup behavior profile used to optimize session initialization.
 *
 * - `interactive`: full TUI-oriented startup path
 * - `headless`: optimized startup for print/json/rpc workflows
 */
export type TallowStartupProfile = StartupProfile;

export interface TallowSessionOptions {
	/** Working directory. Default: process.cwd() */
	cwd?: string;

	/**
	 * Startup profile that controls interactive-vs-headless initialization behavior.
	 * Defaults to "interactive" when omitted.
	 */
	startupProfile?: TallowStartupProfile;

	/** Pre-resolved Model object. Takes precedence over provider/modelId strings. */
	model?: CreateAgentSessionOptions["model"];

	/** Provider name (e.g., "anthropic"). Used with modelId for string-based resolution. */
	provider?: string;

	/** Model ID (e.g., "claude-sonnet-4"). Used with provider for string-based resolution. */
	modelId?: string;

	/** Runtime API key override (not persisted to auth.json). Requires provider to be set. */
	apiKey?: string;

	/** Thinking level. Default: from settings or "off" */
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];

	/** Session management strategy */
	session?:
		| { type: "memory" }
		| { type: "new" }
		| { type: "continue" }
		| { type: "open"; path: string }
		| { type: "open-or-create"; sessionId: string }
		| { type: "resume"; sessionId: string }
		| { type: "fork"; sourceSessionId: string };

	/** Additional extension selectors (bundled IDs or filesystem paths). */
	additionalExtensions?: string[];

	/** Load only explicitly selected extension selectors (IDs/paths). */
	extensionsOnly?: boolean;

	/** Plugin specs — remote repos or local paths (Claude Code or tallow format) */
	plugins?: string[];

	/** Additional extension factories (inline extensions) */
	extensionFactories?: ExtensionFactory[];

	/** Additional skills (on top of bundled + user) */
	additionalSkills?: Skill[];

	/** Additional prompt templates */
	additionalPrompts?: PromptTemplate[];

	/** Override the system prompt entirely */
	systemPrompt?: string;

	/** Append to the system prompt */
	appendSystemPrompt?: string;

	/** Disable bundled extensions */
	noBundledExtensions?: boolean;

	/** Disable bundled skills */
	noBundledSkills?: boolean;

	/** Custom tools (in addition to built-in coding tools) */
	customTools?: CreateAgentSessionOptions["customTools"];

	/** Override built-in tools */
	tools?: CreateAgentSessionOptions["tools"];

	/** Settings overrides */
	settings?: Record<string, unknown>;
}

/** Marker key used on summarized historical tool results. */
export const TOOL_RESULT_RETENTION_MARKER = "__tallow_summarized_tool_result__";

/** Marker key used on ingestion-time budget-guarded tool results. */
export const TOOL_RESULT_BUDGET_GUARD_MARKER = "__tallow_budget_guard__";

/** Default retention policy for historical tool-result payloads. */
const DEFAULT_TOOL_RESULT_RETENTION_POLICY = {
	enabled: true,
	keepRecentToolResults: 12,
	maxRetainedBytesPerResult: 48 * 1024,
	previewChars: 600,
} as const;

/** Resolved policy controlling when historical tool results are summarized. */
export interface ToolResultRetentionPolicy {
	readonly enabled: boolean;
	readonly keepRecentToolResults: number;
	readonly maxRetainedBytesPerResult: number;
	readonly previewChars: number;
}

// ─── Context Budget Policy ───────────────────────────────────────────────────

/** Default context-budget thresholds and caps. */
const DEFAULT_CONTEXT_BUDGET_POLICY = {
	softThresholdPercent: 75,
	hardThresholdPercent: 90,
	minPerToolBytes: 4 * 1024,
	maxPerToolBytes: 512 * 1024,
	perTurnReserveTokens: 8_000,
	unknownUsageFallbackCapBytes: 32 * 1024,
} as const;

/** Event channels for context-budget planner ↔ tool API handshake. */
const CONTEXT_BUDGET_API_CHANNELS = {
	budgetApi: "interop.api.v1.context-budget.api",
	budgetApiRequest: "interop.api.v1.context-budget.api-request",
} as const;

/** Default TTL for per-tool context-budget envelopes. */
const CONTEXT_BUDGET_ENVELOPE_TTL_MS = 30_000;

/** Resolved policy controlling context-budget guardrails. */
export interface ContextBudgetPolicy {
	/** Percentage of context window at which soft budget warnings begin. */
	readonly softThresholdPercent: number;
	/** Percentage of context window at which hard budget caps apply. */
	readonly hardThresholdPercent: number;
	/** Minimum bytes a single tool call is always allowed. */
	readonly minPerToolBytes: number;
	/** Maximum bytes a single tool call may receive. */
	readonly maxPerToolBytes: number;
	/** Tokens reserved each turn for the model's response. */
	readonly perTurnReserveTokens: number;
	/** Byte cap applied when context usage is unknown (post-compaction). */
	readonly unknownUsageFallbackCapBytes: number;
}

/** Optional settings payload accepted from settings.json / overrides. */
interface ContextBudgetConfigInput {
	readonly softThresholdPercent?: unknown;
	readonly hardThresholdPercent?: unknown;
	readonly minPerToolBytes?: unknown;
	readonly maxPerToolBytes?: unknown;
	readonly perTurnReserveTokens?: unknown;
	readonly unknownUsageFallbackCapBytes?: unknown;
}

/** Minimal context-usage snapshot used by budget helpers. */
export interface ContextUsageSnapshot {
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly percent: number | null;
}

/** Metadata attached to budget-guarded tool results under a namespaced key. */
interface BudgetGuardMetadata {
	readonly [key: string]: unknown;
	readonly guardedAt: string;
	readonly originalContentBytes: number;
	readonly truncatedToBytes: number;
	readonly reason: "over_budget" | "unknown_usage";
}

/** Optional settings payload accepted from settings.json / overrides. */
interface ToolResultRetentionConfigInput {
	readonly enabled?: unknown;
	readonly keepRecentToolResults?: unknown;
	readonly maxRetainedBytesPerResult?: unknown;
	readonly previewChars?: unknown;
}

/** Marker payload attached to `toolResult.details` after summarization. */
interface ToolResultRetentionMarkerDetails {
	readonly [TOOL_RESULT_RETENTION_MARKER]: true;
	readonly contentBytes: number;
	readonly detailsBytes: number;
	readonly originalBytes: number;
	readonly summarizedAt: string;
	readonly summaryChars: number;
}

/** Minimal shape used for in-place tool-result summarization. */
interface ToolResultMessageLike {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

/** Byte-size metrics for a single tool-result payload. */
interface ToolResultPayloadBytes {
	readonly contentBytes: number;
	readonly detailsBytes: number;
	readonly totalBytes: number;
}

/** Output from ingestion-time budget guarding for tool-result content. */
interface GuardedToolResultContent {
	readonly content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	readonly originalTextBytes: number;
	readonly truncatedToBytes: number;
	readonly wasGuarded: boolean;
}

/** Aggregate stats from a retention pass over historical tool results. */
export interface ToolResultRetentionRunStats {
	readonly examinedCount: number;
	readonly summarizedCount: number;
	readonly summarizedBytes: number;
}

// ─── Tool Flag ───────────────────────────────────────────────────────────────

// AgentTool has contravariant params, so typed tools don't assign to AgentTool<TSchema>.
// We use the opaque array type from CreateAgentSessionOptions["tools"] instead.
type ToolArray = NonNullable<CreateAgentSessionOptions["tools"]>;
type ToolItem = ToolArray[number];

/** Map of tool name → tool object for --tools flag resolution. */
const TOOL_MAP: Record<string, ToolItem> = {
	read: readTool as ToolItem,
	bash: bashTool as ToolItem,
	edit: editTool as ToolItem,
	write: writeTool as ToolItem,
	grep: grepTool as ToolItem,
	find: findTool as ToolItem,
	ls: lsTool as ToolItem,
};

/** Preset aliases for --tools flag. */
const TOOL_PRESETS: Record<string, readonly ToolItem[]> = {
	readonly: readOnlyTools as unknown as ToolItem[],
	coding: codingTools as unknown as ToolItem[],
	none: [],
};

/** All valid tool names and aliases for error messages. */
const VALID_TOOL_NAMES = [...Object.keys(TOOL_MAP), ...Object.keys(TOOL_PRESETS)];

/**
 * Parse a comma-separated tool names string into an array of tool objects.
 *
 * Accepts individual tool names (read, bash, edit, write, grep, find, ls)
 * and preset aliases (readonly, coding, none).
 *
 * @param toolString - Comma-separated tool names (e.g. "read,grep,find")
 * @returns Array of resolved tool objects
 * @throws Error with list of valid names when an unknown tool is specified
 */
export function parseToolFlag(toolString: string): ToolArray {
	const names = toolString
		.split(",")
		.map((n) => n.trim().toLowerCase())
		.filter(Boolean);

	if (names.length === 0) {
		return [];
	}

	// Check for preset alias (only when single value)
	if (names.length === 1 && names[0] in TOOL_PRESETS) {
		return [...TOOL_PRESETS[names[0]]];
	}

	const tools: ToolItem[] = [];
	const unknown: string[] = [];

	for (const name of names) {
		if (name in TOOL_MAP) {
			tools.push(TOOL_MAP[name]);
		} else if (name in TOOL_PRESETS) {
			tools.push(...TOOL_PRESETS[name]);
		} else {
			unknown.push(name);
		}
	}

	if (unknown.length > 0) {
		throw new Error(
			`Unknown tool(s): ${unknown.join(", ")}. Valid names: ${VALID_TOOL_NAMES.join(", ")}`
		);
	}

	return tools;
}

/**
 * Resolve the effective tool-result retention policy from layered settings.
 *
 * Precedence: global settings < project settings < runtime overrides.
 *
 * @param params - Layered settings inputs
 * @returns Resolved retention policy with validated numeric bounds
 */
export function resolveToolResultRetentionPolicy(params: {
	globalSettings?: Record<string, unknown>;
	projectSettings?: Record<string, unknown>;
	runtimeSettings?: Record<string, unknown>;
}): ToolResultRetentionPolicy {
	const globalConfig = readToolResultRetentionConfig(params.globalSettings);
	const projectConfig = readToolResultRetentionConfig(params.projectSettings);
	const runtimeConfig = readToolResultRetentionConfig(params.runtimeSettings);

	const merged = {
		...globalConfig,
		...projectConfig,
		...runtimeConfig,
	};

	return {
		enabled:
			typeof merged.enabled === "boolean"
				? merged.enabled
				: DEFAULT_TOOL_RESULT_RETENTION_POLICY.enabled,
		keepRecentToolResults: toNonNegativeInt(
			merged.keepRecentToolResults,
			DEFAULT_TOOL_RESULT_RETENTION_POLICY.keepRecentToolResults,
			500
		),
		maxRetainedBytesPerResult: toNonNegativeInt(
			merged.maxRetainedBytesPerResult,
			DEFAULT_TOOL_RESULT_RETENTION_POLICY.maxRetainedBytesPerResult,
			10 * 1024 * 1024
		),
		previewChars: toNonNegativeInt(
			merged.previewChars,
			DEFAULT_TOOL_RESULT_RETENTION_POLICY.previewChars,
			10_000
		),
	};
}

/**
 * Resolve the effective context-budget policy from layered settings.
 *
 * Precedence: global settings < project settings < runtime overrides.
 * Any unset field falls back to the compiled default.
 *
 * @param params - Layered settings inputs
 * @returns Resolved context-budget policy with validated numeric bounds
 */
export function resolveContextBudgetPolicy(params: {
	globalSettings?: Record<string, unknown>;
	projectSettings?: Record<string, unknown>;
	runtimeSettings?: Record<string, unknown>;
}): ContextBudgetPolicy {
	const globalConfig = readContextBudgetConfig(params.globalSettings);
	const projectConfig = readContextBudgetConfig(params.projectSettings);
	const runtimeConfig = readContextBudgetConfig(params.runtimeSettings);

	const merged = {
		...globalConfig,
		...projectConfig,
		...runtimeConfig,
	};

	return {
		softThresholdPercent: toNonNegativeInt(
			merged.softThresholdPercent,
			DEFAULT_CONTEXT_BUDGET_POLICY.softThresholdPercent,
			100
		),
		hardThresholdPercent: toNonNegativeInt(
			merged.hardThresholdPercent,
			DEFAULT_CONTEXT_BUDGET_POLICY.hardThresholdPercent,
			100
		),
		minPerToolBytes: toNonNegativeInt(
			merged.minPerToolBytes,
			DEFAULT_CONTEXT_BUDGET_POLICY.minPerToolBytes,
			10 * 1024 * 1024
		),
		maxPerToolBytes: toNonNegativeInt(
			merged.maxPerToolBytes,
			DEFAULT_CONTEXT_BUDGET_POLICY.maxPerToolBytes,
			10 * 1024 * 1024
		),
		perTurnReserveTokens: toNonNegativeInt(
			merged.perTurnReserveTokens,
			DEFAULT_CONTEXT_BUDGET_POLICY.perTurnReserveTokens,
			200_000
		),
		unknownUsageFallbackCapBytes: toNonNegativeInt(
			merged.unknownUsageFallbackCapBytes,
			DEFAULT_CONTEXT_BUDGET_POLICY.unknownUsageFallbackCapBytes,
			10 * 1024 * 1024
		),
	};
}

/**
 * Estimate remaining tokens available for tool output.
 *
 * When usage.tokens is null (e.g. right after compaction), returns 0
 * to signal that callers should use the unknown-usage fallback path.
 *
 * @param usage - Context usage snapshot from the framework
 * @param reserveTokens - Tokens to hold back for the model response
 * @returns Non-negative remaining token count, or 0 when unknown
 */
export function estimateRemainingTokens(
	usage: ContextUsageSnapshot,
	reserveTokens: number
): number {
	if (usage.tokens === null) return 0;
	return Math.max(0, usage.contextWindow - usage.tokens - reserveTokens);
}

/**
 * Convert a token count to an approximate byte budget.
 *
 * Uses a conservative 4-bytes-per-token heuristic suitable for English
 * text and JSON payloads. Non-Latin scripts use more bytes per token;
 * callers should treat this as an upper-bound estimate.
 *
 * @param tokens - Token count to convert
 * @returns Approximate byte budget
 */
export function tokensToBytes(tokens: number): number {
	return Math.max(0, Math.floor(tokens * 4));
}

/**
 * Build a compact one-line budget status string for system prompt injection.
 *
 * Format when known: `Context budget: 67% used, ~66k tokens remaining`
 * Format when unknown: `Context budget: unknown (waiting for fresh usage sample)`
 *
 * @param usage - Context usage snapshot
 * @param policy - Resolved context-budget policy
 * @returns Deterministic single-line status string
 */
export function formatBudgetStatusLine(
	usage: ContextUsageSnapshot,
	policy: ContextBudgetPolicy
): string {
	if (usage.tokens === null || usage.contextWindow <= 0) {
		return "Context budget: unknown (waiting for fresh usage sample)";
	}

	const pct =
		usage.percent !== null ? usage.percent : Math.round((usage.tokens / usage.contextWindow) * 100);
	const remaining = estimateRemainingTokens(usage, policy.perTurnReserveTokens);
	const remainingK = Math.max(0, Math.round(remaining / 1000));
	return `Context budget: ${pct}% used, ~${remainingK}k tokens remaining`;
}

/**
 * Return the fallback byte cap used when context usage is unknown.
 *
 * This applies after compaction or before the first LLM response when
 * the framework reports tokens as null.
 *
 * @param policy - Resolved context-budget policy
 * @returns Byte cap for unknown-usage scenarios
 */
export function unknownUsageFallbackBudget(policy: ContextBudgetPolicy): number {
	return policy.unknownUsageFallbackCapBytes;
}

/**
 * Normalize framework context-usage output into a stable snapshot.
 *
 * Missing or partial usage values are treated as unknown, which triggers
 * conservative fallback behavior in budget planning/guarding.
 *
 * @param usage - Raw usage object returned by `ctx.getContextUsage()`
 * @returns Normalized snapshot
 */
function normalizeContextUsageSnapshot(usage: unknown): ContextUsageSnapshot {
	if (!isObjectRecord(usage)) {
		return { contextWindow: 0, percent: null, tokens: null };
	}

	const contextWindow =
		typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow)
			? usage.contextWindow
			: 0;
	const tokens =
		typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
	const percent =
		typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null;

	return {
		contextWindow,
		percent,
		tokens,
	};
}

/**
 * Summarize older oversized tool results in-place while keeping the newest N full.
 *
 * This mutates the provided message objects directly. It is intended for historical
 * messages after a turn has finished, never during active tool-result synthesis.
 *
 * @param messages - Chronological message array from the active session branch
 * @param policy - Resolved retention policy
 * @returns Aggregate stats for the retention pass
 */
export function applyToolResultRetentionToMessages(
	messages: unknown[],
	policy: ToolResultRetentionPolicy
): ToolResultRetentionRunStats {
	if (!policy.enabled) {
		return {
			examinedCount: 0,
			summarizedBytes: 0,
			summarizedCount: 0,
		};
	}

	const toolResults = messages.filter(isToolResultMessageLike);
	if (toolResults.length <= policy.keepRecentToolResults) {
		return {
			examinedCount: toolResults.length,
			summarizedBytes: 0,
			summarizedCount: 0,
		};
	}

	const mutableRangeEnd = Math.max(0, toolResults.length - policy.keepRecentToolResults);
	let summarizedCount = 0;
	let summarizedBytes = 0;

	for (let i = 0; i < mutableRangeEnd; i++) {
		const result = summarizeHistoricalToolResultInPlace(toolResults[i], policy);
		if (result.wasSummarized) {
			summarizedCount += 1;
			summarizedBytes += result.originalBytes;
		}
	}

	return {
		examinedCount: toolResults.length,
		summarizedBytes,
		summarizedCount,
	};
}

/**
 * Read retention config from an arbitrary settings object.
 *
 * @param settings - Settings record that may include `toolResultRetention`
 * @returns Partial retention config when present
 */
function readToolResultRetentionConfig(
	settings: Record<string, unknown> | undefined
): ToolResultRetentionConfigInput {
	if (!settings) return {};
	const config = settings.toolResultRetention;
	return isObjectRecord(config) ? (config as ToolResultRetentionConfigInput) : {};
}

/**
 * Read context-budget config from an arbitrary settings object.
 *
 * @param settings - Settings record that may include `contextBudget`
 * @returns Partial context-budget config when present
 */
function readContextBudgetConfig(
	settings: Record<string, unknown> | undefined
): ContextBudgetConfigInput {
	if (!settings) return {};
	const config = settings.contextBudget;
	return isObjectRecord(config) ? (config as ContextBudgetConfigInput) : {};
}

/**
 * Clamp a numeric setting to a safe non-negative integer range.
 *
 * @param value - Unknown value from settings
 * @param fallback - Fallback when value is invalid
 * @param max - Maximum allowed value
 * @returns Sanitized non-negative integer
 */
function toNonNegativeInt(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(max, Math.floor(value)));
}

/**
 * Type guard for plain object records.
 *
 * @param value - Unknown value
 * @returns True when value is a non-null, non-array object
 */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Estimate UTF-8 bytes for JSON-serializable details payloads.
 *
 * @param value - Any serializable details value
 * @returns UTF-8 byte length of JSON representation, or 0 when unavailable
 */
function safeJsonByteLength(value: unknown): number {
	if (value == null) return 0;
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf-8");
	} catch {
		return 0;
	}
}

/**
 * Measure the approximate payload size for a tool result.
 *
 * @param result - Tool result message
 * @returns Content/details/total byte counts
 */
function estimateToolResultPayloadBytes(result: ToolResultMessageLike): ToolResultPayloadBytes {
	let contentBytes = 0;
	for (const block of result.content) {
		if (block.type === "text") {
			contentBytes += Buffer.byteLength(block.text ?? "", "utf-8");
			continue;
		}
		if (block.type === "image") {
			contentBytes += Buffer.byteLength(block.data ?? "", "utf-8");
			contentBytes += Buffer.byteLength(block.mimeType ?? "", "utf-8");
		}
	}

	const detailsBytes = safeJsonByteLength(result.details);
	return {
		contentBytes,
		detailsBytes,
		totalBytes: contentBytes + detailsBytes,
	};
}

/**
 * Check whether a tool result was already summarized by retention.
 *
 * @param details - Tool result details payload
 * @returns True when details include the retention marker
 */
function isRetentionSummarized(details: unknown): boolean {
	if (!isObjectRecord(details)) return false;
	return details[TOOL_RESULT_RETENTION_MARKER] === true;
}

/**
 * Build a concise preview from a tool-result content array.
 *
 * @param content - Tool result content blocks
 * @param maxChars - Maximum preview length
 * @returns Truncated textual preview suitable for summary output
 */
function buildToolResultPreview(
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
	maxChars: number
): string {
	if (maxChars <= 0) return "[preview disabled]";

	let preview = "";
	for (const block of content) {
		if (block.type === "text") {
			preview += block.text ?? "";
		} else if (block.type === "image") {
			const mime = block.mimeType ?? "image/unknown";
			preview += `\n[Image output omitted: ${mime}]\n`;
		}

		if (preview.length >= maxChars) break;
	}

	const normalized = preview.trim();
	if (normalized.length === 0) return "[no textual output]";
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}…`;
}

/**
 * Render byte counts in a short human-friendly format.
 *
 * @param value - Byte count
 * @returns Formatted size string (e.g. 12.4KB)
 */
function formatBytesForSummary(value: number): string {
	if (value < 1024) return `${value}B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
	return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Summarize one historical tool result in-place when policy thresholds are exceeded.
 *
 * @param result - Tool result to inspect and possibly mutate
 * @param policy - Resolved retention policy
 * @returns Whether summarization happened and original payload bytes
 */
function summarizeHistoricalToolResultInPlace(
	result: ToolResultMessageLike,
	policy: ToolResultRetentionPolicy
): { originalBytes: number; wasSummarized: boolean } {
	if (isRetentionSummarized(result.details)) {
		return { originalBytes: 0, wasSummarized: false };
	}

	const sizes = estimateToolResultPayloadBytes(result);
	if (sizes.totalBytes <= policy.maxRetainedBytesPerResult) {
		return { originalBytes: 0, wasSummarized: false };
	}

	const preview = buildToolResultPreview(result.content, policy.previewChars);
	const status = result.isError ? "error" : "ok";
	const summaryText = [
		`[summarized historical tool result]`,
		`tool: ${result.toolName} (${status})`,
		`original payload: ${formatBytesForSummary(sizes.totalBytes)}`,
		"",
		preview,
		"",
		"[full payload cleared by toolResultRetention policy to reduce long-session memory]",
	].join("\n");

	const markerDetails: ToolResultRetentionMarkerDetails = {
		[TOOL_RESULT_RETENTION_MARKER]: true,
		contentBytes: sizes.contentBytes,
		detailsBytes: sizes.detailsBytes,
		originalBytes: sizes.totalBytes,
		summarizedAt: new Date().toISOString(),
		summaryChars: summaryText.length,
	};

	result.content = [{ type: "text", text: summaryText }];
	result.details = markerDetails;

	return {
		originalBytes: sizes.totalBytes,
		wasSummarized: true,
	};
}

/**
 * Narrow unknown messages to tool-result messages.
 *
 * @param value - Candidate message object
 * @returns True when value matches the minimal toolResult shape used by retention
 */
function isToolResultMessageLike(value: unknown): value is ToolResultMessageLike {
	if (!isObjectRecord(value)) return false;
	if (value.role !== "toolResult") return false;
	if (typeof value.toolCallId !== "string") return false;
	if (typeof value.toolName !== "string") return false;
	if (typeof value.isError !== "boolean") return false;
	if (typeof value.timestamp !== "number") return false;
	return Array.isArray(value.content);
}

export interface TallowSession {
	/** The underlying AgentSession */
	session: CreateAgentSessionResult["session"];

	/** Extension loading results */
	extensions: CreateAgentSessionResult["extensionsResult"];

	/** Model fallback message (if session model couldn't be restored) */
	modelFallbackMessage?: string;

	/** Tallow version */
	version: string;

	/** Bundled extensions overridden by user extensions (name → user path) */
	extensionOverrides: Array<{ name: string; userPath: string }>;

	/** Resolved plugins (remote + local) */
	resolvedPlugins: ResolvedPlugin[];

	/** Session ID (UUID or user-provided) for programmatic chaining */
	sessionId: string;
}

/** Catalog entry for a bundled extension shipped with tallow. */
export interface BundledExtensionCatalogEntry {
	/** Extension category from extension.json (if declared). */
	readonly category?: string;
	/** Human-readable extension description (if declared). */
	readonly description?: string;
	/** Stable extension identifier (directory name). */
	readonly id: string;
	/** Parsed extension manifest (null when missing/invalid). */
	readonly manifest: TallowExtensionManifest | null;
	/** Absolute extension directory path. */
	readonly path: string;
}

/** Result of resolving a CLI extension selector into a concrete path. */
export interface ExtensionSelectorResolution {
	/** Canonical extension ID for bundled selectors. */
	readonly id?: string;
	/** Original selector string from CLI/options. */
	readonly selector: string;
	/** Resolution source. */
	readonly source: "bundled" | "path";
	/** Absolute extension path passed into the resource loader. */
	readonly path: string;
}

/** Number of bundled extension IDs to include in unknown-ID errors. */
const EXTENSION_ID_SUGGESTION_LIMIT = 10;

/** Startup timing milestones emitted when timing instrumentation is enabled. */
type StartupTimingStage = "create-session" | "bind-extensions" | "first-token";

/** Runtime state for startup timing instrumentation. */
interface StartupTimingLogger {
	readonly enabled: boolean;
	mark(stage: StartupTimingStage, stageStartedAtMs?: number): void;
}

/** Options for startup-time extension filtering policies. */
interface ExtensionStartupPolicyOptions {
	readonly blockProjectExtensions: boolean;
	readonly projectExtensionsDir: string;
	readonly startupProfile: TallowStartupProfile;
}

/**
 * Return all bundled extension manifests keyed by extension directory name.
 *
 * @param bundledExtensionsDir - Optional bundled extensions directory override
 * @returns Sorted bundled extension catalog entries
 */
export function getBundledExtensionCatalog(
	bundledExtensionsDir = BUNDLED.extensions
): BundledExtensionCatalogEntry[] {
	const entries = discoverExtensionDirs(bundledExtensionsDir)
		.filter((fullPath) => {
			try {
				return statSync(fullPath).isDirectory();
			} catch {
				return false;
			}
		})
		.map((fullPath) => {
			const id = basename(fullPath);
			const manifest = readPluginManifest(
				fullPath,
				"tallow-extension"
			) as TallowExtensionManifest | null;

			return {
				category: manifest?.category,
				description: manifest?.description,
				id,
				manifest,
				path: fullPath,
			};
		})
		.sort((a, b) => a.id.localeCompare(b.id));

	return entries;
}

/**
 * Resolve a single extension selector (bundled ID or filesystem path).
 *
 * Selector resolution order:
 * 1. Explicit path selectors (`./`, `../`, `/`, `~`, or with path separators)
 * 2. Bundled extension IDs (directory names under bundled extensions)
 * 3. Existing cwd-relative paths for backward compatibility
 *
 * @param selector - Raw selector string from CLI/SDK options
 * @param options - Resolution options
 * @returns Resolved selector with absolute extension path
 * @throws Error when selector is empty, path is missing, or ID is unknown
 */
export function resolveExtensionSelector(
	selector: string,
	options: {
		bundledExtensionsDir?: string;
		cwd?: string;
		catalog?: readonly BundledExtensionCatalogEntry[];
	} = {}
): ExtensionSelectorResolution {
	const trimmedSelector = selector.trim();
	if (!trimmedSelector) {
		throw new Error("Extension selector cannot be empty.");
	}

	const cwd = options.cwd ?? process.cwd();
	const explicitPath = isLikelyPathSelector(trimmedSelector);
	if (explicitPath) {
		const resolvedPath = resolveExtensionPath(trimmedSelector, cwd);
		if (!existsSync(resolvedPath)) {
			throw new Error(`Extension path not found: ${selector}`);
		}
		return {
			path: resolvedPath,
			selector,
			source: "path",
		};
	}

	const catalog = options.catalog ?? getBundledExtensionCatalog(options.bundledExtensionsDir);
	const bundledMatch = catalog.find((entry) => entry.id === trimmedSelector);
	if (bundledMatch) {
		return {
			id: bundledMatch.id,
			path: bundledMatch.path,
			selector,
			source: "bundled",
		};
	}

	const compatibilityPath = resolveExtensionPath(trimmedSelector, cwd);
	if (existsSync(compatibilityPath)) {
		return {
			path: compatibilityPath,
			selector,
			source: "path",
		};
	}

	const suggestions = catalog
		.slice(0, EXTENSION_ID_SUGGESTION_LIMIT)
		.map((entry) => entry.id)
		.join(", ");

	throw new Error(
		`Unknown extension ID: "${selector}". ` +
			`Run \`tallow extensions\` for all IDs or pass a path (e.g. ./my-extension). ` +
			(suggestions ? `Known IDs include: ${suggestions}` : "")
	);
}

/**
 * Resolve many extension selectors into deduplicated absolute paths.
 *
 * @param selectors - Extension selectors from CLI/SDK options
 * @param options - Resolution options
 * @returns Ordered unique resolved extension paths
 */
export function resolveExtensionSelectors(
	selectors: readonly string[] | undefined,
	options: {
		bundledExtensionsDir?: string;
		cwd?: string;
		catalog?: readonly BundledExtensionCatalogEntry[];
	} = {}
): string[] {
	if (!selectors || selectors.length === 0) {
		return [];
	}

	const resolved = selectors.map((selector) => resolveExtensionSelector(selector, options).path);
	return [...new Set(resolved)];
}

/**
 * Check whether an extension selector should be interpreted as a path.
 *
 * @param selector - Selector string to classify
 * @returns True when selector is an explicit filesystem path expression
 */
function isLikelyPathSelector(selector: string): boolean {
	return (
		selector.startsWith("./") ||
		selector.startsWith("../") ||
		selector.startsWith("/") ||
		selector.startsWith("~") ||
		selector.includes("/") ||
		selector.includes("\\")
	);
}

/**
 * Resolve a path selector to an absolute filesystem path.
 *
 * @param selector - Path-like selector
 * @param cwd - Base directory for relative selectors
 * @returns Absolute path
 */
function resolveExtensionPath(selector: string, cwd: string): string {
	if (selector === "~") {
		return homedir();
	}

	if (selector.startsWith("~/")) {
		return resolve(homedir(), selector.slice(2));
	}

	return resolve(cwd, selector);
}

// ─── Skill Name Normalization ────────────────────────────────────────────────

/**
 * Normalize all skill names to their parent directory name.
 *
 * The directory name is the canonical skill identifier — Claude Code works
 * the same way. The frontmatter `name` field is treated as a display hint,
 * not an identifier. This strips name-related diagnostics from the framework
 * which validates frontmatter `name` against the Agent Skills spec.
 *
 * @param result - Skills and diagnostics from loadSkills
 * @returns Skills with directory-based names and filtered diagnostics
 */
function normalizeSkillNames<D extends { message: string }>(result: {
	skills: Skill[];
	diagnostics: D[];
}): { skills: Skill[]; diagnostics: D[] } {
	const skills = result.skills.map((skill) => {
		const dirName = basename(dirname(skill.filePath));
		if (skill.name === dirName) return skill;
		return { ...skill, name: dirName };
	});

	const diagnostics = result.diagnostics.filter(
		(d) =>
			!d.message.includes("does not match parent directory") &&
			!d.message.includes("invalid characters")
	);

	return { skills, diagnostics };
}

/**
 * Create a startup timing logger controlled by `TALLOW_STARTUP_TIMING`.
 *
 * @param startupProfile - Active startup profile for log context
 * @returns Startup timing logger (no-op when disabled)
 */
function createStartupTimingLogger(startupProfile: TallowStartupProfile): StartupTimingLogger {
	const enabled = isStartupTimingEnabled();
	const startupStartedAtMs = Date.now();
	const emittedStages = new Set<StartupTimingStage>();

	return {
		enabled,
		mark(stage, stageStartedAtMs) {
			if (!enabled || emittedStages.has(stage)) {
				return;
			}

			emittedStages.add(stage);
			const nowMs = Date.now();
			emitStartupTiming(stage, nowMs - startupStartedAtMs, {
				phaseMilliseconds: stageStartedAtMs === undefined ? undefined : nowMs - stageStartedAtMs,
				profile: startupProfile,
			});
		},
	};
}

/**
 * Check whether an assistant stream event represents token emission.
 *
 * @param assistantEventType - Assistant stream event type string
 * @returns True for delta events that indicate model output has started
 */
function isTokenDeltaEventType(assistantEventType: string): boolean {
	return (
		assistantEventType === "text_delta" ||
		assistantEventType === "thinking_delta" ||
		assistantEventType === "toolcall_delta"
	);
}

/**
 * Attach startup timing instrumentation for bind-extensions and first-token milestones.
 *
 * @param session - Agent session instance returned from createAgentSession
 * @param timing - Startup timing logger
 * @returns Nothing
 */
function instrumentSessionStartupTimings(
	session: CreateAgentSessionResult["session"],
	timing: StartupTimingLogger
): void {
	if (!timing.enabled) {
		return;
	}

	let bindExtensionsLogged = false;
	const originalBindExtensions = session.bindExtensions.bind(session);
	session.bindExtensions = async (bindings) => {
		const bindStartedAtMs = Date.now();
		try {
			await originalBindExtensions(bindings);
		} finally {
			if (!bindExtensionsLogged) {
				bindExtensionsLogged = true;
				timing.mark("bind-extensions", bindStartedAtMs);
			}
		}
	};

	let unsubscribeFirstToken: (() => void) | undefined;
	unsubscribeFirstToken = session.subscribe((event) => {
		if (event.type !== "message_update") {
			return;
		}
		if (!isTokenDeltaEventType(event.assistantMessageEvent.type)) {
			return;
		}

		timing.mark("first-token");
		unsubscribeFirstToken?.();
		unsubscribeFirstToken = undefined;
	});
}

/**
 * Check whether an extension path belongs to project-local `.tallow/extensions`.
 *
 * @param extensionPath - Candidate extension path
 * @param projectExtensionsDir - Canonical project extensions directory
 * @returns True when extensionPath points to the project extensions tree
 */
function isProjectExtensionPath(extensionPath: string, projectExtensionsDir: string): boolean {
	const normalizedPath = resolve(extensionPath);
	return (
		normalizedPath === projectExtensionsDir ||
		normalizedPath.startsWith(`${projectExtensionsDir}${sep}`)
	);
}

/**
 * Determine whether an extension is a purely interactive UI extension in headless mode.
 *
 * Tool availability is always preserved: extensions that register tools at runtime,
 * or declare tools in extension.json, are never skipped.
 *
 * @param extensionPath - Absolute path to the extension directory or file
 * @param runtimeToolCount - Number of tools registered by the loaded extension
 * @returns True when the extension should be skipped in headless mode
 */
function shouldSkipInteractiveUiExtensionInHeadless(
	extensionPath: string,
	runtimeToolCount: number
): boolean {
	if (runtimeToolCount > 0) {
		return false;
	}

	const manifest = readPluginManifest(
		extensionPath,
		"tallow-extension"
	) as TallowExtensionManifest | null;
	if (!manifest) {
		return false;
	}

	const declaredToolCount = manifest.capabilities?.tools?.length ?? 0;
	if (declaredToolCount > 0) {
		return false;
	}

	return manifest.category?.toLowerCase() === "ui";
}

/**
 * Apply startup-time extension filtering policies for trust and headless mode.
 *
 * @param base - Loaded extension result from the framework resource loader
 * @param options - Startup policy options
 * @returns Filtered extension result with original ordering preserved
 */
function applyExtensionStartupPolicies(
	base: LoadExtensionsResult,
	options: ExtensionStartupPolicyOptions
): LoadExtensionsResult {
	let filteredExtensions = base.extensions;
	let changed = false;

	if (options.blockProjectExtensions) {
		const blocked = filteredExtensions.filter(
			(ext) => !isProjectExtensionPath(ext.path, options.projectExtensionsDir)
		);
		if (blocked.length !== filteredExtensions.length) {
			filteredExtensions = blocked;
			changed = true;
		}
	}

	if (options.startupProfile === "headless") {
		const policyFiltered = filteredExtensions.filter(
			(ext) => !shouldSkipInteractiveUiExtensionInHeadless(ext.path, ext.tools.size)
		);
		if (policyFiltered.length !== filteredExtensions.length) {
			filteredExtensions = policyFiltered;
			changed = true;
		}
	}

	if (!changed) {
		return base;
	}

	return {
		...base,
		extensions: filteredExtensions,
	};
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Tallow session with all bundled extensions, skills, prompts,
 * and agents pre-loaded. This is the main SDK entry point.
 *
 * ```typescript
 * import { createTallowSession } from "tallow";
 *
 * const { session } = await createTallowSession();
 *
 * session.subscribe((event) => {
 *   if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
 *     process.stdout.write(event.assistantMessageEvent.delta);
 *   }
 * });
 *
 * await session.prompt("Fix the failing tests");
 * ```
 */
export async function createTallowSession(
	options: TallowSessionOptions = {}
): Promise<TallowSession> {
	const startupProfile = normalizeStartupProfile(options.startupProfile);
	const startupTiming = createStartupTimingLogger(startupProfile);
	const createSessionStartedAtMs = Date.now();

	// Ensure env is configured before any framework internals resolve paths
	bootstrap();
	ensureTallowHome(startupProfile);
	if (startupProfile === "interactive") {
		await applyInteractiveModeStaleUiPatch();
	}
	await applyAgentSessionCompactionCancelPatch();

	// Resolve any op:// secrets not loaded from cache during bootstrap.
	// Runs in parallel (~2.4s for all) instead of sequential (~2.4s each).
	await resolveOpSecrets();

	const cwd = options.cwd ?? process.cwd();
	const tallowHome = getRuntimeTallowHome();
	const projectTrust = resolveProjectTrust(cwd);
	applyProjectTrustContextToEnv(projectTrust);
	const eventBus = createEventBus();

	// ── Auth & Models ────────────────────────────────────────────────────────

	const authPath = join(tallowHome, "auth.json");
	const { authStorage, migration } = createSecureAuthStorage(authPath);
	if (migration.migratedProviders.length > 0) {
		console.error(
			`\x1b[33m🔐 Migrated ${migration.migratedProviders.length} auth credential(s) to secure references: ${migration.migratedProviders.join(", ")}\x1b[0m`
		);
	}
	const modelRegistry = new ModelRegistry(authStorage, join(tallowHome, "models.json"));

	// ── Runtime API key (not persisted) ──────────────────────────────────────
	// Accepts programmatic SDK `apiKey` option or env overrides:
	// TALLOW_API_KEY (raw) or TALLOW_API_KEY_REF (reference).
	// The CLI --api-key flag was removed to prevent secret leaks in process args.

	const runtimeApiKey = options.apiKey ?? resolveRuntimeApiKeyFromEnv();
	if (runtimeApiKey) {
		const keyProvider = options.provider ?? options.model?.provider;
		if (!keyProvider) {
			throw new Error(
				"API key provided (via options, TALLOW_API_KEY, or TALLOW_API_KEY_REF) but no provider specified. " +
					"Set --provider or --model."
			);
		}
		authStorage.setRuntimeApiKey(keyProvider, runtimeApiKey);
	}

	// ── Settings ─────────────────────────────────────────────────────────────

	const settingsManager = SettingsManager.create(cwd, tallowHome);
	if (options.settings) {
		settingsManager.applyOverrides(options.settings);
	}

	if (projectTrust.status !== "trusted") {
		const globalPackages = settingsManager.getGlobalSettings().packages;
		settingsManager.applyOverrides({
			packages: (Array.isArray(globalPackages) ? globalPackages : []) as Array<
				string | { source: string }
			>,
		});
	}

	const toolResultRetentionPolicy = resolveToolResultRetentionPolicy({
		globalSettings: settingsManager.getGlobalSettings() as Record<string, unknown>,
		projectSettings: settingsManager.getProjectSettings() as Record<string, unknown>,
		runtimeSettings: options.settings,
	});

	const contextBudgetPolicy = resolveContextBudgetPolicy({
		globalSettings: settingsManager.getGlobalSettings() as Record<string, unknown>,
		projectSettings: settingsManager.getProjectSettings() as Record<string, unknown>,
		runtimeSettings: options.settings,
	});

	// ── Resource Loader ──────────────────────────────────────────────────────

	const additionalExtensionPaths: string[] = [];
	const additionalSkillPaths: string[] = [];
	const additionalPromptPaths: string[] = [];
	const additionalThemePaths: string[] = [];
	const extensionsOnly = options.extensionsOnly === true;

	// Track bundled extensions overridden by user extensions
	const extensionOverrides: Array<{ name: string; userPath: string }> = [];

	// Bundled resources from the package
	if (!extensionsOnly && !options.noBundledExtensions && existsSync(BUNDLED.extensions)) {
		// Discover user extensions that might override bundled ones
		const userExtDir = join(tallowHome, "extensions");
		const userExtNames = new Set<string>();
		const userExtPaths = new Map<string, string>();
		if (existsSync(userExtDir)) {
			for (const name of discoverExtensionDirs(userExtDir)) {
				const extName = basename(name);
				userExtNames.add(extName);
				userExtPaths.set(extName, name);
			}
		}

		// Add bundled extensions, skipping any overridden by user versions
		for (const bundledPath of discoverExtensionDirs(BUNDLED.extensions)) {
			const name = basename(bundledPath);
			if (userExtNames.has(name)) {
				extensionOverrides.push({ name, userPath: userExtPaths.get(name) ?? name });
			} else {
				additionalExtensionPaths.push(bundledPath);
			}
		}
	}
	if (!options.noBundledSkills && existsSync(BUNDLED.skills)) {
		additionalSkillPaths.push(BUNDLED.skills);
	}
	if (existsSync(BUNDLED.themes)) {
		additionalThemePaths.push(BUNDLED.themes);
	}

	// User-provided selectors (bundled IDs or filesystem paths)
	if (options.additionalExtensions) {
		additionalExtensionPaths.push(
			...resolveExtensionSelectors(options.additionalExtensions, {
				cwd,
			})
		);
	}

	// ── Plugin Resolution ────────────────────────────────────────────────────
	// Resolve plugins from settings + CLI options. Remote plugins are fetched
	// and cached; local plugins are loaded live from disk.
	//
	// In extensionsOnly mode we skip plugin-driven extension auto-loading so
	// only explicitly selected --extension selectors are loaded.

	const resolvedPlugins: ResolvedPlugin[] = [];
	if (!extensionsOnly) {
		const pluginSpecs = collectPluginSpecs(cwd, options.plugins, projectTrust.status, tallowHome);
		const pluginResult = resolvePlugins(pluginSpecs);

		// Report plugin errors (non-fatal — one bad plugin doesn't block startup)
		for (const { spec, error } of pluginResult.errors) {
			console.error(`\x1b[33m⚠ Plugin "${spec}": ${error}\x1b[0m`);
		}

		resolvedPlugins.push(...pluginResult.resolved);
		const pluginCommandsDirs: string[] = [];
		const pluginAgentsDirs: string[] = [];

		for (const plugin of resolvedPlugins) {
			switch (plugin.format) {
				case "tallow-extension":
					// Tallow extensions go through the standard extension loader
					additionalExtensionPaths.push(plugin.path);
					break;

				case "claude-code": {
					// Claude Code plugins: extract resources and feed into loaders
					const resources = extractClaudePluginResources(plugin.path);
					if (resources.skillPaths.length > 0) {
						additionalSkillPaths.push(...resources.skillPaths);
					}
					if (resources.commandsDir) {
						pluginCommandsDirs.push(resources.commandsDir);
					}
					if (resources.agentsDir) {
						pluginAgentsDirs.push(resources.agentsDir);
					}
					break;
				}

				case "unknown":
					console.error(
						`\x1b[33m⚠ Plugin "${plugin.spec.raw}": unrecognized format ` +
							`(expected .claude-plugin/plugin.json or extension.json)\x1b[0m`
					);
					break;
			}
		}

		// Expose plugin commands/agents dirs as env vars for the command-prompt
		// and agent-commands-tool extensions to discover at runtime.
		setPathListEnv("TALLOW_PLUGIN_COMMANDS_DIRS", pluginCommandsDirs);
		setPathListEnv("TALLOW_PLUGIN_AGENTS_DIRS", pluginAgentsDirs);
	}

	// ── Package AGENTS.md loading ────────────────────────────────────────────
	// Packages contribute extensions, skills, prompts, themes — but the framework
	// doesn't load AGENTS.md from packages. Use agentsFilesOverride to inject them.

	const packageAgentsFiles = loadAgentsFilesFromPackages(settingsManager, cwd);
	const projectExtensionsDir = resolve(cwd, ".tallow", "extensions");
	const shouldBlockProjectExtensions = projectTrust.status !== "trusted";

	if (projectTrust.status !== "trusted") {
		console.error(
			"\x1b[33m⚠ Project is untrusted — repo-controlled execution surfaces are blocked until /trust-project\x1b[0m"
		);
	}

	const dedupedExtensionPaths = [...new Set(additionalExtensionPaths)];
	const shouldApplyExtensionStartupPolicies =
		shouldBlockProjectExtensions || startupProfile === "headless";

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: tallowHome,
		settingsManager,
		eventBus,
		additionalExtensionPaths: dedupedExtensionPaths,
		additionalSkillPaths,
		additionalPromptTemplatePaths: additionalPromptPaths,
		additionalThemePaths,
		extensionFactories: [
			createRebrandSystemPromptExtension(contextBudgetPolicy),
			injectImageFilePaths,
			createToolResultRetentionExtension(toolResultRetentionPolicy, contextBudgetPolicy),
			createContextBudgetPlannerExtension(contextBudgetPolicy),
			detectOutputTruncation,
			createProjectTrustExtension(cwd, projectTrust),
			...(options.extensionFactories ?? []),
		],
		noExtensions: extensionsOnly,
		extensionsOverride: shouldApplyExtensionStartupPolicies
			? (base) =>
					applyExtensionStartupPolicies(base, {
						blockProjectExtensions: shouldBlockProjectExtensions,
						projectExtensionsDir,
						startupProfile,
					})
			: undefined,
		systemPromptOverride: options.systemPrompt ? () => options.systemPrompt : undefined,
		appendSystemPromptOverride: options.appendSystemPrompt
			? (base) => {
					const append = options.appendSystemPrompt;
					return append ? [...base, append] : base;
				}
			: undefined,
		agentsFilesOverride:
			packageAgentsFiles.length > 0
				? (base) => ({
						agentsFiles: [...base.agentsFiles, ...packageAgentsFiles],
					})
				: undefined,
		skillsOverride: (base) => {
			const normalized = normalizeSkillNames(base);
			const extra = options.additionalSkills;
			return {
				skills: extra ? [...normalized.skills, ...extra] : normalized.skills,
				diagnostics: normalized.diagnostics,
			};
		},
		promptsOverride: options.additionalPrompts
			? (base) => {
					const extra = options.additionalPrompts;
					return {
						prompts: extra ? [...base.prompts, ...extra] : base.prompts,
						diagnostics: base.diagnostics,
					};
				}
			: undefined,
	});

	await loader.reload();

	// ── Session Manager ──────────────────────────────────────────────────────

	let sessionManager: SessionManager;
	const sessionOpt = options.session ?? { type: "new" };

	switch (sessionOpt.type) {
		case "memory":
			sessionManager = SessionManager.inMemory();
			break;
		case "new":
			sessionManager = SessionManager.create(cwd);
			break;
		case "continue":
			sessionManager = SessionManager.continueRecent(cwd);
			break;
		case "open":
			sessionManager = SessionManager.open(sessionOpt.path);
			break;
		case "open-or-create": {
			const existing = findSessionById(sessionOpt.sessionId, cwd);
			sessionManager = existing
				? SessionManager.open(existing)
				: createSessionWithId(sessionOpt.sessionId, cwd);
			break;
		}
		case "resume": {
			const existing = findSessionById(sessionOpt.sessionId, cwd);
			if (!existing) {
				throw new Error(`Session not found: ${sessionOpt.sessionId}`);
			}
			sessionManager = SessionManager.open(existing);
			break;
		}
		case "fork": {
			const source = findSessionById(sessionOpt.sourceSessionId, cwd);
			if (!source) {
				throw new Error(`Source session not found: ${sessionOpt.sourceSessionId}`);
			}
			sessionManager = SessionManager.forkFrom(source, cwd);
			break;
		}
	}

	// ── Model resolution (string → Model object) ────────────────────────────

	let resolvedModel = options.model;
	if (!resolvedModel && options.provider) {
		const modelId = options.modelId ?? settingsManager.getDefaultModel();
		if (modelId) {
			resolvedModel = modelRegistry.find(options.provider, modelId) ?? undefined;
			if (!resolvedModel) {
				throw new Error(`Model ${options.provider}/${modelId} not found`);
			}
		} else {
			// Provider without model: find any available model for this provider
			const available = modelRegistry.getAll().filter((m) => m.provider === options.provider);
			if (available.length === 0) {
				throw new Error(`No models found for provider "${options.provider}"`);
			}
			resolvedModel = available[0];
		}
	}

	// ── Create Session ───────────────────────────────────────────────────────

	const result = await createAgentSession({
		cwd,
		agentDir: tallowHome,
		model: resolvedModel,
		thinkingLevel: options.thinkingLevel,
		authStorage,
		modelRegistry,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
		tools: options.tools,
		customTools: options.customTools,
	});

	startupTiming.mark("create-session", createSessionStartedAtMs);
	instrumentSessionStartupTimings(result.session, startupTiming);

	return {
		session: result.session,
		extensions: result.extensionsResult,
		modelFallbackMessage: result.modelFallbackMessage,
		version: TALLOW_VERSION,
		extensionOverrides,
		resolvedPlugins,
		sessionId: sessionManager.getSessionId(),
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Plugin Spec Collection ──────────────────────────────────────────────────

/**
 * Collect plugin specs from settings files and CLI options.
 *
 * Reads the `plugins` array from global settings and, when trusted, from
 * project `.tallow/settings.json`, then merges in any CLI-provided specs.
 * Deduplicates by raw spec string.
 *
 * Project `.pi/settings.json` plugin entries are intentionally ignored.
 *
 * @param cwd - Current working directory (for project settings)
 * @param cliPlugins - Additional plugin specs from CLI --plugin-dir or options.plugins
 * @param trustStatus - Current project trust status
 * @param tallowHome - Optional tallow home override for settings lookup (defaults to runtime TALLOW_HOME)
 * @returns Deduplicated array of plugin spec strings
 */
export function collectPluginSpecs(
	cwd: string,
	cliPlugins: string[] | undefined,
	trustStatus: ProjectTrustStatus,
	tallowHome = getRuntimeTallowHome()
): string[] {
	const specs = new Set<string>();

	// Read plugins from global settings and trusted project settings.
	const settingsFiles = [join(tallowHome, "settings.json")];
	if (trustStatus === "trusted") {
		settingsFiles.push(join(cwd, ".tallow", "settings.json"));
	}

	for (const settingsPath of settingsFiles) {
		try {
			const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (Array.isArray(content.plugins)) {
				for (const p of content.plugins) {
					if (typeof p === "string") specs.add(p);
				}
			}
		} catch {
			// File doesn't exist or isn't valid JSON — skip
		}
	}

	// CLI-provided plugins
	if (cliPlugins) {
		for (const p of cliPlugins) {
			specs.add(p);
		}
	}

	return [...specs];
}

/**
 * Replace a path-list env var using platform delimiter.
 *
 * Each session writes its own exact plugin resource set so stale values from
 * earlier sessions cannot leak into later ones in the same long-lived process.
 *
 * @param key - Environment variable key
 * @param values - Absolute directory paths to store
 * @param env - Environment object to mutate (defaults to process.env)
 * @returns Nothing
 */
export function setPathListEnv(
	key: string,
	values: readonly string[],
	env: NodeJS.ProcessEnv = process.env
): void {
	const deduped = [...new Set(values.filter((value) => value.length > 0))];
	if (deduped.length === 0) {
		delete env[key];
		return;
	}
	env[key] = deduped.join(delimiter);
}

/** Context file loaded from a package directory. */
interface AgentsFile {
	path: string;
	content: string;
}

/**
 * Load AGENTS.md files from installed packages.
 *
 * The framework's PackageManager loads extensions, skills, prompts, and themes
 * from packages — but not AGENTS.md. This fills the gap by resolving each
 * package source, finding its root directory, and loading AGENTS.md if present.
 *
 * Handles local paths (~/..., /..., ./...), npm packages (installed under
 * agentDir/node_modules), and git packages (installed under agentDir/packages).
 *
 * @param settingsManager - Settings manager with package list
 * @param cwd - Current working directory for resolving relative paths
 * @returns Array of { path, content } for each package AGENTS.md found
 */
function loadAgentsFilesFromPackages(settingsManager: SettingsManager, cwd: string): AgentsFile[] {
	const packages = settingsManager.getPackages();
	if (packages.length === 0) return [];

	// Use a PackageManager to resolve installed paths for all source types
	const pkgManager = new DefaultPackageManager({
		cwd,
		agentDir: getRuntimeTallowHome(),
		settingsManager,
	});

	const files: AgentsFile[] = [];
	const seen = new Set<string>();

	for (const pkg of packages) {
		const source = typeof pkg === "string" ? pkg : pkg.source;

		// Try both user and project scopes. parseSource inside getInstalledPath
		// can throw for malformed sources — skip gracefully.
		let installedPath: string | undefined;
		try {
			installedPath =
				pkgManager.getInstalledPath(source, "user") ??
				pkgManager.getInstalledPath(source, "project");
		} catch {
			continue;
		}

		if (!installedPath) continue;

		const agentsPath = join(installedPath, "AGENTS.md");
		if (seen.has(agentsPath)) continue;
		seen.add(agentsPath);

		if (!existsSync(agentsPath)) continue;

		try {
			const content = readFileSync(agentsPath, "utf-8");
			files.push({ path: agentsPath, content });
		} catch {
			// Unreadable — skip silently
		}
	}

	return files;
}

/**
 * Discover extension subdirectories — each dir with an index.ts is an extension.
 * Also picks up standalone .ts files.
 */
function discoverExtensionDirs(baseDir: string): string[] {
	const paths: string[] = [];
	try {
		for (const entry of readdirSync(baseDir)) {
			if (entry.startsWith(".")) continue;
			const full = join(baseDir, entry);
			const stat = statSync(full);
			if (stat.isDirectory() && existsSync(join(full, "index.ts"))) {
				paths.push(full);
			} else if (stat.isFile() && entry.endsWith(".ts")) {
				paths.push(full);
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}
	return paths;
}

/**
 * Register trust commands and startup banner for project trust UX.
 *
 * @param cwd - Session working directory
 * @param initialTrust - Trust context resolved at startup
 * @returns Extension factory
 */
function createProjectTrustExtension(
	cwd: string,
	initialTrust: ProjectTrustContext
): ExtensionFactory {
	return (pi) => {
		let currentCwd = cwd;
		let trustContext = initialTrust;

		/**
		 * Re-resolve trust for the active cwd and project it into env.
		 *
		 * @param nextCwd - Working directory whose trust state should become active
		 * @returns Refreshed trust context
		 */
		const syncTrustContext = (nextCwd: string): ProjectTrustContext => {
			currentCwd = nextCwd;
			trustContext = resolveProjectTrust(currentCwd);
			applyProjectTrustContextToEnv(trustContext);
			return trustContext;
		};

		const trustApi = {
			inspect(targetCwd: string): ProjectTrustContext {
				return resolveProjectTrust(targetCwd);
			},
			trust(targetCwd: string): ProjectTrustContext {
				const nextTrust = trustProject(targetCwd);
				if (nextTrust.canonicalCwd === trustContext.canonicalCwd) {
					applyProjectTrustContextToEnv(nextTrust);
					trustContext = nextTrust;
				}
				return nextTrust;
			},
		};

		const publishTrustApi = (): void => {
			pi.events.emit(PROJECT_TRUST_API_CHANNELS.api, { api: trustApi });
		};

		pi.events.on(PROJECT_TRUST_API_CHANNELS.apiRequest, publishTrustApi);
		publishTrustApi();

		pi.events.on("tallow:cwd_changed", (payload: unknown) => {
			if (!payload || typeof payload !== "object") return;
			const nextCwd = (payload as { cwd?: unknown }).cwd;
			if (typeof nextCwd !== "string" || nextCwd.length === 0) return;
			syncTrustContext(nextCwd);
		});

		pi.on("session_start", async (_event, ctx) => {
			const currentTrust = syncTrustContext(currentCwd);
			if (!ctx.hasUI) return;
			if (currentTrust.status === "trusted") return;

			const banner = buildProjectTrustBannerPayload(currentTrust);
			ctx.ui.notify(banner.content, "warning");
			pi.sendMessage(
				{
					customType: "project-trust-banner",
					content: banner.content,
					display: true,
					details: banner.details,
				},
				{ deliverAs: "nextTurn" }
			);
		});

		pi.registerCommand("trust-project", {
			description: "Trust this project and enable repo-controlled execution surfaces",
			handler: async (_args, ctx) => {
				currentCwd = process.cwd();
				trustContext = trustProject(currentCwd);
				applyProjectTrustContextToEnv(trustContext);
				ctx.ui.setWorkingMessage("Reloading workspace after trust change...");
				try {
					await ctx.reload();
				} finally {
					ctx.ui.setWorkingMessage();
				}
				ctx.ui.notify(`Trusted project: ${trustContext.canonicalCwd}`, "info");
			},
		});

		pi.registerCommand("untrust-project", {
			description: "Remove trust for this project and block repo-controlled execution surfaces",
			handler: async (_args, ctx) => {
				currentCwd = process.cwd();
				trustContext = untrustProject(currentCwd);
				applyProjectTrustContextToEnv(trustContext);
				ctx.ui.setWorkingMessage("Reloading workspace after trust change...");
				try {
					await ctx.reload();
				} finally {
					ctx.ui.setWorkingMessage();
				}
				ctx.ui.notify(`Removed trust for project: ${trustContext.canonicalCwd}`, "warning");
			},
		});

		pi.registerCommand("trust-status", {
			description: "Show trust status and fingerprint details for this project",
			handler: async (_args, ctx) => {
				const currentTrust = syncTrustContext(process.cwd());
				const lines = [
					`status: ${currentTrust.status}`,
					`project: ${currentTrust.canonicalCwd}`,
					`current fingerprint: ${currentTrust.fingerprint}`,
					`stored fingerprint: ${currentTrust.storedFingerprint ?? "(none)"}`,
				];
				if (currentTrust.status !== "trusted") {
					lines.push("repo-controlled project surfaces are currently blocked");
				}
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});
	};
}

/**
 * Create a built-in extension factory that rebrands the pi system prompt for tallow
 * and appends a compact context-budget status line each turn.
 *
 * Registered as a factory so it cannot be overridden or removed by users.
 *
 * @param budgetPolicy - Resolved context-budget policy for status line generation
 * @returns Extension factory
 */
function createRebrandSystemPromptExtension(budgetPolicy: ContextBudgetPolicy): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", async (event, ctx) => {
			let prompt = event.systemPrompt
				.replace(
					"You are an expert coding assistant operating inside pi, a coding agent harness.",
					"You are an expert coding assistant operating inside tallow, a coding agent harness."
				)
				.replace(/Pi documentation/g, "Tallow documentation")
				.replace(/When working on pi topics/g, "When working on tallow topics")
				.replace(/read pi \.md files/g, "read tallow .md files")
				.replace(/the user asks about pi itself/g, "the user asks about tallow itself");

			// Core guidelines baked into every tallow session
			prompt +=
				"\n\nLLM intelligence is not always the answer. When a well-designed algorithm, heuristic, or deterministic approach can solve the problem reliably, prefer that over reaching for another LLM call. Reserve model inference for tasks that genuinely require reasoning, creativity, or natural-language understanding.";

			// Communicate strategy changes proactively
			prompt +=
				"\n\nIf you hit an internal limit (thinking budget, output length, or planning complexity) that forces you to change approach — say so immediately. Never silently pivot from planning to execution, or drop planned items, without telling the user what happened and why.";

			// Detect unexpected workspace changes
			prompt +=
				"\n\nWhile you are working, if you notice unexpected changes in the workspace that you didn't make — STOP IMMEDIATELY and tell the user what you found. Do not attempt to revert, overwrite, or work around them. Ask the user how they would like to proceed.";

			// Review mindset
			prompt +=
				"\n\nWhen the user asks for a review, default to a code-review mindset. Prioritize identifying bugs, risks, behavioral regressions, and missing tests. Present findings first, ordered by severity, with file and line references where possible. State explicitly if no issues were found and call out any residual risks or test gaps.";

			// Inject model identity so non-Claude models don't confabulate their identity
			if (ctx.model) {
				prompt += `\n\nYou are running as ${ctx.model.name} (${ctx.model.provider}/${ctx.model.id}).`;
			}

			// Append compact budget status line for context awareness
			const usage = normalizeContextUsageSnapshot(ctx.getContextUsage?.());
			const budgetLine = formatBudgetStatusLine(usage, budgetPolicy);
			prompt += `\n\n[${budgetLine}]`;

			return { systemPrompt: prompt };
		});
	};
}

/**
 * Injects file paths into Image components for clickable OSC 8 links.
 * When the read tool returns an image, sets the pending file path so
 * the next Image constructor picks it up automatically.
 *
 * @param pi - Extension API
 */
function injectImageFilePaths(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "read") return;
		const hasImage = event.content?.some((c: { type: string }) => c.type === "image");
		if (hasImage && event.input?.path) {
			const filePath = resolve(String(event.input.path));
			// pi-tui >= 0.55 may not expose this helper; skip injection when unavailable.
			const maybeSetNextImageFilePath = (PiTui as { setNextImageFilePath?: unknown })
				.setNextImageFilePath;
			if (typeof maybeSetNextImageFilePath === "function") {
				maybeSetNextImageFilePath(filePath);
			}
		}
	});
}

/**
 * Create a built-in extension that summarizes oversized historical tool results.
 *
 * Runs at turn end (after response synthesis) to avoid mutating active-turn
 * tool results while the model is still reasoning.
 *
 * @param policy - Resolved retention policy
 * @returns Extension factory
 */
function createToolResultRetentionExtension(
	policy: ToolResultRetentionPolicy,
	budgetPolicy: ContextBudgetPolicy
): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		// ── Ingestion-time guard on tool_result ──────────────────────────────
		// Truncate oversized textual payloads before persistence when context
		// budget is tight or usage is unknown. Compatibility invariants:
		// - Never change toolCallId, toolName, or isError
		// - Preserve existing details fields
		// - Add guard metadata only under namespaced key
		// - Leave non-text blocks structurally unchanged
		pi.on("tool_result", async (event, ctx) => {
			const usage = normalizeContextUsageSnapshot(ctx.getContextUsage?.());
			const usageUnknown = usage.tokens === null || usage.contextWindow <= 0;
			const usagePercent =
				usage.percent !== null
					? usage.percent
					: usage.tokens === null || usage.contextWindow <= 0
						? null
						: Math.round((usage.tokens / usage.contextWindow) * 100);

			const safeBudgetBytes = (() => {
				if (usageUnknown) {
					return unknownUsageFallbackBudget(budgetPolicy);
				}

				const remainingTokens = estimateRemainingTokens(usage, budgetPolicy.perTurnReserveTokens);
				const baseline = Math.min(
					budgetPolicy.maxPerToolBytes,
					Math.max(budgetPolicy.minPerToolBytes, tokensToBytes(remainingTokens))
				);

				if (usagePercent !== null && usagePercent >= budgetPolicy.hardThresholdPercent) {
					return budgetPolicy.minPerToolBytes;
				}

				if (usagePercent !== null && usagePercent >= budgetPolicy.softThresholdPercent) {
					return Math.max(budgetPolicy.minPerToolBytes, Math.floor(baseline * 0.5));
				}

				return baseline;
			})();

			const guarded = guardToolResultContent(
				event.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
				safeBudgetBytes
			);
			if (!guarded.wasGuarded) {
				return;
			}

			const guardMeta: BudgetGuardMetadata = {
				guardedAt: new Date().toISOString(),
				originalContentBytes: guarded.originalTextBytes,
				truncatedToBytes: guarded.truncatedToBytes,
				reason: usageUnknown ? "unknown_usage" : "over_budget",
			};

			const existingDetails = isObjectRecord(event.details) ? event.details : {};
			return {
				content: guarded.content as Array<
					{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
				>,
				details: { ...existingDetails, [TOOL_RESULT_BUDGET_GUARD_MARKER]: guardMeta },
			};
		});

		// ── Historical turn_end retention (unchanged) ────────────────────────
		if (!policy.enabled) {
			return;
		}

		pi.on("turn_end", async (_event, ctx) => {
			const messages: Array<Record<string, unknown>> = [];
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "message") continue;
				if (!isObjectRecord(entry.message)) continue;
				messages.push(entry.message);
			}
			if (messages.length === 0) return;

			applyToolResultRetentionToMessages(messages, policy);
		});
	};
}

/**
 * Apply ingestion-time guardrails to a tool-result content array.
 *
 * Only textual blocks are truncated. Non-text blocks are preserved in place
 * to avoid breaking renderer contracts.
 *
 * @param content - Tool-result content blocks
 * @param maxTextBytes - Maximum allowed bytes across all text blocks
 * @returns Guarded content payload metadata
 */
function guardToolResultContent(
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
	maxTextBytes: number
): GuardedToolResultContent {
	let originalTextBytes = 0;
	let totalContentBytes = 0;
	for (const block of content) {
		if (block.type === "text") {
			const text = block.text ?? "";
			const textBytes = Buffer.byteLength(text, "utf-8");
			originalTextBytes += textBytes;
			totalContentBytes += textBytes;
			continue;
		}

		totalContentBytes += Buffer.byteLength(JSON.stringify(block), "utf-8");
	}

	if (originalTextBytes > 0 && originalTextBytes <= maxTextBytes) {
		return {
			content,
			originalTextBytes,
			truncatedToBytes: originalTextBytes,
			wasGuarded: false,
		};
	}

	if (originalTextBytes === 0) {
		if (totalContentBytes <= maxTextBytes) {
			return {
				content,
				originalTextBytes,
				truncatedToBytes: 0,
				wasGuarded: false,
			};
		}

		const fallbackText =
			"[non-text tool output exceeds context budget; payload preserved without structural rewrite]";
		return {
			content: [{ type: "text", text: fallbackText }, ...content],
			originalTextBytes,
			truncatedToBytes: 0,
			wasGuarded: true,
		};
	}

	const nextContent: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
	let bytesUsed = 0;
	let truncated = false;

	for (const block of content) {
		if (block.type !== "text") {
			nextContent.push(block);
			continue;
		}

		if (truncated) {
			continue;
		}

		const text = block.text ?? "";
		const blockBytes = Buffer.byteLength(text, "utf-8");
		if (bytesUsed + blockBytes <= maxTextBytes) {
			nextContent.push({ ...block, text });
			bytesUsed += blockBytes;
			continue;
		}

		const remaining = Math.max(0, maxTextBytes - bytesUsed);
		const truncatedText =
			remaining > 0
				? truncateTextToBytes(text, remaining)
				: "[output truncated by context-budget guard]";
		const marker =
			remaining > 0
				? `\n\n[output truncated by context-budget guard — ${formatBytesForSummary(originalTextBytes)} → ${formatBytesForSummary(maxTextBytes)}]`
				: `\n\n[output truncated by context-budget guard — ${formatBytesForSummary(originalTextBytes)} original]`;
		nextContent.push({ type: "text", text: `${truncatedText}${marker}` });
		bytesUsed = maxTextBytes;
		truncated = true;
	}

	if (!truncated) {
		return {
			content,
			originalTextBytes,
			truncatedToBytes: originalTextBytes,
			wasGuarded: false,
		};
	}

	return {
		content: nextContent,
		originalTextBytes,
		truncatedToBytes: Math.min(originalTextBytes, maxTextBytes),
		wasGuarded: true,
	};
}

/**
 * Truncate a string to fit within a byte budget (UTF-8 safe).
 *
 * Walks backward from an estimated character position to find a safe
 * cut point that does not split a multi-byte character.
 *
 * @param text - Source text to truncate
 * @param maxBytes - Maximum UTF-8 byte length
 * @returns Truncated string guaranteed to be at most maxBytes
 */
function truncateTextToBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
	// Start from an optimistic char position (ASCII-equivalent)
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf-8") > maxBytes) {
		end -= 1;
	}
	return text.slice(0, end);
}

/**
 * Create a batch planner extension that computes per-tool byte envelopes
 * from assistant tool calls and publishes them via the event bus.
 *
 * On `message_end` for assistant messages, inspects tool calls in the
 * message content and allocates a budget envelope for each one, keyed
 * by toolCallId. Envelopes are single-use (consumed via the API) and
 * automatically cleaned up on turn_end, agent_end, session_before_switch,
 * and session_switch events.
 *
 * @param budgetPolicy - Resolved context-budget policy
 * @returns Extension factory
 */
function createContextBudgetPlannerExtension(budgetPolicy: ContextBudgetPolicy): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const envelopeStore = new Map<
			string,
			{
				envelope: { maxBytes: number; batchSize: number };
				metadata: { createdAtMs: number; turnIndex: number; ttlMs: number };
			}
		>();
		let currentTurnIndex = 0;

		/** Clamp a per-tool envelope to policy min/max bounds. */
		const clampPerToolBytes = (value: number): number =>
			Math.min(budgetPolicy.maxPerToolBytes, Math.max(budgetPolicy.minPerToolBytes, value));

		/** Drop stale envelopes so stale calls cannot reuse old budgets. */
		const pruneStaleEnvelopes = (nowMs: number): void => {
			for (const [toolCallId, entry] of envelopeStore) {
				const expired = nowMs - entry.metadata.createdAtMs > entry.metadata.ttlMs;
				const wrongTurn = entry.metadata.turnIndex !== currentTurnIndex;
				if (expired || wrongTurn) {
					envelopeStore.delete(toolCallId);
				}
			}
		};

		/** Clear all envelopes from the planner state. */
		const clearEnvelopes = (): void => {
			envelopeStore.clear();
		};

		/** Resolve per-tool budget for one tool-call batch. */
		const resolvePerToolBudget = (usage: ContextUsageSnapshot, batchSize: number): number => {
			if (usage.tokens === null || usage.contextWindow <= 0) {
				return clampPerToolBytes(unknownUsageFallbackBudget(budgetPolicy));
			}

			const usagePercent =
				usage.percent !== null
					? usage.percent
					: Math.round((usage.tokens / usage.contextWindow) * 100);
			const remainingTokens = estimateRemainingTokens(usage, budgetPolicy.perTurnReserveTokens);
			const totalBytes = tokensToBytes(remainingTokens);
			const rawPerTool = Math.floor(totalBytes / Math.max(1, batchSize));

			// Apply additional pressure once the turn is near the hard threshold.
			if (usagePercent >= budgetPolicy.hardThresholdPercent) {
				return clampPerToolBytes(Math.min(rawPerTool, budgetPolicy.minPerToolBytes));
			}

			if (usagePercent >= budgetPolicy.softThresholdPercent) {
				const cautiousPerTool = Math.floor(rawPerTool * 0.5);
				return clampPerToolBytes(cautiousPerTool);
			}

			return clampPerToolBytes(rawPerTool);
		};

		/** Publish the planner API for tool extensions. */
		const publishBudgetApi = (): void => {
			pi.events.emit(CONTEXT_BUDGET_API_CHANNELS.budgetApi, { api: budgetApi });
		};

		// Track turn index and evict stale envelopes at turn boundaries.
		pi.on("turn_start", async (event) => {
			currentTurnIndex = event.turnIndex;
			pruneStaleEnvelopes(Date.now());
		});

		// Compute envelopes on assistant message_end.
		pi.on("message_end", async (event, ctx) => {
			if (!event.message || event.message.role !== "assistant") {
				return;
			}

			const content = event.message.content;
			if (!Array.isArray(content)) {
				return;
			}

			const toolCalls = content.filter(
				(
					block
				): block is {
					arguments: Record<string, unknown>;
					id: string;
					name: string;
					type: "toolCall";
				} =>
					isObjectRecord(block) &&
					block.type === "toolCall" &&
					typeof block.id === "string" &&
					typeof block.name === "string" &&
					isObjectRecord(block.arguments)
			);
			if (toolCalls.length === 0) {
				return;
			}

			const nowMs = Date.now();
			pruneStaleEnvelopes(nowMs);

			const usage = normalizeContextUsageSnapshot(ctx.getContextUsage?.());
			const batchSize = toolCalls.length;
			const perToolBytes = resolvePerToolBudget(usage, batchSize);

			for (const toolCall of toolCalls) {
				envelopeStore.set(toolCall.id, {
					envelope: { batchSize, maxBytes: perToolBytes },
					metadata: {
						createdAtMs: nowMs,
						ttlMs: CONTEXT_BUDGET_ENVELOPE_TTL_MS,
						turnIndex: currentTurnIndex,
					},
				});
			}
		});

		const budgetApi = {
			take(toolCallId: string) {
				const nowMs = Date.now();
				pruneStaleEnvelopes(nowMs);
				const entry = envelopeStore.get(toolCallId);
				if (!entry) {
					return undefined;
				}

				const expired = nowMs - entry.metadata.createdAtMs > entry.metadata.ttlMs;
				const wrongTurn = entry.metadata.turnIndex !== currentTurnIndex;
				envelopeStore.delete(toolCallId);
				if (expired || wrongTurn) {
					return undefined;
				}

				return entry.envelope;
			},
		};

		pi.on("session_start", async () => {
			publishBudgetApi();
		});

		pi.events.on(CONTEXT_BUDGET_API_CHANNELS.budgetApiRequest, () => {
			publishBudgetApi();
		});

		pi.on("turn_end", async () => {
			clearEnvelopes();
		});
		pi.on("agent_end", async () => {
			clearEnvelopes();
		});
		pi.on("session_before_switch", async () => {
			clearEnvelopes();
		});
		pi.on("session_switch", async () => {
			clearEnvelopes();
		});
	};
}

/**
 * Detects when a model response was truncated due to max_tokens and notifies
 * the user. Without this, truncated responses silently stop — the model may
 * change strategy or drop work without explanation.
 *
 * @param pi - Extension API
 */
function detectOutputTruncation(pi: ExtensionAPI): void {
	pi.on("turn_end", async (event, ctx) => {
		if (!ctx.hasUI) return;

		const msg = event.message;
		if (!msg || !("stopReason" in msg)) return;

		if (msg.stopReason === "length") {
			ctx.ui.notify(
				"Response was truncated (hit max output tokens). The model may have dropped planned work — consider re-prompting.",
				"warning"
			);
		}
	});
}

/**
 * Ensure the tallow home directory structure and startup housekeeping are ready.
 *
 * @param startupProfile - Startup profile controlling interactive-only setup
 * @returns Nothing
 */
function ensureTallowHome(startupProfile: TallowStartupProfile): void {
	const tallowHome = getRuntimeTallowHome();
	const dirs = [tallowHome, join(tallowHome, "sessions"), join(tallowHome, "extensions")];

	for (const dir of dirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	// Migrate flat session files to per-cwd subdirectories (one-time, idempotent)
	migrateSessionsToPerCwdDirs(join(tallowHome, "sessions"));

	// Kill orphaned child processes from crashed/killed previous sessions
	const orphansKilled = cleanupOrphanPids();
	if (orphansKilled > 0) {
		console.error(
			`\x1b[33m⚠ Cleaned up ${orphansKilled} orphaned background process${orphansKilled > 1 ? "es" : ""} from a previous session\x1b[0m`
		);
	}

	if (startupProfile === "interactive") {
		ensureKeybindings();
	}
}

/**
 * Tallow keybinding overrides applied on top of framework defaults.
 * These free up ctrl+s and ctrl+p for the stash-prompt extension.
 *
 * IMPORTANT: ctrl+m is the same terminal byte as Enter (\r, char 13)
 * because terminals compute ctrl+letter as charCode & 0x1f.
 * Never bind anything to ctrl+m — it will intercept Enter.
 *
 * Remaps:
 *   cycleModelForward:  ctrl+p → unbound (use ctrl+l model selector instead)
 *   cycleModelBackward: shift+ctrl+p → unbound
 *   toggleSessionSort:  ctrl+s → unbound
 *   toggleSessionPath:  ctrl+p → unbound
 */
const TALLOW_KEYBINDINGS: Record<string, string | string[]> = {
	cycleModelForward: [],
	cycleModelBackward: [],
	toggleSessionSort: [],
	toggleSessionPath: [],
};

/**
 * Ensures keybindings.json contains tallow's mandatory overrides.
 * Merges with any existing user customizations — tallow keys take precedence.
 */
function ensureKeybindings(): void {
	const keybindingsPath = join(getRuntimeTallowHome(), "keybindings.json");

	let existing: Record<string, unknown> = {};
	if (existsSync(keybindingsPath)) {
		try {
			existing = JSON.parse(readFileSync(keybindingsPath, "utf-8"));
		} catch {
			// Corrupt file — overwrite
		}
	}

	const merged = { ...existing, ...TALLOW_KEYBINDINGS };

	// Only write if something changed
	const currentJson = JSON.stringify(existing, null, "\t");
	const mergedJson = JSON.stringify(merged, null, "\t");
	if (currentJson !== mergedJson) {
		atomicWriteFileSync(keybindingsPath, `${mergedJson}\n`);
	}
}
