/**
 * WebFetch Extension for Pi.
 *
 * Fetches web content via plain HTTP. Returns page text truncated by context-budget caps.
 * When direct fetches fail on bot walls or JS-only shells, it can fall back to the
 * published `dendrite-scraper` CLI (direct binary first, then `uvx --from dendrite-scraper`).
 *
 * Supports adaptive context-budget caps when a planner extension publishes
 * envelopes via the shared context-budget interop.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

/** Package name used by the published dendrite fallback. */
const DENDRITE_PACKAGE = "dendrite-scraper";

/** CLI name exported by the published dendrite package. */
const DENDRITE_COMMAND = "dendrite-scraper";

/** Global scrape timeout passed to dendrite-scraper. */
const DENDRITE_TIMEOUT_SECONDS = 45;

/** Process timeout for spawned fallback commands. */
const DENDRITE_TIMEOUT_MS = 50_000;

/** Status codes worth retrying through the scraper fallback. */
const DENDRITE_RETRYABLE_STATUSES = new Set([
	401, 403, 408, 409, 425, 429, 451, 500, 502, 503, 504,
]);

/** HTML markers that usually mean direct fetch returned a useless shell. */
const DENDRITE_HTML_MARKERS = [
	/enable javascript/i,
	/javascript required/i,
	/checking your browser/i,
	/verify you are human/i,
	/captcha/i,
	/cloudflare/i,
	/access denied/i,
	/please turn javascript on/i,
] as const;

/** Hostnames that should never be fetched by default. */
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

/** Resolver contract used by URL validation tests. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/** Result of validating a fetch target URL. */
export type FetchUrlValidationResult =
	| { readonly ok: true; readonly url: URL }
	| { readonly ok: false; readonly reason: string };

/**
 * Check whether an IPv4 address is private, loopback, link-local, or otherwise local-only.
 *
 * @param address - IPv4 address literal
 * @returns True when the address should be blocked for outbound fetches
 */
export function isBlockedIpv4Address(address: string): boolean {
	const parts = address.split(".").map((part) => Number(part));
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return false;
	}

	const [a, b] = parts as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 192 && b === 0 && parts[2] === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

/**
 * Check whether an IPv6 address is loopback, unique-local, link-local, or unspecified.
 *
 * @param address - IPv6 address literal
 * @returns True when the address should be blocked for outbound fetches
 */
export function isBlockedIpv6Address(address: string): boolean {
	const normalized = address.toLowerCase();
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	);
}

/**
 * Check whether an IP literal should be blocked by default.
 *
 * @param address - IPv4 or IPv6 literal
 * @returns True when the address resolves to a local/private network target
 */
export function isBlockedIpAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return isBlockedIpv4Address(address);
	if (version === 6) return isBlockedIpv6Address(address);
	return false;
}

/**
 * Resolve a hostname into IP addresses for SSRF validation.
 *
 * @param hostname - Hostname to resolve
 * @returns All resolved IP literals
 */
async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
	const results = await lookup(hostname, { all: true, verbatim: true });
	return results.map((result) => result.address);
}

/**
 * Validate a fetch target URL before any network call happens.
 *
 * Blocks unsupported schemes, credentialed URLs, localhost, `.local`, and
 * targets that resolve to private or link-local addresses.
 *
 * @param rawUrl - User-provided URL string
 * @param resolveHost - Optional host resolver for tests
 * @returns Parsed URL when safe, otherwise a blocking reason
 */
export async function validateFetchUrl(
	rawUrl: string,
	resolveHost: HostResolver = resolveHostAddresses
): Promise<FetchUrlValidationResult> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return { ok: false, reason: "invalid URL" };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: `unsupported protocol: ${parsed.protocol}` };
	}

	if (parsed.username || parsed.password) {
		return { ok: false, reason: "credentialed URLs are not allowed" };
	}

	const hostname = parsed.hostname.toLowerCase();
	if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local")) {
		return { ok: false, reason: `blocked local hostname: ${hostname}` };
	}

	if (isBlockedIpAddress(hostname)) {
		return { ok: false, reason: `blocked private IP address: ${hostname}` };
	}

	try {
		const addresses = await resolveHost(hostname);
		const blockedAddress = addresses.find((address) => isBlockedIpAddress(address));
		if (blockedAddress) {
			return {
				ok: false,
				reason: `hostname resolved to blocked private IP address: ${blockedAddress}`,
			};
		}
	} catch {
		// DNS lookup failures are handled by fetch itself. Only successful lookups
		// participate in private-network blocking.
	}

	return { ok: true, url: parsed };
}

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

