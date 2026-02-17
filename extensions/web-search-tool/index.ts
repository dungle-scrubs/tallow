/**
 * Web Search Tool Extension
 *
 * Registers a `web_search` tool that lets the agent search the web
 * via configured search providers. Currently supports Brave Search;
 * additional providers can be added by implementing SearchProvider.
 *
 * API keys are read from environment variables at call time:
 * - Brave: BRAVE_API_KEY
 *
 * Results are rendered with clickable OSC 8 hyperlinks and metadata.
 */

import type { ExtensionAPI, ThemeColor } from "@mariozechner/pi-coding-agent";
import { hyperlink, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import { formatToolVerb, renderLines } from "../tool-display/index.js";
import { BraveSearchProvider } from "./providers/brave.js";
import { SearchError, type SearchProvider, type SearchResult } from "./providers/interface.js";

/**
 * Resolve the first available search provider.
 * Checks providers in priority order and returns the first
 * one whose API key is configured.
 *
 * @param providers - Ordered list of providers to check
 * @returns The first available provider, or null
 */
function resolveProvider(providers: SearchProvider[]): SearchProvider | null {
	for (const p of providers) {
		if (p.isAvailable()) return p;
	}
	return null;
}

/**
 * Format a single search result for TUI display.
 * Renders title as an OSC 8 hyperlink, domain + date as metadata,
 * and snippet as dimmed text.
 *
 * @param result - Search result to format
 * @param index - 1-based result number
 * @param fg - Theme fg color function
 * @returns Array of styled lines for this result
 */
function formatResult(
	result: SearchResult,
	index: number,
	fg: (color: ThemeColor, text: string) => string
): string[] {
	const title = hyperlink(result.url, result.title);
	const meta = [result.domain, result.date].filter(Boolean).join(" · ");
	const lines: string[] = [];

	lines.push(fg("accent", `${index}. `) + title);
	if (meta) lines.push(fg("dim", `   ${meta}`));
	if (result.snippet) lines.push(fg("muted", `   ${result.snippet}`));

	return lines;
}

/**
 * Registers the web_search tool and its renderer.
 *
 * @param pi - Extension API for tool registration
 */
export default function webSearchTool(pi: ExtensionAPI): void {
	const providers: SearchProvider[] = [new BraveSearchProvider()];

	pi.registerTool({
		name: "web_search",
		label: "web_search",
		description: `Search the web for current information. Returns titles, URLs, snippets, and metadata.

Requires BRAVE_API_KEY environment variable (free at https://api.search.brave.com/register).

WHEN TO USE:
- Need current information beyond training data
- Looking up error messages or stack traces
- Finding documentation URLs for unfamiliar libraries
- Checking latest versions or release notes
- Researching recent technologies or announcements

WHEN NOT TO USE:
- You already have the URL (use web_fetch instead)
- The information is in the project's codebase (use grep/find)
- Looking up well-known, stable APIs from training data`,
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			maxResults: Type.Optional(
				Type.Number({ description: "Max results to return (default: 5, max: 20)" })
			),
			freshness: Type.Optional(
				Type.Union(
					[Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
					{ description: 'Restrict to recent results: "day", "week", "month", or "year"' }
				)
			),
		}),

		renderCall(args, theme) {
			const query = args.query ?? "";
			const verb = formatToolVerb("web_search", false);
			return new Text(
				theme.fg("toolTitle", theme.bold(`${verb} `)) + theme.fg("muted", `"${query}"`),
				0,
				0
			);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query?.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "Search query cannot be empty." }],
					details: { error: "empty_query" },
					isError: true,
				};
			}

			ctx.ui.setWorkingMessage(`Searching: ${query.slice(0, 50)}`);

			const provider = resolveProvider(providers);
			if (!provider) {
				ctx.ui.setWorkingMessage();
				return {
					content: [
						{
							type: "text",
							text:
								"No search provider configured. Set one of these environment variables:\n" +
								"- BRAVE_API_KEY (free at https://api.search.brave.com/register)",
						},
					],
					details: { error: "no_provider" },
					isError: true,
				};
			}

			try {
				const response = await provider.search(
					{
						query,
						maxResults: params.maxResults,
						freshness: params.freshness as "day" | "week" | "month" | "year" | undefined,
					},
					signal ?? undefined
				);

				ctx.ui.setWorkingMessage();

				if (response.results.length === 0) {
					return {
						content: [{ type: "text", text: `No results found for "${query}".` }],
						details: { provider: response.provider, query, resultCount: 0 },
					};
				}

				// Build text output for the LLM
				const textLines = response.results.map(
					(r, i) =>
						`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}${r.date ? `\n   Date: ${r.date}` : ""}`
				);
				const text = textLines.join("\n\n");

				return {
					content: [{ type: "text", text }],
					details: {
						provider: response.provider,
						query,
						resultCount: response.results.length,
						totalEstimated: response.totalEstimated,
						results: response.results,
					},
				};
			} catch (err: unknown) {
				ctx.ui.setWorkingMessage();

				if (err instanceof SearchError) {
					return {
						content: [{ type: "text", text: err.message }],
						details: { error: err.code, provider: provider.name },
						isError: true,
					};
				}

				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Search failed: ${msg}` }],
					details: { error: "unknown", provider: provider.name },
					isError: true,
				};
			}
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						error?: string;
						provider?: string;
						query?: string;
						resultCount?: number;
						results?: SearchResult[];
				  }
				| undefined;

			// Error state
			if (details?.error) {
				const text = result.content[0];
				const msg = text?.type === "text" ? text.text : "Search failed";
				return renderLines([theme.fg("error", `${getIcon("error")} ${msg}`)]);
			}

			const results = details?.results ?? [];
			const count = details?.resultCount ?? results.length;
			const provider = details?.provider ?? "Search";
			const verb = formatToolVerb("web_search", true);
			const footer = theme.fg(
				"muted",
				`${getIcon("success")} ${verb} via ${provider} (${count} result${count === 1 ? "" : "s"})`
			);

			// Expanded: show all results with hyperlinks
			if (expanded && results.length > 0) {
				const lines: string[] = [];
				for (let i = 0; i < results.length; i++) {
					if (i > 0) lines.push("");
					lines.push(...formatResult(results[i], i + 1, theme.fg.bind(theme)));
				}
				lines.push("");
				lines.push(footer);
				return renderLines(lines);
			}

			// Collapsed: footer only
			return renderLines([footer]);
		},
	});
}
