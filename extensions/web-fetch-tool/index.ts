/**
 * WebFetch Extension for Pi
 *
 * Fetches web content with optional Firecrawl fallback when content is truncated.
 * Firecrawl requires a FIRECRAWL_API_KEY env var. Without it, truncated content
 * is returned as-is.
 *
 * Default truncation limit: 100KB.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";

/** Minimal TUI component — raw render function for explicit line order. */
interface RenderComponent {
	render(width: number): string[];
	invalidate(): void;
}

/** Build a raw render component from individually-styled lines. */
function renderLines(lines: string[]): RenderComponent {
	return {
		render(width: number): string[] {
			return lines.map((line) => truncateToWidth(line, width, "…"));
		},
		invalidate() {},
	};
}

const DEFAULT_MAX_BYTES = 100_000;
const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1/scrape";

/**
 * Detect if an HTML page likely requires JavaScript to render meaningful content.
 * Checks for SPA shells (empty root divs), low text-to-markup ratio, and
 * framework-specific patterns (React, Vue, Angular, Next.js, Nuxt).
 * @param html - Raw HTML string
 * @returns true if the page appears to be JS-dependent
 */
function looksLikeJsRequired(html: string): boolean {
	// Strip tags to get visible text
	const textOnly = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	// Very little visible text relative to HTML size = likely JS-rendered
	if (html.length > 1000 && textOnly.length < 200) return true;

	// Common SPA root containers with no content
	if (/<div\s+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html)) return true;

	// Frameworks that inject content via JS bundles
	if (/<script[^>]*src=["'][^"']*(_app|main|bundle|chunk)[^"']*\.js["']/i.test(html)) {
		// Has framework bundles AND very little text
		if (textOnly.length < 500) return true;
	}

	return false;
}

/**
 * Attempts to fetch clean markdown via Firecrawl's scrape API.
 * Requires FIRECRAWL_API_KEY env var.
 * @param url - URL to scrape
 * @param signal - Abort signal for cancellation
 * @returns Markdown content or null if unavailable
 */
async function tryFirecrawl(url: string, signal?: AbortSignal): Promise<string | null> {
	const apiKey = process.env.FIRECRAWL_API_KEY;
	if (!apiKey) return null;

	try {
		const response = await fetch(FIRECRAWL_API_URL, {
			method: "POST",
			signal,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				url,
				formats: ["markdown"],
				onlyMainContent: true,
			}),
		});

		if (!response.ok) return null;

		const data = (await response.json()) as {
			success?: boolean;
			data?: { markdown?: string };
		};

		return data.success && data.data?.markdown ? data.data.markdown : null;
	} catch {
		return null;
	}
}

/**
 * Registers the web-fetch tool.
 * @param pi - Extension API for registering tools
 */
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web-fetch",
		label: "WebFetch",
		description: `Fetch content from a URL. Returns the page text, truncated to 100KB by default.

If FIRECRAWL_API_KEY is set and content exceeds the limit, automatically falls back
to Firecrawl for clean markdown extraction.

WHEN TO USE:
- Need to read web page content
- Fetching documentation or articles
- Checking API responses`,
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			maxBytes: Type.Optional(
				Type.Number({ description: "Max bytes before truncation (default 100KB)" })
			),
			format: Type.Optional(
				Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
					description: 'Output format hint: "text" (default), "markdown", or "html"',
				})
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;

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
				const isHtml = contentType.includes("text/html");
				const fullText = await response.text();
				const totalBytes = new TextEncoder().encode(fullText).length;
				const truncated = totalBytes > maxBytes;

				// Detect JS-dependent pages (SPAs, empty shells) even under size limit
				const jsDependent = isHtml && !truncated && looksLikeJsRequired(fullText);

				// Try Firecrawl when: content is truncated, OR page needs JS rendering
				if ((truncated || jsDependent) && isHtml) {
					const reason = jsDependent
						? "Page appears to require JavaScript rendering."
						: `Content truncated (${(totalBytes / 1024).toFixed(1)}KB > ${(maxBytes / 1024).toFixed(1)}KB).`;

					onUpdate?.({
						details: {},
						content: [
							{
								type: "text",
								text: `${reason} Trying Firecrawl...`,
							},
						],
					});

					const markdown = await tryFirecrawl(params.url, signal ?? undefined);
					if (markdown) {
						return {
							content: [{ type: "text", text: markdown }],
							details: {
								url: params.url,
								source: "firecrawl",
								originalBytes: totalBytes,
								format: "markdown",
								reason: jsDependent ? "js-required" : "truncated",
							},
						};
					}
				}

				// Return content, truncated if necessary
				let content = truncated ? fullText.slice(0, maxBytes) : fullText;

				if (truncated) {
					content += `\n\n[Truncated: showing ${(maxBytes / 1024).toFixed(1)}KB of ${(totalBytes / 1024).toFixed(1)}KB]`;
					if (!process.env.FIRECRAWL_API_KEY) {
						content += "\n[Tip: Set FIRECRAWL_API_KEY for automatic full-page markdown extraction]";
					} else if (isHtml) {
						content += "\n[Firecrawl fallback failed]";
					}
				}

				return {
					content: [{ type: "text", text: content }],
					details: {
						url: params.url,
						status: response.status,
						contentType,
						totalBytes,
						truncated,
						source: "fetch",
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
			const url = args.url.length > 60 ? `${args.url.slice(0, 60)}...` : args.url;
			return new Text(
				theme.fg("toolTitle", theme.bold("web-fetch ")) + theme.fg("accent", url),
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
						source?: string;
						totalBytes?: number;
						truncated?: boolean;
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
				const source = details.source === "firecrawl" ? " via Firecrawl" : "";
				const size = details.totalBytes ? ` (${(details.totalBytes / 1024).toFixed(1)}KB)` : "";
				const truncNote = details.truncated && details.source !== "firecrawl" ? " [truncated]" : "";
				footer =
					theme.fg("success", `${getIcon("success")} `) +
					theme.fg("dim", details.url ?? "") +
					theme.fg("muted", size + source + truncNote);
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
