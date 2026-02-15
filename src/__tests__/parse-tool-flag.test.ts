import { describe, expect, test } from "bun:test";
import { parseToolFlag } from "../sdk.js";

describe("parseToolFlag", () => {
	test("parses single tool name", () => {
		const tools = parseToolFlag("read");
		expect(tools).toHaveLength(1);
		expect((tools[0] as { name: string }).name).toBe("read");
	});

	test("parses comma-separated tool names", () => {
		const tools = parseToolFlag("read,grep,find");
		expect(tools).toHaveLength(3);
		const names = tools.map((t) => (t as { name: string }).name);
		expect(names).toEqual(["read", "grep", "find"]);
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
		expect(tools).toHaveLength(4);
		const names = tools.map((t) => (t as { name: string }).name);
		expect(names).toContain("read");
		expect(names).toContain("grep");
		expect(names).toContain("find");
		expect(names).toContain("ls");
	});

	test("resolves coding preset", () => {
		const tools = parseToolFlag("coding");
		expect(tools).toHaveLength(4);
		const names = tools.map((t) => (t as { name: string }).name);
		expect(names).toContain("read");
		expect(names).toContain("bash");
		expect(names).toContain("edit");
		expect(names).toContain("write");
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
