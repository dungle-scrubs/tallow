/**
 * Brave Search API provider.
 *
 * Uses the Brave Web Search API (https://api.search.brave.com).
 * Requires BRAVE_API_KEY environment variable.
 * Free tier: 2,000 queries/month, 1 query/second.
 */

import {
	SearchError,
	type SearchParams,
	type SearchProvider,
	type SearchResponse,
	type SearchResult,
} from "./interface.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";

/** Freshness filter values accepted by the Brave API. */
const FRESHNESS_MAP: Record<string, string> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

/** Shape of a single web result from the Brave API response. */
interface BraveWebResult {
	title?: string;
	url?: string;
	description?: string;
	meta_url?: { hostname?: string };
	page_age?: string;
}

/** Top-level shape of the Brave API JSON response. */
interface BraveApiResponse {
	web?: {
		results?: BraveWebResult[];
		total_count?: number;
	};
	query?: { original?: string };
}

/**
 * Parse a single Brave API result into our common SearchResult shape.
 *
 * @param raw - Raw result object from Brave API
 * @returns Normalized SearchResult
 */
function parseResult(raw: BraveWebResult): SearchResult {
	const url = raw.url ?? "";
	let domain = "";
	try {
		domain = raw.meta_url?.hostname ?? new URL(url).hostname;
	} catch {
		/* malformed URL — leave domain empty */
	}

	return {
		title: raw.title ?? "(no title)",
		url,
		snippet: raw.description ?? "",
		domain,
		date: raw.page_age ?? undefined,
	};
}

/**
 * Brave Search provider implementation.
 * Reads API key from BRAVE_API_KEY env var at call time (not import time)
 * so the key can be set after module load.
 */
export class BraveSearchProvider implements SearchProvider {
	readonly name = "Brave";

	/**
	 * Check if BRAVE_API_KEY is set.
	 *
	 * @returns True when the env var is present and non-empty
	 */
	isAvailable(): boolean {
		return Boolean(process.env.BRAVE_API_KEY);
	}

	/**
	 * Execute a web search via the Brave Search API.
	 *
	 * @param params - Query string, max results, and optional freshness filter
	 * @param signal - Abort signal for cancellation
	 * @returns Parsed search results
	 * @throws {SearchError} On missing key, auth failure, rate limit, or network error
	 */
	async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
		const apiKey = process.env.BRAVE_API_KEY;
		if (!apiKey) {
			throw new SearchError(
				"missing_api_key",
				"BRAVE_API_KEY environment variable is not set. " +
					"Get a free key at https://api.search.brave.com/register"
			);
		}

		const url = new URL(BRAVE_API_URL);
		url.searchParams.set("q", params.query);
		url.searchParams.set("count", String(Math.min(params.maxResults ?? 5, 20)));

		if (params.freshness && FRESHNESS_MAP[params.freshness]) {
			url.searchParams.set("freshness", FRESHNESS_MAP[params.freshness]);
		}

		let response: Response;
		try {
			response = await fetch(url.toString(), {
				signal,
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "gzip",
					"X-Subscription-Token": apiKey,
				},
			});
		} catch (err: unknown) {
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new SearchError(
				"network",
				`Brave Search request failed: ${err instanceof Error ? err.message : String(err)}`
			);
		}

		if (response.status === 401 || response.status === 403) {
			throw new SearchError("auth_failed", "Brave Search API key is invalid or expired");
		}
		if (response.status === 429) {
			throw new SearchError(
				"rate_limited",
				"Brave Search rate limit exceeded. Free tier: 1 req/sec, 2000/month"
			);
		}
		if (!response.ok) {
			throw new SearchError(
				"unknown",
				`Brave Search returned HTTP ${response.status}: ${response.statusText}`
			);
		}

		const data = (await response.json()) as BraveApiResponse;
		const results = (data.web?.results ?? []).map(parseResult);

		return {
			results,
			provider: this.name,
			totalEstimated: data.web?.total_count,
		};
	}
}
