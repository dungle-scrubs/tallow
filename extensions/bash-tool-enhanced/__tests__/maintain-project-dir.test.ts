import { describe, expect, test } from "bun:test";
import { shellEscapePath } from "../index.js";

describe("shellEscapePath", () => {
	test("wraps simple path in single quotes", () => {
		expect(shellEscapePath("/usr/local/bin")).toBe("'/usr/local/bin'");
	});

	test("escapes single quotes in path", () => {
		expect(shellEscapePath("/tmp/it's a dir")).toBe("'/tmp/it'\\''s a dir'");
	});

	test("handles paths with spaces", () => {
		expect(shellEscapePath("/Users/john doe/project")).toBe("'/Users/john doe/project'");
	});

	test("handles paths with special characters", () => {
		expect(shellEscapePath("/tmp/$HOME/dir")).toBe("'/tmp/$HOME/dir'");
	});

	test("handles empty path", () => {
		expect(shellEscapePath("")).toBe("''");
	});

	test("handles path with multiple single quotes", () => {
		expect(shellEscapePath("a'b'c")).toBe("'a'\\''b'\\''c'");
	});
});
