/**
 * WebFetch Extension for Pi
 *
 * Fetches web content via plain HTTP. Returns page text truncated by context-budget caps.
 * For JS-rendered pages, full-page scraping, or structured extraction,
 * use a dedicated scraping tool (e.g. Firecrawl) instead.
 *
 * Supports adaptive context-budget caps when a planner extension publishes
 * envelopes via the shared context-budget interop.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import {
	CONTEXT_BUDGET_DEFAULTS,
	type ContextBudgetEnvelope,
	subscribeToBudgetApi,
} from "../_shared/context-budget-interop.js";
import { renderLines } from "../tool-display/index.js";

/** Strict fallback cap when no planner envelope is available. */
const DEFAULT_MAX_BYTES = CONTEXT_BUDGET_DEFAULTS.unknownUsageFallbackCapBytes;

/** Policy floor — planner/tool logic should never allocate below this by default. */
const POLICY_MIN_BYTES = CONTEXT_BUDGET_DEFAULTS.minPerToolBytes;

/** Policy ceiling — never exceed this regardless of envelope. */
const POLICY_MAX_BYTES = CONTEXT_BUDGET_DEFAULTS.maxPerToolBytes;

// ── Adaptive cap resolution (pure, exported for tests) ──────────────

/** Input parameters for resolving the effective byte cap. */
export interface CapResolutionInput {
	/** Explicit maxBytes from the user's tool-call parameters. */
	userMaxBytes: number | undefined;
	/** Budget envelope consumed for this tool call (undefined = no planner). */
	envelope: ContextBudgetEnvelope | undefined;
	/** Hard policy floor in bytes. */
	policyMin: number;
	/** Hard policy ceiling in bytes. */
	policyMax: number;
	/** Fallback cap when no envelope is present. */
	defaultMaxBytes: number;
}

/** Resolved cap with diagnostics. */
export interface CapResolutionResult {
	/** Final byte cap to apply to the fetch response. */
	effectiveMaxBytes: number;
	/** True when the planner envelope reduced the cap below what the user would have gotten. */
	budgetLimited: boolean;
	/** Human-readable explanation of how the cap was chosen. */
	budgetReason: string;
	/** Batch size from the envelope (1 when no envelope). */
	batchSize: number;
}

/**
 * Resolve the effective maxBytes cap from all inputs.
 *
 * Priority chain:
 * 1. Start from envelope maxBytes (or defaultMaxBytes when absent).
 * 2. User maxBytes is a hard upper bound — cap cannot exceed it.
 * 3. Clamp into [policyMin, policyMax].
 *
 * @param input - Cap resolution parameters
 * @returns Resolved cap with diagnostic metadata
 */
export function resolveAdaptiveCap(input: CapResolutionInput): CapResolutionResult {
	const { userMaxBytes, envelope, policyMin, policyMax, defaultMaxBytes } = input;

	const batchSize = envelope?.batchSize ?? 1;
	const userCap = userMaxBytes ?? Number.POSITIVE_INFINITY;

	// Step 1: base cap comes from planner envelope or strict fallback.
	const base = envelope?.maxBytes ?? defaultMaxBytes;
	let reason = envelope
		? `planner envelope (${base} bytes, batch ${batchSize})`
		: `strict fallback (${defaultMaxBytes} bytes)`;

	// Step 2: clamp planner/fallback cap into policy bounds.
	let effective = Math.min(policyMax, Math.max(policyMin, base));
	if (effective !== base) {
		reason +=
			effective < base
				? ` → capped by policy max (${policyMax})`
				: ` → raised to policy min (${policyMin})`;
	}

	// Step 3: explicit user maxBytes is a hard upper bound.
	if (Number.isFinite(userCap) && effective > userCap) {
		effective = userCap;
		reason += ` → capped by user maxBytes (${userCap})`;
	}

	const withoutEnvelope = Number.isFinite(userCap)
		? Math.min(userCap, Math.min(policyMax, Math.max(policyMin, defaultMaxBytes)))
		: Math.min(policyMax, Math.max(policyMin, defaultMaxBytes));
	const budgetLimited = envelope !== undefined && effective < withoutEnvelope;

	return { effectiveMaxBytes: effective, budgetLimited, budgetReason: reason, batchSize };
}