/** Minimal JSON contract emitted by dendrite-scraper CLI. */
interface DendritePayload {
	readonly attempts?: readonly string[];
	readonly bot_detected?: boolean;
	readonly elapsed_ms?: number;
	readonly error?: string | null;
	readonly llm_cleaned?: boolean;
	readonly markdown?: string;
	readonly ok?: boolean;
	readonly source?: string;
	readonly url?: string;
}

/** Resolved fallback command candidate. */
interface DendriteCommandCandidate {
	readonly args: readonly string[];
	readonly command: string;
	readonly display: string;
}

/** Successful dendrite fallback execution. */
interface DendriteFallbackSuccess {
	readonly command: string;
	readonly payload: DendritePayload;
	readonly source: "binary" | "uvx";
}

/** Final detail payload returned by the tool. */
interface WebFetchDetails {
	readonly attempts?: readonly string[];
	readonly backend?: "dendrite-scraper" | "http";
	readonly batchSize?: number;
	readonly botDetected?: boolean;
	readonly budgetLimited?: boolean;
	readonly budgetReason?: string;
	readonly contentType?: string;
	readonly effectiveMaxBytes?: number;
	readonly elapsedMs?: number;
	readonly error?: string;
	readonly fallbackCommand?: string;
	readonly fallbackReason?: string;
	readonly fallbackUsed?: boolean;
	readonly isError?: boolean;
	readonly llmCleaned?: boolean;
	readonly source?: string;
	readonly status?: number;
	readonly totalBytes?: number;
	readonly truncated?: boolean;
	readonly url?: string;
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
 * Decide whether the dendrite fallback is worth trying.
 *
 * @param input - HTTP outcome and fetch error context
 * @returns Human-readable fallback reason, or undefined when plain HTTP is good enough
 */
export function shouldUseDendriteFallback(input: {
	readonly contentType?: string;
	readonly error?: string;
	readonly format?: "html" | "markdown" | "text";
	readonly responseText?: string;
	readonly status?: number;
}): string | undefined {
	if (input.format === "html") return undefined;
	if (input.error) return `fetch error (${input.error})`;
	if (input.status !== undefined && DENDRITE_RETRYABLE_STATUSES.has(input.status)) {
		return `HTTP ${input.status}`;
	}

	const contentType = input.contentType ?? "";
	if (!contentType.includes("text/html")) return undefined;

	const responseText = input.responseText?.trim() ?? "";
	if (!responseText) return "empty HTML response";
	for (const marker of DENDRITE_HTML_MARKERS) {
		if (marker.test(responseText)) return `HTML shell matched ${marker}`;
	}
	return undefined;
}

/**
 * Parse the JSON output contract emitted by dendrite-scraper.
 *
 * @param stdout - Raw process stdout
 * @returns Parsed payload when stdout is valid JSON, otherwise undefined
 */
function parseDendritePayload(stdout: string): DendritePayload | undefined {
	const trimmed = stdout.trim();
	if (!trimmed) return undefined;

	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== "object") return undefined;
		return parsed as DendritePayload;
	} catch {
		return undefined;
	}
}

/**
 * Build the command candidates for the published dendrite fallback.
 *
 * @returns Direct binary first, then uvx package execution
 */
function getDendriteCandidates(): readonly DendriteCommandCandidate[] {
	return [
		{
			args: [],
			command: DENDRITE_COMMAND,
			display: DENDRITE_COMMAND,
		},
		{
			args: ["--from", DENDRITE_PACKAGE, DENDRITE_COMMAND],
			command: "uvx",
			display: `uvx --from ${DENDRITE_PACKAGE} ${DENDRITE_COMMAND}`,
		},
	] as const;
}

