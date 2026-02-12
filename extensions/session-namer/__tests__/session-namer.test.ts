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
