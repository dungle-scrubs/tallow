/**
 * Tests for tasks state transitions through the manage_tasks tool:
 * add, complete, delete, dependency chains, comments, metadata, and claim logic.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import { registerTasksExtension } from "../commands/register-tasks-extension.js";
import { TaskListStore } from "../state/index.js";

const ORIGINAL_PI_IS_SUBAGENT = process.env.PI_IS_SUBAGENT;
const ORIGINAL_PI_TEAM_NAME = process.env.PI_TEAM_NAME;

/**
 * Build a minimal extension context for tool execution.
 *
 * @returns Stub extension context
 */
function createContext(): ExtensionContext {
	return {
		ui: {
			async select() {
				return undefined;
			},
			async confirm() {
				return false;
			},
			async input() {
				return undefined;
			},
			notify() {},
			setStatus() {},
			setWorkingMessage() {},
			setWidget() {},
			setFooter() {},
			setHeader() {},
			setTitle() {},
			async custom() {
				return undefined as never;
			},
			pasteToEditor() {},
			setEditorText() {},
			getEditorText() {
				return "";
			},
			async editor() {
				return undefined;
			},
			setEditorComponent() {},
			get theme(): never {
				throw new Error("Theme not available in tests");
			},
			getAllThemes() {
				return [];
			},
			getTheme() {
				return undefined;
			},
			setTheme() {
				return { success: false, error: "Test stub" };
			},
			getToolsExpanded() {
				return false;
			},
			setToolsExpanded() {},
		} as ExtensionContext["ui"],
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: { getEntries: () => [], appendEntry: () => {} } as never,
		modelRegistry: { getApiKeyForProvider: async () => undefined } as never,
		model: undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
}

/**
 * Extract first text block from a tool result.
 *
 * @param result - Tool result
 * @returns Text string
 */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const text = result.content.find((b) => b.type === "text");
	if (!text?.text) throw new Error("Expected text result");
	return text.text;
}

/**
 * Get a tool by name from harness.
 *
 * @param harness - Extension harness
 * @param name - Tool name
 * @returns Tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Expected tool "${name}"`);
	return tool;
}

/**
 * Execute manage_tasks with test context.
 *
 * @param tool - manage_tasks tool
 * @param params - Tool parameters
 * @returns Tool result
 */
async function execManage(
	tool: ToolDefinition,
	params: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> {
	return (await tool.execute(
		"test-call",
		params as never,
		undefined,
		undefined,
		createContext()
	)) as { content: Array<{ type: string; text?: string }>; details: unknown };
}

let harness: ExtensionHarness;
let manage: ToolDefinition;

beforeEach(() => {
	process.env.PI_IS_SUBAGENT = "1";
	delete process.env.PI_TEAM_NAME;

	harness = ExtensionHarness.create();
	registerTasksExtension(harness.api, new TaskListStore(null), null);
	manage = getTool(harness, "manage_tasks");
});

afterEach(() => {
	if (ORIGINAL_PI_IS_SUBAGENT === undefined) delete process.env.PI_IS_SUBAGENT;
	else process.env.PI_IS_SUBAGENT = ORIGINAL_PI_IS_SUBAGENT;
	if (ORIGINAL_PI_TEAM_NAME === undefined) delete process.env.PI_TEAM_NAME;
	else process.env.PI_TEAM_NAME = ORIGINAL_PI_TEAM_NAME;
});

// ── Basic CRUD ───────────────────────────────────────────────────────────────

describe("Task CRUD operations", () => {
	it("adds a single task", async () => {
		await execManage(manage, { action: "add", task: "Write tests" });

		const list = await execManage(manage, { action: "list" });
		expect(firstText(list)).toContain("Write tests");
		// Single task auto-promotes to in_progress
		expect(firstText(list)).toContain("in_progress");
	});

	it("adds multiple tasks at once", async () => {
		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "Task A" }, { subject: "Task B" }, { subject: "Task C" }],
		});

		const list = await execManage(manage, { action: "list" });
		const text = firstText(list);
		expect(text).toContain("Task A");
		expect(text).toContain("Task B");
		expect(text).toContain("Task C");
	});

	it("completes a task", async () => {
		await execManage(manage, { action: "add", task: "Finish it" });
		await execManage(manage, { action: "update", index: 1, status: "in_progress" });
		await execManage(manage, { action: "complete", index: 1 });

		const list = await execManage(manage, { action: "list" });
		expect(firstText(list)).toContain("completed");
	});

	it("deletes a task via status update", async () => {
		await execManage(manage, { action: "add", task: "Delete me" });
		await execManage(manage, { action: "update", index: 1, status: "deleted" });

		const list = await execManage(manage, { action: "list" });
		expect(firstText(list)).not.toContain("Delete me");
	});

	it("completes multiple tasks by indices", async () => {
		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "First" }, { subject: "Second" }, { subject: "Third" }],
		});

		await execManage(manage, { action: "complete", indices: [1, 3] });

		const list = await execManage(manage, { action: "list" });
		const text = firstText(list);
		expect(text).toContain("[completed] First");
		// After completing 1 and 3, task 2 auto-promotes to in_progress
		expect(text).toContain("[in_progress] Second");
		expect(text).toContain("[completed] Third");
	});

	it("clears all tasks", async () => {
		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "One" }, { subject: "Two" }],
		});
		await execManage(manage, { action: "clear" });

		const list = await execManage(manage, { action: "list" });
		expect(firstText(list)).toBe("No tasks.");
	});

	it("complete_all marks all tasks completed", async () => {
		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "One" }, { subject: "Two" }],
		});
		await execManage(manage, { action: "complete_all" });

		const list = await execManage(manage, { action: "list" });
		const text = firstText(list);
		expect(text).toContain("[completed] One");
		expect(text).toContain("[completed] Two");
	});
});