/**
 * Execute the published dendrite fallback until one candidate succeeds.
 *
 * @param pi - Extension API for subprocess execution
 * @param url - URL to scrape
 * @param signal - Abort signal forwarded from tool execution
 * @returns Successful fallback payload, or an error string describing why all attempts failed
 */
async function runDendriteFallback(
	pi: ExtensionAPI,
	url: string,
	signal: AbortSignal | undefined
): Promise<
	| { readonly ok: true; readonly value: DendriteFallbackSuccess }
	| { readonly error: string; readonly ok: false }
> {
	let lastError = "dendrite fallback unavailable";

	for (const candidate of getDendriteCandidates()) {
		try {
			const result = await pi.exec(
				candidate.command,
				[...candidate.args, "scrape", "--timeout", String(DENDRITE_TIMEOUT_SECONDS), url],
				{ signal, timeout: DENDRITE_TIMEOUT_MS }
			);
			const payload = parseDendritePayload(result.stdout);
			const stderr = result.stderr.trim();
			const payloadError = typeof payload?.error === "string" ? payload.error : "";
			const errorText = payloadError || stderr || `exit ${result.code}`;

			if (payload?.ok === true && typeof payload.markdown === "string" && payload.markdown.trim()) {
				return {
					ok: true,
					value: {
						command: candidate.display,
						payload,
						source: candidate.command === DENDRITE_COMMAND ? "binary" : "uvx",
					},
				};
			}

			lastError = `${candidate.display}: ${errorText}`;
		} catch (error: unknown) {
			const msg = error instanceof Error ? error.message : String(error);
			lastError = `${candidate.display}: ${msg}`;
		}
	}

	return { error: lastError, ok: false };
}

/**
 * Apply byte truncation and append a consistent truncation note.
 *
 * @param text - Content to limit
 * @param maxBytes - Byte cap to enforce
 * @returns Final content plus truncation metadata
 */
function finalizeContent(
	text: string,
	maxBytes: number
): {
	readonly content: string;
	readonly totalBytes: number;
	readonly truncated: boolean;
} {
	const totalBytes = Buffer.byteLength(text, "utf-8");
	const truncated = totalBytes > maxBytes;
	let content = truncated ? truncateTextToBytes(text, maxBytes) : text;
	if (truncated) {
		content += `\n\n[Truncated: showing ${(maxBytes / 1024).toFixed(1)}KB of ${(totalBytes / 1024).toFixed(1)}KB]`;
	}
	return { content, totalBytes, truncated };
}

/**
 * Registers the web_fetch tool.
 *
 * @param pi - Extension API for registering tools
 * @returns void
 */
