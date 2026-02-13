/**
 * Tests for tasks extension pure functions: text extraction, completion finding,
 * agent classification, and regex escaping.
 */
import { describe, expect, it } from "bun:test";
import {
	_extractTasksFromText,
	classifyAgent,
	escapeRegex,
	findCompletedTasks,
	shouldClearOnAgentEnd,
	type Task,
} from "../index.js";

// ── _extractTasksFromText ────────────────────────────────────────────────────

describe("_extractTasksFromText", () => {
	it("extracts numbered list items", () => {
		const text = "1. First task\n2. Second task\n3. Third task";
		const tasks = _extractTasksFromText(text);
		expect(tasks).toContain("First task");
		expect(tasks).toContain("Second task");
		expect(tasks).toContain("Third task");
	});

	it("extracts checkbox list items", () => {
		const text = "- [ ] Todo item\n- [x] Done item";
		const tasks = _extractTasksFromText(text);
		expect(tasks).toContain("Todo item");
		expect(tasks).toContain("Done item");
	});

	it("extracts from Task: headers", () => {
		const text = "Tasks:\n- Item one\n- Item two";
		const tasks = _extractTasksFromText(text);
		expect(tasks).toContain("Item one");
	});

	it("deduplicates identical tasks", () => {
		const text = "1. Same task here\n2. Same task here";
		const tasks = _extractTasksFromText(text);
		expect(tasks.filter((t) => t === "Same task here")).toHaveLength(1);
	});

	it("rejects short items (≤3 chars)", () => {
		const text = "1. ab\n2. Real task here";
		const tasks = _extractTasksFromText(text);
		expect(tasks).not.toContain("ab");
		expect(tasks).toContain("Real task here");
	});

	it("handles empty input", () => {
		expect(_extractTasksFromText("")).toHaveLength(0);
	});

	it("handles numbered items with parenthesis", () => {
		const text = "1) First item\n2) Second item";
		const tasks = _extractTasksFromText(text);
		expect(tasks).toContain("First item");
		expect(tasks).toContain("Second item");
	});

	it("handles mixed formats", () => {
		const text = "1. Numbered task\n- [ ] Checkbox task";
		const tasks = _extractTasksFromText(text);
		expect(tasks.length).toBeGreaterThanOrEqual(2);
	});

	it("handles asterisk checkbox lists", () => {
		const text = "* [ ] Star checkbox";
		const tasks = _extractTasksFromText(text);
		expect(tasks).toContain("Star checkbox");
	});

	it("skips items starting with bracket", () => {
		const text = "1. [skip this bracket item]";
		const tasks = _extractTasksFromText(text);
		expect(tasks).toHaveLength(0);
	});
});

// ── findCompletedTasks ───────────────────────────────────────────────────────

describe("findCompletedTasks", () => {
	const makeTasks = (): Task[] => [
		{
			id: "1",
			subject: "Test task one",
			status: "in_progress",
			blocks: [],
			blockedBy: [],
			comments: [],
		},
		{
			id: "2",
			subject: "Another task here",
			status: "in_progress",
			blocks: [],
			blockedBy: [],
			comments: [],
		},
	];

	it("finds [DONE: #id] markers", () => {
		const tasks = makeTasks();
		const completed = findCompletedTasks("[DONE: #1]", tasks);
		expect(completed).toContain("1");
	});

	it("finds [COMPLETE: #id] markers", () => {
		const tasks = makeTasks();
		const completed = findCompletedTasks("[COMPLETE: #2]", tasks);
		expect(completed).toContain("2");
	});

	it("finds completed: #id markers", () => {
		const tasks = makeTasks();
		const completed = findCompletedTasks("completed: #1", tasks);
		expect(completed).toContain("1");
	});

	it("matches by subject prefix", () => {
		const tasks = makeTasks();
		const completed = findCompletedTasks("completed: Test task one", tasks);
		expect(completed).toContain("1");
	});

	it("returns empty for no matches", () => {
		const tasks = makeTasks();
		const completed = findCompletedTasks("nothing relevant here", tasks);
		expect(completed).toHaveLength(0);
	});
});

// ── classifyAgent ────────────────────────────────────────────────────────────

describe("classifyAgent", () => {
	it("classifies review tasks", () => {
		const result = classifyAgent("review the auth module", "agent1");
		expect(result.typeLabel).toBe("Review");
	});

	it("classifies implement tasks", () => {
		const result = classifyAgent("implement user login", "agent1");
		expect(result.typeLabel).toBe("Implement");
	});

	it("falls back to General", () => {
		const result = classifyAgent("do something", "myagent");
		expect(result.typeLabel).toBe("General");
		expect(result.displayName).toBe("myagent");
	});

	it("classifies test tasks", () => {
		const result = classifyAgent("test the API", "worker");
		expect(result.typeLabel).toBe("Test");
	});

	it("classifies fix tasks", () => {
		const result = classifyAgent("fix the bug in auth", "fixer");
		expect(result.typeLabel).toBe("Fix");
	});

	it("classifies explore tasks", () => {
		const result = classifyAgent("explore the codebase", "scout");
		expect(result.typeLabel).toBe("Explore");
	});

	it("classifies plan tasks", () => {
		const result = classifyAgent("plan the architecture", "worker");
		expect(result.typeLabel).toBe("Plan");
	});

	it("classifies refactor tasks", () => {
		const result = classifyAgent("refactor the database layer", "worker");
		expect(result.typeLabel).toBe("Refactor");
	});
});

// ── escapeRegex ──────────────────────────────────────────────────────────────

describe("escapeRegex", () => {
	it("escapes special regex characters", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal regex special chars
		const result = escapeRegex(".*+?^${}()|[]\\");
		expect(result).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
	});

	it("leaves plain strings unchanged", () => {
		expect(escapeRegex("hello")).toBe("hello");
	});

	it("handles empty string", () => {
		expect(escapeRegex("")).toBe("");
	});

	it("escapes mixed content", () => {
		const result = escapeRegex("file.ts (test)");
		expect(result).toBe("file\\.ts \\(test\\)");
	});
});

// ── shouldClearOnAgentEnd ────────────────────────────────────────────────────

describe("shouldClearOnAgentEnd", () => {
	/** Helper to build a minimal Task with the given status. */
	function makeTask(status: Task["status"]): Task {
		return {
			id: "1",
			subject: "Test task",
			status,
			createdAt: Date.now(),
			description: undefined,
			activeForm: undefined,
			blockedBy: [],
			blocks: [],
			comments: [],
			metadata: {},
			owner: undefined,
		};
	}

	it("returns true when any task is in_progress", () => {
		const tasks = [makeTask("completed"), makeTask("in_progress"), makeTask("pending")];
		expect(shouldClearOnAgentEnd(tasks)).toBe(true);
	});

	it("returns false when all tasks are pending", () => {
		const tasks = [makeTask("pending"), makeTask("pending")];
		expect(shouldClearOnAgentEnd(tasks)).toBe(false);
	});

	it("returns false when all tasks are completed", () => {
		const tasks = [makeTask("completed"), makeTask("completed")];
		expect(shouldClearOnAgentEnd(tasks)).toBe(false);
	});

	it("returns false when task list is empty", () => {
		expect(shouldClearOnAgentEnd([])).toBe(false);
	});

	it("returns false with mix of pending and completed (no in_progress)", () => {
		const tasks = [makeTask("pending"), makeTask("completed"), makeTask("deleted")];
		expect(shouldClearOnAgentEnd(tasks)).toBe(false);
	});
});
