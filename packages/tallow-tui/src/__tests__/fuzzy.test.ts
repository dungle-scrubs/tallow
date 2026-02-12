/**
 * Tests for tallow-tui fuzzy matching: fuzzyMatch scoring and fuzzyFilter ordering.
 */
import { describe, expect, it } from "bun:test";
import { fuzzyFilter, fuzzyMatch } from "../fuzzy.js";

// ── fuzzyMatch ───────────────────────────────────────────────────────────────

describe("fuzzyMatch", () => {
	it("matches exact string", () => {
		expect(fuzzyMatch("hello", "hello").matches).toBe(true);
	});

	it("matches subsequence", () => {
		expect(fuzzyMatch("hlo", "hello").matches).toBe(true);
	});

	it("rejects non-subsequence", () => {
		expect(fuzzyMatch("xyz", "hello").matches).toBe(false);
	});

	it("is case insensitive", () => {
		expect(fuzzyMatch("HEL", "hello").matches).toBe(true);
	});

	it("scores exact match at least as good as fuzzy", () => {
		const exact = fuzzyMatch("test", "test");
		const fuzzy = fuzzyMatch("test", "testing");
		expect(exact.score).toBeLessThanOrEqual(fuzzy.score);
	});

	it("scores word boundary matches better", () => {
		const boundary = fuzzyMatch("fb", "foo-bar");
		const middle = fuzzyMatch("fb", "fxxbxx");
		expect(boundary.score).toBeLessThan(middle.score);
	});

	it("matches empty query against anything", () => {
		expect(fuzzyMatch("", "anything").matches).toBe(true);
	});

	it("rejects query longer than text", () => {
		expect(fuzzyMatch("longer", "short").matches).toBe(false);
	});

	it("handles single character match", () => {
		expect(fuzzyMatch("h", "hello").matches).toBe(true);
	});

	it("matches consecutive characters better", () => {
		const consecutive = fuzzyMatch("hel", "hello");
		const scattered = fuzzyMatch("hlo", "hello");
		expect(consecutive.score).toBeLessThanOrEqual(scattered.score);
	});

	it("handles special characters in query", () => {
		expect(fuzzyMatch("foo-bar", "foo-bar-baz").matches).toBe(true);
	});

	it("rejects empty text with non-empty query", () => {
		expect(fuzzyMatch("a", "").matches).toBe(false);
	});
});

// ── fuzzyFilter ──────────────────────────────────────────────────────────────

describe("fuzzyFilter", () => {
	it("filters and sorts by score", () => {
		const items = ["foo-bar", "fxxbxx", "no-match"];
		const result = fuzzyFilter(items, "fb", (x) => x);
		expect(result).not.toContain("no-match");
		expect(result[0]).toBe("foo-bar");
	});

	it("returns all items for empty query", () => {
		const items = ["a", "b", "c"];
		expect(fuzzyFilter(items, "", (x) => x)).toHaveLength(3);
	});

	it("returns empty array when nothing matches", () => {
		const items = ["alpha", "beta", "gamma"];
		expect(fuzzyFilter(items, "xyz", (x) => x)).toHaveLength(0);
	});

	it("works with custom getText accessor", () => {
		const items = [{ name: "hello" }, { name: "world" }];
		const result = fuzzyFilter(items, "hel", (x) => x.name);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("hello");
	});
});