export default function (pi: ExtensionAPI): void {
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
			const baseDetails = {
				batchSize,
				budgetLimited,
				budgetReason,
				effectiveMaxBytes,
				url: params.url,
			} satisfies WebFetchDetails;

			const validation = await validateFetchUrl(params.url);
			if (!validation.ok) {
				const error = `Blocked URL: ${validation.reason}`;
				return {
					content: [{ type: "text", text: error }],
					details: {
						...baseDetails,
						backend: "http",
						error,
						isError: true,
					} satisfies WebFetchDetails,
				};
			}

			try {
				const response = await fetch(validation.url, {
					signal,
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					},
				});

				const contentType = response.headers.get("content-type") || "";
				const fullText = await response.text();
				const fallbackReason = shouldUseDendriteFallback({
					contentType,
					format: params.format,
					responseText: fullText,
					status: response.status,
				});
				let fallbackFailure: string | undefined;

				if (fallbackReason) {
					const fallback = await runDendriteFallback(pi, params.url, signal);
					if (fallback.ok) {
						const text = fallback.value.payload.markdown ?? "";
						const final = finalizeContent(text, maxBytes);
						return {
							content: [{ type: "text", text: final.content }],
							details: {
								...baseDetails,
								attempts: fallback.value.payload.attempts,
								backend: "dendrite-scraper",
								botDetected: fallback.value.payload.bot_detected,
								elapsedMs: fallback.value.payload.elapsed_ms,
								fallbackCommand: fallback.value.command,
								fallbackReason,
								fallbackUsed: true,
								llmCleaned: fallback.value.payload.llm_cleaned,
								source: fallback.value.payload.source ?? fallback.value.source,
								totalBytes: final.totalBytes,
								truncated: final.truncated,
								url: fallback.value.payload.url ?? params.url,
							} satisfies WebFetchDetails,
						};
					}
					fallbackFailure = fallback.error;
				}

				if (!response.ok) {
					const error = `HTTP ${response.status}: ${response.statusText}`;
					const fallback = fallbackFailure
						? `\n\nDendrite fallback failed: ${fallbackFailure}`
						: "";
					return {
						content: [{ type: "text", text: `${error}${fallback}` }],
						details: {
							...baseDetails,
							backend: "http",
							contentType,
							error: `${error}${fallback}`,
							fallbackReason,
							fallbackUsed: Boolean(fallbackReason),
							isError: true,
							status: response.status,
						} satisfies WebFetchDetails,
					};
				}

				const final = finalizeContent(fullText, maxBytes);
				return {
					content: [{ type: "text", text: final.content }],
					details: {
						...baseDetails,
						backend: "http",
						contentType,
						status: response.status,
						totalBytes: final.totalBytes,
						truncated: final.truncated,
					} satisfies WebFetchDetails,
				};
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				const fallbackReason = shouldUseDendriteFallback({ error: msg, format: params.format });
				let fallbackFailure: string | undefined;
				if (fallbackReason) {
					const fallback = await runDendriteFallback(pi, params.url, signal);
					if (fallback.ok) {
						const text = fallback.value.payload.markdown ?? "";
						const final = finalizeContent(text, maxBytes);
						return {
							content: [{ type: "text", text: final.content }],
							details: {
								...baseDetails,
								attempts: fallback.value.payload.attempts,
								backend: "dendrite-scraper",
								botDetected: fallback.value.payload.bot_detected,
								elapsedMs: fallback.value.payload.elapsed_ms,
								fallbackCommand: fallback.value.command,
								fallbackReason,
								fallbackUsed: true,
								llmCleaned: fallback.value.payload.llm_cleaned,
								source: fallback.value.payload.source ?? fallback.value.source,
								totalBytes: final.totalBytes,
								truncated: final.truncated,
								url: fallback.value.payload.url ?? params.url,
							} satisfies WebFetchDetails,
						};
					}
					fallbackFailure = fallback.error;
				}

				const errorText = `Fetch error: ${msg}${fallbackFailure ? `\n\nDendrite fallback failed: ${fallbackFailure}` : ""}`;
				return {
					content: [{ type: "text", text: errorText }],
					details: {
						...baseDetails,
						backend: "http",
						error: errorText,
						fallbackReason,
						fallbackUsed: Boolean(fallbackReason),
						isError: true,
					} satisfies WebFetchDetails,
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
			const details = result.details as WebFetchDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return renderLines([text?.type === "text" ? text.text : "(no output)"]);
			}

			// Build the summary footer.
			let footer: string;
			if (details.isError) {
				footer = theme.fg("error", `${getIcon("error")} ${details.error || "Failed"}`);
			} else {
				const backend =
					details.backend === "dendrite-scraper"
						? ` via dendrite-scraper${details.source ? `/${details.source}` : ""}`
						: "";
				const size = details.totalBytes ? ` (${(details.totalBytes / 1024).toFixed(1)}KB)` : "";
				const truncNote = details.truncated ? " [truncated]" : "";
				const budgetNote = details.budgetLimited ? " [budget-limited]" : "";
				footer =
					theme.fg("success", `${getIcon("success")} `) +
					theme.fg("dim", `${details.url ?? ""}${backend}`) +
					theme.fg("muted", size + truncNote + budgetNote);
			}

			// Expanded: content preview first, footer last.
			if (expanded && !details.isError) {
				const text = result.content[0];
				const content = text?.type === "text" ? text.text : "";
				const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "");
				const contentLines = preview.split("\n").map((line) => theme.fg("dim", line));
				return renderLines([...contentLines, footer]);
			}

			// Collapsed: footer only.
			return renderLines([footer]);
		},
	});
}
