/**
 * Tests for the Brave Search provider.
 *
 * Uses fetch mocking to test API interaction, error handling,
 * and result parsing without hitting the real API.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { BraveSearchProvider } from "../providers/brave.js";
import { SearchError } from "../providers/interface.js";

let provider: BraveSearchProvider;
let originalFetch: typeof globalThis.fetch;
let originalEnv: string | undefined;

beforeEach(() => {
	provider = new BraveSearchProvider();
	originalFetch = globalThis.fetch;
	originalEnv = process.env.BRAVE_API_KEY;
	process.env.BRAVE_API_KEY = "test-key-123";
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalEnv !== undefined) {
		process.env.BRAVE_API_KEY = originalEnv;
	} else {
		delete process.env.BRAVE_API_KEY;
	}
});

// ── Availability ─────────────────────────────────────────────────────────────

describe("isAvailable", () => {
	test("returns true when BRAVE_API_KEY is set", () => {
		process.env.BRAVE_API_KEY = "some-key";
		expect(provider.isAvailable()).toBe(true);
	});

	test("returns false when BRAVE_API_KEY is missing", () => {
		delete process.env.BRAVE_API_KEY;
		expect(provider.isAvailable()).toBe(false);
	});

	test("returns false when BRAVE_API_KEY is empty", () => {
		process.env.BRAVE_API_KEY = "";
		expect(provider.isAvailable()).toBe(false);
	});
});

// ── Successful search ────────────────────────────────────────────────────────

describe("search", () => {
	test("returns parsed results from Brave API", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						web: {
							results: [
								{
									title: "TypeScript Handbook",
									url: "https://www.typescriptlang.org/docs/",
									description: "The TypeScript Handbook is a comprehensive guide.",
									meta_url: { hostname: "www.typescriptlang.org" },
									page_age: "2024-01-15",
								},
								{
									title: "TS Playground",
									url: "https://www.typescriptlang.org/play",
									description: "Try TypeScript in the browser.",
									meta_url: { hostname: "www.typescriptlang.org" },
								},
							],
							total_count: 12345,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				)
			)
		) as typeof fetch;

		const response = await provider.search({ query: "typescript handbook" });

		expect(response.provider).toBe("Brave");
		expect(response.results).toHaveLength(2);
		expect(response.totalEstimated).toBe(12345);

		const first = response.results[0];
		expect(first.title).toBe("TypeScript Handbook");
		expect(first.url).toBe("https://www.typescriptlang.org/docs/");
		expect(first.snippet).toContain("comprehensive guide");
		expect(first.domain).toBe("www.typescriptlang.org");
		expect(first.date).toBe("2024-01-15");

		expect(response.results[1].date).toBeUndefined();
	});

	test("sends correct headers and query params", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url.toString();
			capturedHeaders = Object.fromEntries(
				Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)])
			);
			return Promise.resolve(
				new Response(JSON.stringify({ web: { results: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			);
		}) as typeof fetch;

		await provider.search({ query: "test query", maxResults: 3, freshness: "week" });

		expect(capturedUrl).toContain("q=test+query");
		expect(capturedUrl).toContain("count=3");
		expect(capturedUrl).toContain("freshness=pw");
		expect(capturedHeaders["X-Subscription-Token"]).toBe("test-key-123");
	});

	test("caps maxResults at 20", async () => {
		let capturedUrl = "";

		globalThis.fetch = mock((url: string | URL | Request) => {
			capturedUrl = url.toString();
			return Promise.resolve(
				new Response(JSON.stringify({ web: { results: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			);
		}) as typeof fetch;

		await provider.search({ query: "test", maxResults: 50 });

		expect(capturedUrl).toContain("count=20");
	});

	test("handles empty results gracefully", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ web: { results: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			)
		) as typeof fetch;

		const response = await provider.search({ query: "obscure query" });

		expect(response.results).toHaveLength(0);
		expect(response.provider).toBe("Brave");
	});
});

// ── Error handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
	test("throws missing_api_key when no key set", async () => {
		delete process.env.BRAVE_API_KEY;

		try {
			await provider.search({ query: "test" });
			expect(true).toBe(false); // should not reach
		} catch (err) {
			expect(err).toBeInstanceOf(SearchError);
			expect((err as SearchError).code).toBe("missing_api_key");
		}
	});

	test("throws auth_failed on 401", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Unauthorized", { status: 401 }))
		) as typeof fetch;

		try {
			await provider.search({ query: "test" });
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(SearchError);
			expect((err as SearchError).code).toBe("auth_failed");
		}
	});

	test("throws rate_limited on 429", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Too Many Requests", { status: 429 }))
		) as typeof fetch;

		try {
			await provider.search({ query: "test" });
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(SearchError);
			expect((err as SearchError).code).toBe("rate_limited");
		}
	});

	test("throws network error on fetch failure", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new Error("DNS resolution failed"))
		) as typeof fetch;

		try {
			await provider.search({ query: "test" });
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(SearchError);
			expect((err as SearchError).code).toBe("network");
			expect((err as SearchError).message).toContain("DNS resolution failed");
		}
	});

	test("re-throws AbortError without wrapping", async () => {
		const abortError = new DOMException("The operation was aborted", "AbortError");
		globalThis.fetch = mock(() => Promise.reject(abortError)) as typeof fetch;

		try {
			await provider.search({ query: "test" });
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBe(abortError);
			expect(err).not.toBeInstanceOf(SearchError);
		}
	});
});

// ── Result parsing edge cases ────────────────────────────────────────────────

describe("result parsing", () => {
	test("handles missing fields with fallbacks", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						web: {
							results: [{ url: "https://example.com" }],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				)
			)
		) as typeof fetch;

		const response = await provider.search({ query: "test" });
		const result = response.results[0];

		expect(result.title).toBe("(no title)");
		expect(result.snippet).toBe("");
		expect(result.domain).toBe("example.com");
		expect(result.date).toBeUndefined();
	});
});
