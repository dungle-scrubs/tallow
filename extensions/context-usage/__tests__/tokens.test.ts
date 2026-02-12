/**
 * Tests for context-usage token estimation: estimateTokensFromText,
 * formatTokens, and parsePromptSections.
 */
import { describe, expect, it } from "bun:test";
import { estimateTokensFromText, formatTokens, parsePromptSections } from "../index.js";

// ── estimateTokensFromText ───────────────────────────────────────────────────

describe("estimateTokensFromText", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokensFromText("")).toBe(0);
	});

	it("estimates 1 token for 1 char", () => {
		expect(estimateTokensFromText("a")).toBe(1);
	});

	it("estimates 1 token for 3 chars (ceil(3/4))", () => {
		expect(estimateTokensFromText("abc")).toBe(1);
	});

	it("estimates 1 token for 4 chars", () => {
		expect(estimateTokensFromText("abcd")).toBe(1);
	});

	it("estimates 100 tokens for 400 chars", () => {
		expect(estimateTokensFromText("a".repeat(400))).toBe(100);
	});

	it("rounds up partial tokens", () => {
		expect(estimateTokensFromText("a".repeat(5))).toBe(2);
	});
});

// ── formatTokens ─────────────────────────────────────────────────────────────

describe("formatTokens", () => {
	it("formats small numbers as-is", () => {
		expect(formatTokens(500)).toBe("500");
	});

	it("formats 0", () => {
		expect(formatTokens(0)).toBe("0");
	});

	it("formats thousands with decimal k", () => {
		expect(formatTokens(5000)).toBe("5.0k");
	});

	it("formats 10k+ with rounded k", () => {
		expect(formatTokens(15000)).toBe("15k");
	});

	it("formats millions with M suffix", () => {
		expect(formatTokens(1500000)).toBe("1.5M");
	});

	it("formats 999 without suffix", () => {
		expect(formatTokens(999)).toBe("999");
	});
});

// ── parsePromptSections ──────────────────────────────────────────────────────

describe("parsePromptSections", () => {
	it("handles empty prompt", () => {
		const result = parsePromptSections("");
		expect(result.basePromptTokens).toBe(0);
		expect(result.contextFileTokens).toBe(0);
		expect(result.skillTokens).toBe(0);
	});

	it("assigns all tokens to base for plain prompt", () => {
		const prompt = "You are a helpful assistant. Follow these rules.";
		const result = parsePromptSections(prompt);
		expect(result.basePromptTokens).toBe(estimateTokensFromText(prompt));
		expect(result.contextFileTokens).toBe(0);
		expect(result.skillTokens).toBe(0);
	});

	it("detects available_skills section", () => {
		const prompt = "Base instructions.\n<available_skills>\nskill1\nskill2\n</available_skills>";
		const result = parsePromptSections(prompt);
		expect(result.skillTokens).toBeGreaterThan(0);
		expect(result.basePromptTokens).toBeGreaterThan(0);
	});

	it("detects Additional Project Context section", () => {
		const prompt = "Base.\n# Additional Project Context\nSome project info and context files here.";
		const result = parsePromptSections(prompt);
		expect(result.contextFileTokens).toBeGreaterThan(0);
	});

	it("detects Project Context section as fallback", () => {
		const prompt = "Base.\n# Project Context\nSome context data.";
		const result = parsePromptSections(prompt);
		expect(result.contextFileTokens).toBeGreaterThan(0);
	});

	it("splits tokens across all sections", () => {
		const prompt =
			"Base instructions here.\n# Additional Project Context\nContext data.\n<available_skills>\nskills data\n</available_skills>";
		const result = parsePromptSections(prompt);
		const total = result.basePromptTokens + result.contextFileTokens + result.skillTokens;
		expect(total).toBe(estimateTokensFromText(prompt));
	});
});
