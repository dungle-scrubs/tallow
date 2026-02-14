import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
	getTextContent,
	isAssistantMessage,
	nextTaskId,
	type Task,
	TaskListStore,
	type TasksState,
} from "../state/index.js";
import { colorToAnsi, mergeSideBySide, padToWidth } from "../ui/index.js";

/**
 * Build a minimal task state object for helper tests.
 *
 * @returns Mutable tasks state
 */
function createState(): TasksState {
	return {
		tasks: [],
		visible: true,
		activeTaskId: null,
		nextId: 1,
	};
}

/**
 * Create a valid task object for TaskListStore tests.
 *
 * @param id - Task ID
 * @returns Task record
 */
function createTask(id = "1"): Task {
	return {
		id,
		subject: "Test task",
		status: "pending",
		blocks: [],
		blockedBy: [],
		comments: [],
		createdAt: Date.now(),
	};
}

describe("tasks state helpers", () => {
	it("nextTaskId increments sequentially", () => {
		const state = createState();
		expect(nextTaskId(state)).toBe("1");
		expect(nextTaskId(state)).toBe("2");
		expect(state.nextId).toBe(3);
	});

	it("isAssistantMessage narrows assistant events", () => {
		const assistant = { role: "assistant", content: [{ type: "text", text: "hi" }] };
		const user = { role: "user", content: [{ type: "text", text: "hi" }] };
		expect(isAssistantMessage(assistant as never)).toBe(true);
		expect(isAssistantMessage(user as never)).toBe(false);
	});

	it("getTextContent concatenates all assistant text blocks", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "first line" },
				{ type: "toolCall", id: "tc1", name: "noop", arguments: {} },
				{ type: "text", text: "second line" },
			],
			api: "anthropic-messages",
			provider: "mock",
			model: "mock-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		expect(getTextContent(message)).toBe("first line\nsecond line");
	});

	it("TaskListStore session-only mode performs no file IO", () => {
		const store = new TaskListStore(null);
		expect(store.isShared).toBe(false);
		expect(store.path).toBeNull();
		expect(store.loadAll()).toBeNull();

		store.saveTask(createTask("1"));
		store.deleteTask("1");
		const unlock = store.lock();
		unlock();
		store.watch(() => {
			throw new Error("watch callback should never fire in session-only mode");
		});
		store.close();
	});
});

describe("tasks ui helpers", () => {
	it("colorToAnsi maps known and fallback colors", () => {
		expect(colorToAnsi("green")).toBe(78);
		expect(colorToAnsi("red")).toBe(203);
		expect(colorToAnsi("unknown")).toBe(78);
	});

	it("padToWidth pads short lines and truncates long lines", () => {
		expect(padToWidth("abc", 5)).toBe("abc  ");
		const truncated = padToWidth("abcdef", 3);
		expect(truncated.startsWith("abc")).toBe(true);
		expect(visibleWidth(truncated)).toBe(3);
	});

	it("mergeSideBySide bottom-aligns right column and keeps width bounds", () => {
		const merged = mergeSideBySide(["left1", "left2", "left3"], ["right"], 6, " | ", 16);
		expect(merged).toHaveLength(3);
		expect(merged[0]).toBe("left1  | ");
		expect(merged[2]).toContain("right");
	});
});
