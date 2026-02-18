/**
 * WebFetch Extension for Pi
 *
 * Fetches web content via plain HTTP. Returns page text truncated to 50KB.
 * For JS-rendered pages, full-page scraping, or structured extraction,
 * use a dedicated scraping tool (e.g. Firecrawl) instead.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import { renderLines } from "../tool-display/index.js";

const DEFAULT_MAX_BYTES = 50_000;

/**
 * Registers the web_fetch tool.
 * @param pi - Extension API for registering tools
 */
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "web_fetch",
		description: `Fetch content from a URL. Returns the page text, truncated to 50KB by default.

WHEN TO USE:
- Need to read web page content
- Fetching documentation or articles
- Checking API responses`,
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			maxBytes: Type.Optional(
				Type.Number({ description: "Max bytes before truncation (default 50KB)" })
			),
			format: Type.Optional(
				Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
					description: 'Output format hint: "text" (default), "markdown", or "html"',
				})
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate) {
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
				const fullText = await response.text();
				const totalBytes = new TextEncoder().encode(fullText).length;
				const truncated = totalBytes > maxBytes;

				let content = truncated ? fullText.slice(0, maxBytes) : fullText;

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
				footer =
					theme.fg("success", `${getIcon("success")} `) +
					theme.fg("dim", details.url ?? "") +
					theme.fg("muted", size + truncNote);
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
