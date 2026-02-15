/**
 * Search provider interface and shared types.
 *
 * Defines the contract that all search backends must implement,
 * plus the common result shape returned to the tool layer.
 */

/** A single search result with metadata. */
export interface SearchResult {
	/** Page title */
	title: string;
	/** Full URL */
	url: string;
	/** Text snippet / description */
	snippet: string;
	/** Domain name (e.g., "github.com") */
	domain: string;
	/** Publish or index date in ISO format, if available */
	date?: string;
}

/** Parameters passed to a search provider's search method. */
export interface SearchParams {
	/** The search query string */
	query: string;
	/** Maximum results to return (default: 5) */
	maxResults?: number;
	/** Freshness filter: restrict to recent results */
	freshness?: "day" | "week" | "month" | "year";
}

/** Successful search response from a provider. */
export interface SearchResponse {
	/** The results (may be empty) */
	results: SearchResult[];
	/** Which provider produced these results */
	provider: string;
	/** Total estimated results (if the API reports it) */
	totalEstimated?: number;
}

/** Error codes for structured error handling. */
export type SearchErrorCode =
	| "missing_api_key"
	| "rate_limited"
	| "auth_failed"
	| "network"
	| "unknown";

/**
 * Typed error for search provider failures.
 * Carries a machine-readable code alongside the human message.
 */
export class SearchError extends Error {
	readonly code: SearchErrorCode;

	/**
	 * @param code - Machine-readable error category
	 * @param message - Human-readable description
	 */
	constructor(code: SearchErrorCode, message: string) {
		super(message);
		this.name = "SearchError";
		this.code = code;
	}
}

/**
 * Contract for a web search backend.
 * Implementations handle API authentication, request building,
 * and response parsing for their specific service.
 */
export interface SearchProvider {
	/** Human-readable provider name (e.g., "Brave") */
	readonly name: string;

	/**
	 * Whether this provider is configured and ready to use.
	 * Typically checks for the presence of an API key.
	 *
	 * @returns True if the provider can accept search requests
	 */
	isAvailable(): boolean;

	/**
	 * Execute a web search.
	 *
	 * @param params - Query, result count, and optional filters
	 * @param signal - Abort signal for cancellation
	 * @returns Search results from this provider
	 * @throws {SearchError} On auth, rate-limit, or network failures
	 */
	search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse>;
}
