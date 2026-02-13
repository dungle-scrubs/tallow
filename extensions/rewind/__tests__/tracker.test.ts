import { beforeEach, describe, expect, it } from "bun:test";
import type { RewindSnapshotEntry, ToolResultInput } from "../tracker.js";
import { FileTracker } from "../tracker.js";

describe("FileTracker", () => {
	let tracker: FileTracker;

	beforeEach(() => {
		tracker = new FileTracker();
	});

	it("should record file path from edit tool_result event", () => {
		tracker.onToolResult({
			toolName: "edit",
			input: { path: "src/index.ts", oldText: "foo", newText: "bar" },
			isError: false,
		});
		expect(tracker.getFilesForCurrentTurn()).toContain("src/index.ts");
	});

	it("should record file path from write tool_result event", () => {
		tracker.onToolResult({
			toolName: "write",
			input: { path: "new-file.ts", content: "..." },
			isError: false,
		});
		expect(tracker.getFilesForCurrentTurn()).toContain("new-file.ts");
	});

	it("should not record files from error results", () => {
		tracker.onToolResult({
			toolName: "edit",
			input: { path: "src/index.ts", oldText: "foo", newText: "bar" },
			isError: true,
		});
		expect(tracker.getFilesForCurrentTurn()).toHaveLength(0);
	});

	it("should not record read-only tools", () => {
		tracker.onToolResult({
			toolName: "read",
			input: { path: "src/index.ts" },
			isError: false,
		});
		tracker.onToolResult({
			toolName: "grep",
			input: { pattern: "foo" },
			isError: false,
		});
		tracker.onToolResult({
			toolName: "bash",
			input: { command: "ls -la" },
			isError: false,
		});
		expect(tracker.getFilesForCurrentTurn()).toHaveLength(0);
	});

	it("should reset current turn files on advanceTurn()", () => {
		tracker.onToolResult({
			toolName: "edit",
			input: { path: "a.ts" },
			isError: false,
		});
		tracker.advanceTurn(1);
		expect(tracker.getFilesForCurrentTurn()).toHaveLength(0);
		expect(tracker.getFilesForTurn(1)).toContain("a.ts");
	});

	it("should deduplicate files within a turn", () => {
		tracker.onToolResult({ toolName: "edit", input: { path: "a.ts" }, isError: false });
		tracker.onToolResult({ toolName: "edit", input: { path: "a.ts" }, isError: false });
		tracker.onToolResult({ toolName: "write", input: { path: "a.ts" }, isError: false });
		expect(tracker.getFilesForCurrentTurn()).toHaveLength(1);
	});

	it("should track multiple files in the same turn", () => {
		tracker.onToolResult({ toolName: "edit", input: { path: "a.ts" }, isError: false });
		tracker.onToolResult({ toolName: "write", input: { path: "b.ts" }, isError: false });
		tracker.onToolResult({ toolName: "edit", input: { path: "c.ts" }, isError: false });
		expect(tracker.getFilesForCurrentTurn()).toHaveLength(3);
	});

	it("should return all turns ordered by index", () => {
		tracker.onToolResult({ toolName: "edit", input: { path: "a.ts" }, isError: false });
		tracker.advanceTurn(1);
		tracker.onToolResult({ toolName: "write", input: { path: "b.ts" }, isError: false });
		tracker.advanceTurn(3);
		tracker.onToolResult({ toolName: "edit", input: { path: "c.ts" }, isError: false });
		tracker.advanceTurn(2);

		const turns = tracker.getAllTurns();
		expect(turns).toHaveLength(3);
		expect(turns[0].turnIndex).toBe(1);
		expect(turns[1].turnIndex).toBe(2);
		expect(turns[2].turnIndex).toBe(3);
	});

	it("should not create a turn record when no files were modified", () => {
		tracker.advanceTurn(1);
		expect(tracker.getFilesForTurn(1)).toHaveLength(0);
		expect(tracker.getAllTurns()).toHaveLength(0);
	});

	it("should report hasCurrentTurnChanges correctly", () => {
		expect(tracker.hasCurrentTurnChanges()).toBe(false);
		tracker.onToolResult({ toolName: "edit", input: { path: "a.ts" }, isError: false });
		expect(tracker.hasCurrentTurnChanges()).toBe(true);
		tracker.advanceTurn(1);
		expect(tracker.hasCurrentTurnChanges()).toBe(false);
	});

	it("should ignore events with missing or empty path", () => {
		tracker.onToolResult({ toolName: "edit", input: {}, isError: false });
		tracker.onToolResult({ toolName: "write", input: { path: "" }, isError: false });
		tracker.onToolResult({
			toolName: "edit",
			input: { path: 42 },
			isError: false,
		} as unknown as ToolResultInput);
		expect(tracker.getFilesForCurrentTurn()).toHaveLength(0);
	});

	it("should restore state from persisted entries", () => {
		const entries: RewindSnapshotEntry[] = [
			{ turnIndex: 1, ref: "abc123", files: ["a.ts", "b.ts"], timestamp: 1000 },
			{ turnIndex: 3, ref: "def456", files: ["c.ts"], timestamp: 2000 },
		];
		tracker.restoreFromEntries(entries);

		expect(tracker.getFilesForTurn(1)).toEqual(["a.ts", "b.ts"]);
		expect(tracker.getFilesForTurn(3)).toEqual(["c.ts"]);
		expect(tracker.getAllTurns()).toHaveLength(2);
	});

	it("should reset all state", () => {
		tracker.onToolResult({ toolName: "edit", input: { path: "a.ts" }, isError: false });
		tracker.advanceTurn(1);
		tracker.onToolResult({ toolName: "write", input: { path: "b.ts" }, isError: false });

		tracker.reset();

		expect(tracker.getFilesForCurrentTurn()).toHaveLength(0);
		expect(tracker.getAllTurns()).toHaveLength(0);
	});
});