/**
 * Truncate text to a maximum UTF-8 byte length.
 *
 * @param text - Source text
 * @param maxBytes - Maximum number of UTF-8 bytes to keep
 * @returns Truncated text at a valid character boundary
 */
function truncateTextToBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf-8") > maxBytes) {
		end -= 1;
	}
	return text.slice(0, end);
}

/**
 * Registers the web_fetch tool.
 * @param pi - Extension API for registering tools
 */
export default function (pi: ExtensionAPI) {
	const getBudgetApi = subscribeToBudgetApi(pi.events);

	pi.registerTool({
		name: "web_fetch",
		label: "web_fetch",
		description: `Fetch content from a URL. Returns page text truncated by context-budget policy (conservative fallback when budget is unknown).

WHEN TO USE:
- Need to read web page content
- Fetching documentation or articles
- Checking API responses`,
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			maxBytes: Type.Optional(
				Type.Number({
					description:
						"Max bytes before truncation (hard upper bound; may be reduced by context budget)",
				})
			),
			format: Type.Optional(
				Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
					description: 'Output format hint: "text" (default), "markdown", or "html"',
				})
			),
		}),

		async execute(toolCallId, params, signal, _onUpdate) {
			// ── Adaptive cap ────────────────────────────────────
			const budgetApi = getBudgetApi();
			const envelope = budgetApi?.take(toolCallId) ?? undefined;

			const { effectiveMaxBytes, budgetLimited, budgetReason, batchSize } = resolveAdaptiveCap({
				userMaxBytes: params.maxBytes,
				envelope,
				policyMin: POLICY_MIN_BYTES,
				policyMax: POLICY_MAX_BYTES,
				defaultMaxBytes: DEFAULT_MAX_BYTES,
			});

			const maxBytes = effectiveMaxBytes;

			try {
				const response = await fetch(params.url, {
					signal,
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					},
				});

				if (!response.ok) {
					const error = `HTTP ${response.status}: ${response.statusText}`;
					return {
						content: [{ type: "text", text: error }],
						details: { status: response.status, url: params.url, error, isError: true },
					};
				}

				const contentType = response.headers.get("content-type") || "";
				const fullText = await response.text();
				const totalBytes = Buffer.byteLength(fullText, "utf-8");
				const truncated = totalBytes > maxBytes;

				let content = truncated ? truncateTextToBytes(fullText, maxBytes) : fullText;

				if (truncated) {
					content += `\n\n[Truncated: showing ${(maxBytes / 1024).toFixed(1)}KB of ${(totalBytes / 1024).toFixed(1)}KB]`;
				}

				return {
					content: [{ type: "text", text: content }],
					details: {
						url: params.url,
						status: response.status,
						contentType,
						totalBytes,
						truncated,
						effectiveMaxBytes,
						budgetLimited,
						budgetReason,
						batchSize,
					},
				};
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Fetch error: ${msg}` }],
					details: { url: params.url, error: msg, isError: true },
				};
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", args.url),
				0,
				0
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						url?: string;
						error?: string;
						isError?: boolean;
						totalBytes?: number;
						truncated?: boolean;
						effectiveMaxBytes?: number;
						budgetLimited?: boolean;
						budgetReason?: string;
						batchSize?: number;
				  }
				| undefined;
			if (!details) {
				const text = result.content[0];
				return renderLines([text?.type === "text" ? text.text : "(no output)"]);
			}

			// Build the summary footer
			let footer: string;
			if (details.isError) {
				footer = theme.fg("error", `${getIcon("error")} ${details.error || "Failed"}`);
			} else {
				const size = details.totalBytes ? ` (${(details.totalBytes / 1024).toFixed(1)}KB)` : "";
				const truncNote = details.truncated ? " [truncated]" : "";
				const budgetNote = details.budgetLimited ? " [budget-limited]" : "";
				footer =
					theme.fg("success", `${getIcon("success")} `) +
					theme.fg("dim", details.url ?? "") +
					theme.fg("muted", size + truncNote + budgetNote);
			}

			// Expanded: content preview first, footer last
			if (expanded && !details.isError) {
				const text = result.content[0];
				const content = text?.type === "text" ? text.text : "";
				const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "");
				const contentLines = preview.split("\n").map((l) => theme.fg("dim", l));
				return renderLines([...contentLines, footer]);
			}

			// Collapsed: footer only
			return renderLines([footer]);
		},
	});
}
