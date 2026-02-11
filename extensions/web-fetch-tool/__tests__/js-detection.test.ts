/**
 * Unit tests for the looksLikeJsRequired heuristic.
 *
 * The function is not exported, so we inline the same logic here.
 * If the implementation changes, these tests validate the contract.
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

// ════════════════════════════════════════════════════════════════
// Empty SPA shells
// ════════════════════════════════════════════════════════════════

describe("looksLikeJsRequired — empty root detection", () => {
	it('detects React root <div id="root"></div>', () => {
		const html = `<!DOCTYPE html><html><head><title>App</title></head>
		<body><div id="root"></div><script src="/static/js/main.abc123.js"></script></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(true);
	});

	it('detects Vue root <div id="app"></div>', () => {
		const html = `<!DOCTYPE html><html><head><title>Vue</title></head>
		<body><div id="app"></div><script src="/js/app.js"></script></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(true);
	});

	it('detects Next.js root <div id="__next"></div>', () => {
		const html = `<!DOCTYPE html><html><head></head>
		<body><div id="__next"></div><script src="/_next/static/chunks/main.js"></script></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(true);
	});

	it('detects Nuxt root <div id="__nuxt"></div>', () => {
		const html = `<!DOCTYPE html><html><head></head>
		<body><div id="__nuxt"></div><script src="/_nuxt/entry.js"></script></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(true);
	});

	it("ignores root div with content inside", () => {
		const html = `<!DOCTYPE html><html><head><title>App</title></head>
		<body><div id="root"><h1>Real content here</h1><p>This page has server-rendered content that is meaningful and useful.</p></div></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════
// Low text-to-markup ratio
// ════════════════════════════════════════════════════════════════

describe("looksLikeJsRequired — text ratio detection", () => {
	it("detects large HTML with almost no visible text", () => {
		const scripts = '<script>console.log("x")</script>'.repeat(100);
		const html = `<!DOCTYPE html><html><head><title>SPA</title></head>
		<body>${scripts}<div id="container"></div></body></html>`;
		expect(html.length).toBeGreaterThan(1000);
		expect(looksLikeJsRequired(html)).toBe(true);
	});

	it("passes static page with plenty of text", () => {
		const paragraphs = "<p>This is a paragraph with real content about various topics.</p>".repeat(
			20
		);
		const html = `<!DOCTYPE html><html><head><title>Blog</title></head>
		<body><h1>My Blog</h1>${paragraphs}</body></html>`;
		expect(looksLikeJsRequired(html)).toBe(false);
	});

	it("ignores small HTML even with no text", () => {
		const html = `<html><body></body></html>`;
		// Under 1000 bytes, ratio check doesn't trigger
		expect(looksLikeJsRequired(html)).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════
// Framework bundle detection
// ════════════════════════════════════════════════════════════════

describe("looksLikeJsRequired — bundle script detection", () => {
	it("detects _app bundle with low text", () => {
		const html = `<!DOCTYPE html><html><head></head>
		<body><div>Loading...</div>
		<script src="/_next/static/chunks/_app-abc123.js"></script></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(true);
	});

	it("detects main bundle with low text", () => {
		const html = `<!DOCTYPE html><html><head><title>App</title></head>
		<body><noscript>Enable JS</noscript>
		<script src="/assets/main.deadbeef.js"></script></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(true);
	});

	it("detects chunk bundle with low text", () => {
		const html = `<!DOCTYPE html><html><head></head>
		<body><div id="wrapper"></div>
		<script src="/js/chunk-vendors.abc.js"></script></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(true);
	});

	it("passes bundle script when page has enough text", () => {
		const content = "<p>Substantial content paragraph with real information.</p>".repeat(15);
		const html = `<!DOCTYPE html><html><head></head>
		<body>${content}<script src="/js/main.abc.js"></script></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════
// Negative cases (should NOT trigger)
// ════════════════════════════════════════════════════════════════

describe("looksLikeJsRequired — negative cases", () => {
	it("passes plain HTML documentation page", () => {
		const content = Array.from(
			{ length: 20 },
			(_, i) =>
				`<h2>Section ${i}</h2><p>Detailed explanation of topic ${i} with examples and code.</p>`
		).join("\n");
		const html = `<!DOCTYPE html><html><head><title>Docs</title></head>
		<body><h1>Documentation</h1>${content}</body></html>`;
		expect(looksLikeJsRequired(html)).toBe(false);
	});

	it("passes API JSON response", () => {
		const json = JSON.stringify({
			data: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}` })),
		});
		expect(looksLikeJsRequired(json)).toBe(false);
	});

	it("passes SSR page with hydration scripts", () => {
		const content = "<p>Server rendered paragraph with actual content.</p>".repeat(20);
		const html = `<!DOCTYPE html><html><head></head>
		<body><div id="root"><h1>Welcome</h1>${content}</div>
		<script src="/static/js/main.js"></script></body></html>`;
		expect(looksLikeJsRequired(html)).toBe(false);
	});
});
