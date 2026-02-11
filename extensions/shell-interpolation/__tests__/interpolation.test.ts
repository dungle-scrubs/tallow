import { describe, expect, test } from "bun:test";
import { expandShellCommands } from "../index.js";

const CWD = process.cwd();

describe("expandShellCommands", () => {
	test("expands single command", () => {
		const result = expandShellCommands("Hello !`echo world`", CWD);
		expect(result).toBe("Hello world");
	});

	test("expands multiple commands in one input", () => {
		const result = expandShellCommands("!`echo foo` and !`echo bar`", CWD);
		expect(result).toBe("foo and bar");
	});

	test("passes through input with no patterns", () => {
		const input = "just a normal message with no patterns";
		expect(expandShellCommands(input, CWD)).toBe(input);
	});

	test("replaces failed commands with error marker", () => {
		const result = expandShellCommands("!`__nonexistent_cmd_9999__`", CWD);
		expect(result).toBe("[error: command failed: __nonexistent_cmd_9999__]");
	});

	test("trims trailing newlines from output", () => {
		// echo adds a trailing newline; trimEnd() should strip it
		const result = expandShellCommands("!`echo hello`", CWD);
		expect(result).toBe("hello");
		expect(result.endsWith("\n")).toBe(false);
	});

	test("handles empty backticks (no match)", () => {
		const input = "!`` should not match";
		expect(expandShellCommands(input, CWD)).toBe(input);
	});

	test("handles command with leading/trailing spaces", () => {
		const result = expandShellCommands("!`  echo trimmed  `", CWD);
		expect(result).toBe("trimmed");
	});

	test("is non-recursive (output not re-scanned)", () => {
		// printf outputs a string containing the !`...` pattern.
		// Hex \x60 = backtick, avoiding literal backticks in the input command.
		// The output must NOT be re-expanded — prevents injection.
		const result = expandShellCommands("!`printf '!\\x60echo injected\\x60'`", CWD);
		expect(result).toBe("!`echo injected`");
	});

	test("handles command with spaces in arguments", () => {
		const result = expandShellCommands("!`echo hello world`", CWD);
		expect(result).toBe("hello world");
	});

	test("preserves surrounding text", () => {
		const result = expandShellCommands("before !`echo mid` after", CWD);
		expect(result).toBe("before mid after");
	});

	test("returns same reference for input without patterns", () => {
		const input = "no patterns here";
		const result = expandShellCommands(input, CWD);
		expect(result).toBe(input);
	});
});
