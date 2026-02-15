import { describe, expect, it } from "bun:test";
import { buildNamingPrompt, cleanName } from "../index.js";

describe("cleanName", () => {
	it("should pass through a clean name", () => {
		expect(cleanName("Refactoring auth middleware")).toBe("Refactoring auth middleware");
	});

	it("should strip surrounding double quotes", () => {
		expect(cleanName('"Refactoring auth middleware"')).toBe("Refactoring auth middleware");
	});

	it("should strip surrounding single quotes", () => {
		expect(cleanName("'Refactoring auth middleware'")).toBe("Refactoring auth middleware");
	});

	it("should strip Session: prefix", () => {
		expect(cleanName("Session: Refactoring auth")).toBe("Refactoring auth");
	});

	it("should strip Name: prefix (case-insensitive)", () => {
		expect(cleanName("name: Refactoring auth")).toBe("Refactoring auth");
	});

	it("should strip trailing periods and exclamation marks", () => {
		expect(cleanName("Refactoring auth middleware.")).toBe("Refactoring auth middleware");
		expect(cleanName("Refactoring auth middleware!!")).toBe("Refactoring auth middleware");
	});

	it("should handle combined issues (quotes + prefix + punctuation)", () => {
		expect(cleanName('"Session: Refactoring auth."')).toBe("Refactoring auth");
	});

	it("should trim whitespace", () => {
		expect(cleanName("  Refactoring auth  ")).toBe("Refactoring auth");
	});

	it("should return empty string for empty input", () => {
		expect(cleanName("")).toBe("");
		expect(cleanName("  ")).toBe("");
	});

	it("should reject refusal responses starting with 'I need'", () => {
		expect(
			cleanName(
				'I need a more substantial opening exchange to name this session. "test it out" is too vague.'
			)
		).toBe("");
	});

	it("should reject refusal responses with 'too vague'", () => {
		expect(cleanName("The input is too vague to generate a name")).toBe("");
	});

	it("should reject refusal responses asking for more context", () => {
		expect(cleanName("Could you provide more context about the task?")).toBe("");
	});

	it("should reject responses starting with 'Sorry'", () => {
		expect(cleanName("Sorry, I can't name this session")).toBe("");
	});

	it("should reject overly long names (>60 chars)", () => {
		expect(cleanName("x".repeat(61))).toBe("");
	});

	it("should accept names at exactly the max length", () => {
		const name = "x".repeat(60);
		expect(cleanName(name)).toBe(name);
	});

	it("should take only the first line of multi-line responses", () => {
		expect(cleanName("Good name\nThis is an explanation")).toBe("Good name");
	});

	it("should reject if first line of multi-line is itself a refusal", () => {
		expect(cleanName("I need more context\nPlease try again")).toBe("");
	});
});

describe("buildNamingPrompt", () => {
	it("should format user and assistant text", () => {
		const result = buildNamingPrompt("Fix the auth bug", "I'll look into the auth module...");
		expect(result).toBe("User: Fix the auth bug\n\nAssistant: I'll look into the auth module...");
	});

	it("should truncate assistant text beyond 500 chars", () => {
		const longText = "x".repeat(600);
		const result = buildNamingPrompt("Fix it", longText);
		expect(result).toContain("x".repeat(500));
		expect(result).toContain("…");
		expect(result).not.toContain("x".repeat(501));
	});

	it("should not truncate assistant text at exactly 500 chars", () => {
		const text = "x".repeat(500);
		const result = buildNamingPrompt("Fix it", text);
		expect(result).toBe(`User: Fix it\n\nAssistant: ${"x".repeat(500)}`);
	});
});
