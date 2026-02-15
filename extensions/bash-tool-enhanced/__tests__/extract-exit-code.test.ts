/**
 * Tests for extractExitCode — parses exit codes from bash output/error strings.
 */
import { describe, expect, it } from "bun:test";
import { extractExitCode } from "../index.js";

describe("extractExitCode", () => {
	it("extracts exit code from standard pi error format", () => {
		expect(extractExitCode("Command exited with code 1")).toBe(1);
		expect(extractExitCode("Command exited with code 127")).toBe(127);
		expect(extractExitCode("Command exited with code 0")).toBe(0);
	});

	it("extracts exit code embedded in larger output", () => {
		expect(extractExitCode("some output\nCommand exited with code 2\nmore text")).toBe(2);
	});

	it("returns 0 for normal output without exit code marker", () => {
		expect(extractExitCode("hello world\nall good")).toBe(0);
	});

	it("returns null for empty string", () => {
		expect(extractExitCode("")).toBeNull();
	});
});
