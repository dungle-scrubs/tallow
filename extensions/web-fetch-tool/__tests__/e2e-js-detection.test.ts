/**
 * E2E tests for JS-dependent page detection.
 *
 * Fetches real URLs known to return empty SPA shells without JS execution,
 * then verifies the heuristic correctly identifies them.
 */

import { describe, expect, it } from "bun:test";

// ── Inline heuristic (mirrors index.ts) ─────────────────────

function looksLikeJsRequired(html: string): boolean {
	const textOnly = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (html.length > 1000 && textOnly.length < 200) return true;
	if (/<div\s+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html)) return true;
	if (/<script[^>]*src=["'][^"']*(_app|main|bundle|chunk)[^"']*\.js["']/i.test(html)) {
		if (textOnly.length < 500) return true;
	}

	return false;
}

const FETCH_OPTS = {
	headers: {
		"User-Agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	},
	redirect: "follow" as const,
};

// ════════════════════════════════════════════════════════════════
// Known JS-dependent SPAs (should trigger)
// ════════════════════════════════════════════════════════════════

describe("E2E: JS-dependent pages (should trigger Firecrawl)", () => {
	it("excalidraw.com — React SPA with empty #root", async () => {
		const res = await fetch("https://excalidraw.com", FETCH_OPTS);
		const html = await res.text();

		expect(res.ok).toBe(true);
		expect(looksLikeJsRequired(html)).toBe(true);
		expect(html).toContain('id="root"');
	}, 15_000);

	it("play.vuejs.org — Vue SPA with empty #app", async () => {
		const res = await fetch("https://play.vuejs.org", FETCH_OPTS);
		const html = await res.text();

		expect(res.ok).toBe(true);
		expect(looksLikeJsRequired(html)).toBe(true);
		expect(html).toContain('id="app"');
	}, 15_000);

	it("miro.com/app — React SPA with empty #root and zero text", async () => {
		const res = await fetch("https://miro.com/app/", FETCH_OPTS);
		const html = await res.text();

		expect(res.ok).toBe(true);
		expect(looksLikeJsRequired(html)).toBe(true);
	}, 15_000);

	it("app.diagrams.net — draw.io SPA with bundle scripts", async () => {
		const res = await fetch("https://app.diagrams.net", FETCH_OPTS);
		const html = await res.text();

		expect(res.ok).toBe(true);
		expect(looksLikeJsRequired(html)).toBe(true);
	}, 15_000);
});

// ════════════════════════════════════════════════════════════════
// Known SSR/static pages (should NOT trigger)
// ════════════════════════════════════════════════════════════════

describe("E2E: server-rendered pages (should NOT trigger Firecrawl)", () => {
	it("example.com — plain static HTML", async () => {
		const res = await fetch("https://example.com", FETCH_OPTS);
		const html = await res.text();

		expect(res.ok).toBe(true);
		expect(looksLikeJsRequired(html)).toBe(false);
	}, 15_000);

	it("github.com — SSR with full content", async () => {
		const res = await fetch("https://github.com/trending", FETCH_OPTS);
		const html = await res.text();

		expect(res.ok).toBe(true);
		expect(looksLikeJsRequired(html)).toBe(false);
	}, 15_000);

	it("en.wikipedia.org — static content-heavy page", async () => {
		const res = await fetch("https://en.wikipedia.org/wiki/HTML", FETCH_OPTS);
		const html = await res.text();

		expect(res.ok).toBe(true);
		expect(looksLikeJsRequired(html)).toBe(false);
	}, 15_000);
});
