import { describe, expect, it } from "bun:test";

/**
 * coerceArray — extracted from subagent/index.ts for testability.
 *
 * LLMs sometimes pass complex nested parameters as a serialized JSON string
 * instead of a proper array. When that happens, `.length` returns the character
 * count of the string (e.g. 8975) rather than the element count.
 */
function coerceArray<T>(value: T[] | string | undefined | null): T[] | undefined {
	if (value == null) return undefined;
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed as T[];
		} catch {
			/* not valid JSON */
		}
	}
	return undefined;
}

describe("coerceArray", () => {
	it("passes through a real array unchanged", () => {
		const input = [
			{ agent: "worker", task: "do stuff" },
			{ agent: "worker", task: "do more stuff" },
		];
		expect(coerceArray(input)).toBe(input);
	});

	it("returns undefined for null", () => {
		expect(coerceArray(null)).toBeUndefined();
	});

	it("returns undefined for undefined", () => {
		expect(coerceArray(undefined)).toBeUndefined();
	});

	it("parses a JSON string containing an array", () => {
		const tasks = [
			{ agent: "worker", task: "explore extensions" },
			{ agent: "worker", task: "explore packages" },
		];
		const jsonString = JSON.stringify(tasks);
		const result = coerceArray(jsonString);

		expect(result).toEqual(tasks);
		expect(result).not.toBe(tasks); // should be a new array from parse
	});

	it("returns correct element count, not character count, for JSON strings", () => {
		// This is the exact bug: a JSON string of 2 tasks with long prompts
		// has thousands of characters, but should yield .length === 2
		const longTask = "A".repeat(4000);
		const tasks = [
			{ agent: "worker", task: longTask },
			{ agent: "worker", task: longTask },
		];
		const jsonString = JSON.stringify(tasks);

		// The string is ~8000+ chars — this was showing as "8975 tasks"
		expect(jsonString.length).toBeGreaterThan(8000);

		const result = coerceArray(jsonString);
		expect(result).toBeDefined();
		expect(result?.length).toBe(2); // NOT 8000+
	});

	it("returns undefined for a non-JSON string", () => {
		expect(coerceArray("not json at all")).toBeUndefined();
	});

	it("returns undefined for a JSON string that is not an array", () => {
		expect(coerceArray(JSON.stringify({ agent: "worker" }))).toBeUndefined();
		expect(coerceArray(JSON.stringify("hello"))).toBeUndefined();
		expect(coerceArray(JSON.stringify(42))).toBeUndefined();
	});

	it("handles empty array", () => {
		expect(coerceArray([])).toEqual([]);
	});

	it("handles JSON string of empty array", () => {
		expect(coerceArray("[]")).toEqual([]);
	});

	it("handles single-element array as string", () => {
		const tasks = [{ agent: "worker", task: "single task" }];
		expect(coerceArray(JSON.stringify(tasks))).toEqual(tasks);
	});

	it("preserves all task fields when parsing from string", () => {
		const tasks = [
			{ agent: "researcher", task: "analyze code", cwd: "/tmp" },
			{ agent: "writer", task: "write docs" },
		];
		const result = coerceArray(JSON.stringify(tasks));
		expect(result).toEqual(tasks);
		expect(result?.[0].cwd).toBe("/tmp");
		expect(result?.[1].cwd).toBeUndefined();
	});
});
