import { describe, expect, test } from "bun:test";
import { assertValidSessionId, createSessionWithId } from "../session-utils.js";

describe("assertValidSessionId", () => {
	test("accepts common session IDs", () => {
		expect(() => assertValidSessionId("my-ci-run-42")).not.toThrow();
		expect(() => assertValidSessionId("release_2026.02.22")).not.toThrow();
	});

	test("rejects empty IDs", () => {
		expect(() => assertValidSessionId("")).toThrow("Session ID cannot be empty");
		expect(() => assertValidSessionId("   ")).toThrow("Session ID cannot be empty");
	});

	test("rejects forward and backward slashes", () => {
		expect(() => assertValidSessionId("../../escape")).toThrow(
			"Session ID cannot contain path separators"
		);
		expect(() => assertValidSessionId("..\\..\\escape")).toThrow(
			"Session ID cannot contain path separators"
		);
	});

	test("createSessionWithId rejects unsafe IDs before file operations", () => {
		expect(() => createSessionWithId("..//escape", process.cwd())).toThrow(
			"Session ID cannot contain path separators"
		);
	});
});
