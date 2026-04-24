import { describe, expect, test } from "bun:test";
import { parseToolFlag } from "../sdk.js";

describe("parseToolFlag", () => {
	test("parses single tool name", () => {
		const tools = parseToolFlag("read");
		expect(tools).toEqual(["read"]);
	});

	test("parses comma-separated tool names", () => {
		const tools = parseToolFlag("read,grep,find");
		expect(tools).toEqual(["find", "grep", "read"]);
	});

	test("handles spaces around commas", () => {
		const tools = parseToolFlag("read , bash , edit");
		expect(tools).toHaveLength(3);
	});

	test("is case-insensitive", () => {
		const tools = parseToolFlag("READ,Bash");
		expect(tools).toHaveLength(2);
	});

	test("resolves readonly preset", () => {
		const tools = parseToolFlag("readonly");
		expect(tools).toEqual(["read", "grep", "find", "ls"]);
	});

	test("resolves coding preset", () => {
		const tools = parseToolFlag("coding");
		expect(tools).toEqual(["read", "bash", "edit", "write"]);
	});

	test("resolves none preset to empty array", () => {
		expect(parseToolFlag("none")).toEqual([]);
	});

	test("returns empty array for empty string", () => {
		expect(parseToolFlag("")).toEqual([]);
	});

	test("throws on unknown tool name", () => {
		expect(() => parseToolFlag("read,invalid")).toThrow(/Unknown tool.*invalid/);
	});

	test("error message lists valid names", () => {
		expect(() => parseToolFlag("bogus")).toThrow(/Valid names:/);
	});
});