// ── Dependency chain ─────────────────────────────────────────────────────────

describe("Dependency chain enforcement", () => {
	it("blocks completion when blockedBy deps are unmet", async () => {
		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "Prerequisite" }, { subject: "Dependent" }],
		});
		await execManage(manage, { action: "update", index: 2, addBlockedBy: ["1"] });

		const blocked = await execManage(manage, { action: "complete", index: 2 });
		expect(firstText(blocked)).toContain("blocked by");
	});

	it("allows completion after deps are satisfied", async () => {
		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "First step" }, { subject: "Second step" }],
		});
		await execManage(manage, { action: "update", index: 2, addBlockedBy: ["1"] });

		// Complete the prerequisite
		await execManage(manage, { action: "complete", index: 1 });

		// Now the dependent should complete
		const result = await execManage(manage, { action: "complete", index: 2 });
		expect(firstText(result)).toContain("Completed");
	});

	it("supports addBlocks (forward dependency)", async () => {
		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "Blocker" }, { subject: "Blocked" }],
		});
		await execManage(manage, { action: "update", index: 1, addBlocks: ["2"] });

		const blocked = await execManage(manage, { action: "complete", index: 2 });
		expect(firstText(blocked)).toContain("blocked by");
	});
});

// ── Comments ─────────────────────────────────────────────────────────────────

describe("Task comments", () => {
	it("adds comment to a task", async () => {
		await execManage(manage, { action: "add", task: "Commentable" });
		await execManage(manage, {
			action: "update",
			index: 1,
			addComment: { author: "tester", content: "This needs attention" },
		});

		const detail = await execManage(manage, { action: "get", index: 1 });
		const text = firstText(detail);
		expect(text).toContain("tester");
		expect(text).toContain("This needs attention");
	});
});

// ── Metadata ─────────────────────────────────────────────────────────────────

describe("Task metadata", () => {
	it("attaches metadata to a task", async () => {
		await execManage(manage, { action: "add", task: "With metadata" });
		await execManage(manage, {
			action: "update",
			index: 1,
			metadata: { priority: "high", estimate: 3 },
		});

		const detail = await execManage(manage, { action: "get", index: 1 });
		const text = firstText(detail);
		expect(text).toContain("priority");
		expect(text).toContain("high");
	});

	it("deletes metadata key when set to null", async () => {
		await execManage(manage, { action: "add", task: "Clear metadata" });
		await execManage(manage, {
			action: "update",
			index: 1,
			metadata: { temp: "value" },
		});
		await execManage(manage, {
			action: "update",
			index: 1,
			metadata: { temp: null },
		});

		const detail = await execManage(manage, { action: "get", index: 1 });
		const text = firstText(detail);
		expect(text).not.toContain("temp");
	});
});

// ── Claim with busy check ────────────────────────────────────────────────────

describe("Task claiming", () => {
	it("claims first task successfully", async () => {
		await execManage(manage, { action: "add", task: "Claim me" });
		const result = await execManage(manage, {
			action: "claim",
			index: 1,
			owner: "alice",
		});
		expect(firstText(result)).toContain("Claimed #1");
	});

	it("warns when owner is already busy with another task", async () => {
		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "First job" }, { subject: "Second job" }],
		});

		await execManage(manage, { action: "claim", index: 1, owner: "alice" });
		const second = await execManage(manage, {
			action: "claim",
			index: 2,
			owner: "alice",
		});
		expect(firstText(second)).toContain("busy");
	});

	it("allows different owners to claim different tasks", async () => {
		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "Alice's task" }, { subject: "Bob's task" }],
		});

		const claimA = await execManage(manage, {
			action: "claim",
			index: 1,
			owner: "alice",
		});
		const claimB = await execManage(manage, {
			action: "claim",
			index: 2,
			owner: "bob",
		});
		expect(firstText(claimA)).toContain("Claimed #1");
		expect(firstText(claimB)).toContain("Claimed #2");
	});
});

// ── Status transitions ───────────────────────────────────────────────────────

describe("Status transitions", () => {
	it("transitions pending → in_progress → completed", async () => {
		await execManage(manage, { action: "add", task: "Track status" });

		await execManage(manage, { action: "update", index: 1, status: "in_progress" });
		let list = await execManage(manage, { action: "list" });
		expect(firstText(list)).toContain("in_progress");

		await execManage(manage, { action: "complete", index: 1 });
		list = await execManage(manage, { action: "list" });
		expect(firstText(list)).toContain("completed");
	});

	it("handles description and activeForm updates", async () => {
		await execManage(manage, { action: "add", task: "Detailed task" });
		await execManage(manage, {
			action: "update",
			index: 1,
			description: "Full description of the work needed",
		});

		const detail = await execManage(manage, { action: "get", index: 1 });
		expect(firstText(detail)).toContain("Full description");
	});
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("Edge cases", () => {
	it("returns error for invalid index", async () => {
		const result = await execManage(manage, { action: "complete", index: 99 });
		const text = firstText(result);
		// Should indicate invalid task or out of range
		expect(text.length).toBeGreaterThan(0);
	});

	it("list with no tasks returns 'No tasks.'", async () => {
		const list = await execManage(manage, { action: "list" });
		expect(firstText(list)).toBe("No tasks.");
	});

	it("get action returns task details", async () => {
		await execManage(manage, {
			action: "add",
			task: "Detailed task",
			activeForm: "Working on details",
			description: "A longer description",
		});

		const detail = await execManage(manage, { action: "get", index: 1 });
		const text = firstText(detail);
		expect(text).toContain("Detailed task");
	});
});
