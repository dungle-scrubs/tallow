/**
 * Tests for consecutive poll detection and in-place update behavior.
 *
 * Verifies that repeated task_status/task_output calls for the same taskId
 * are detected as consecutive, and that non-poll tools break the chain.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import backgroundTasksExtension, {
	getLastCompletedPollForTests,
	getPollStatesForTests,
	resetPollStateForTests,
	setBackgroundTaskSpawnForTests,
} from "../index.js";

/**
 * Build a minimal extension context for tool execution in tests.
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
 * Get a registered tool by name, asserting it exists.
 *
 * @param harness - Extension harness
 * @param name - Tool name
 * @returns Tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Expected tool "${name}" to be registered`);
	return tool;
}

/**
 * Execute a tool with test context.
 *
 * @param tool - Tool definition
 * @param params - Tool parameters
 * @returns Tool execution result with details
 */
async function execTool(
	tool: ToolDefinition,
	params: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }> {
	return (await tool.execute(
		"test-tool-call",
		params as never,
		undefined,
		undefined,
		createContext()
	)) as { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
}

let harness: ExtensionHarness;

beforeEach(() => {
	setBackgroundTaskSpawnForTests(undefined);
	resetPollStateForTests();
	harness = ExtensionHarness.create();
	backgroundTasksExtension(harness.api);
});

afterEach(() => {
	setBackgroundTaskSpawnForTests(undefined);
	resetPollStateForTests();
	harness.reset();
});

// ── Consecutive task_status detection ────────────────────────────────────────

describe("Consecutive task_status detection", () => {
	it("marks first call as not consecutive", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		const result = await execTool(taskStatus, { taskId });
		expect(result.details._isConsecutive).toBe(false);
	});

	it("marks second same-taskId call as consecutive", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		await execTool(taskStatus, { taskId });
		const result2 = await execTool(taskStatus, { taskId });
		expect(result2.details._isConsecutive).toBe(true);
	});

	it("increments poll count on consecutive calls", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		// First call creates anchor (pollCount = 1 via renderResult)
		await execTool(taskStatus, { taskId });

		// Poll state not created yet (that's renderResult's job)
		// But lastCompletedPoll IS set
		expect(getLastCompletedPollForTests()).toEqual({
			toolName: "task_status",
			taskId,
		});

		// Second call — consecutive, updates poll state if it exists
		const result2 = await execTool(taskStatus, { taskId });
		expect(result2.details._isConsecutive).toBe(true);

		// Third call — also consecutive
		const result3 = await execTool(taskStatus, { taskId });
		expect(result3.details._isConsecutive).toBe(true);
	});

	it("sets lastCompletedPoll after each task_status call", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		expect(getLastCompletedPollForTests()).toBeNull();

		await execTool(taskStatus, { taskId });
		expect(getLastCompletedPollForTests()).toEqual({
			toolName: "task_status",
			taskId,
		});
	});
});

// ── Mixed taskId — NOT consecutive ───────────────────────────────────────────

describe("Mixed taskId detection", () => {
	it("marks different taskIds as not consecutive", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run1 = await execTool(bgBash, { command: "echo one" });
		const run2 = await execTool(bgBash, { command: "echo two" });
		const taskId1 = run1.details.taskId as string;
		const taskId2 = run2.details.taskId as string;

		await execTool(taskStatus, { taskId: taskId1 });
		const result2 = await execTool(taskStatus, { taskId: taskId2 });

		expect(result2.details._isConsecutive).toBe(false);
	});
});

// ── Cross-tool — NOT consecutive ─────────────────────────────────────────────

describe("Cross-tool detection", () => {
	it("marks task_status then task_output as not consecutive", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");
		const taskOutput = getTool(harness, "task_output");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		await execTool(taskStatus, { taskId });
		const result = await execTool(taskOutput, { taskId });

		expect(result.details._isConsecutive).toBe(false);
	});

	it("marks task_output then task_status as not consecutive", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");
		const taskOutput = getTool(harness, "task_output");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		await execTool(taskOutput, { taskId });
		const result = await execTool(taskStatus, { taskId });

		expect(result.details._isConsecutive).toBe(false);
	});
});

// ── Chain breaking ───────────────────────────────────────────────────────────

describe("Chain breaking", () => {
	it("breaks chain when non-poll tool_call fires", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		await execTool(taskStatus, { taskId });
		expect(getLastCompletedPollForTests()).not.toBeNull();

		// Fire tool_call for a non-poll tool (simulates chain break)
		await harness.fireEvent(
			"tool_call",
			{ toolName: "bash", input: { command: "echo break" } },
			createContext()
		);
		expect(getLastCompletedPollForTests()).toBeNull();

		// Next task_status should NOT be consecutive
		const result = await execTool(taskStatus, { taskId });
		expect(result.details._isConsecutive).toBe(false);
	});

	it("does not break chain for task_status tool_call events", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		await execTool(taskStatus, { taskId });

		// Fire tool_call for task_status itself — should NOT break chain
		await harness.fireEvent(
			"tool_call",
			{ toolName: "task_status", input: { taskId } },
			createContext()
		);
		expect(getLastCompletedPollForTests()).not.toBeNull();
	});

	it("does not break chain for task_output tool_call events", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		await execTool(taskStatus, { taskId });

		// Fire tool_call for task_output — should NOT break chain
		await harness.fireEvent(
			"tool_call",
			{ toolName: "task_output", input: { taskId } },
			createContext()
		);
		expect(getLastCompletedPollForTests()).not.toBeNull();
	});

	it("clears poll states on agent_end", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		await execTool(taskStatus, { taskId });
		expect(getLastCompletedPollForTests()).not.toBeNull();

		await harness.fireEvent("agent_end", {}, createContext());
		expect(getLastCompletedPollForTests()).toBeNull();
		expect(getPollStatesForTests().size).toBe(0);
	});

	it("resets lastCompletedPoll after bg_bash execute", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run1 = await execTool(bgBash, { command: "echo first" });
		const taskId = run1.details.taskId as string;

		await execTool(taskStatus, { taskId });
		expect(getLastCompletedPollForTests()).not.toBeNull();

		// bg_bash execute should reset lastCompletedPoll
		await execTool(bgBash, { command: "echo second" });
		expect(getLastCompletedPollForTests()).toBeNull();
	});

	it("resets lastCompletedPoll after task_kill execute", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");
		const taskKill = getTool(harness, "task_kill");

		const run = await execTool(bgBash, { command: "sleep 30", background: true });
		const taskId = run.details.taskId as string;

		await execTool(taskStatus, { taskId });
		expect(getLastCompletedPollForTests()).not.toBeNull();

		await execTool(taskKill, { taskId });
		expect(getLastCompletedPollForTests()).toBeNull();
	});
});

// ── Error bypass ─────────────────────────────────────────────────────────────

describe("Error bypass", () => {
	it("does not mark error results as consecutive", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = run.details.taskId as string;

		await execTool(taskStatus, { taskId });

		// Query nonexistent task — should have error: true, not _isConsecutive
		const result = await execTool(taskStatus, { taskId: "fake_id" });
		expect(result.details.error).toBe(true);
		expect(result.details._isConsecutive).toBeUndefined();
	});
});

// ── Consecutive task_output detection ────────────────────────────────────────

describe("Consecutive task_output detection", () => {
	it("marks first task_output call as not consecutive", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskOutput = getTool(harness, "task_output");

		const run = await execTool(bgBash, { command: "echo hello" });
		const taskId = run.details.taskId as string;

		const result = await execTool(taskOutput, { taskId });
		expect(result.details._isConsecutive).toBe(false);
	});

	it("marks second same-taskId task_output call as consecutive", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskOutput = getTool(harness, "task_output");

		const run = await execTool(bgBash, { command: "echo hello" });
		const taskId = run.details.taskId as string;

		await execTool(taskOutput, { taskId });
		const result2 = await execTool(taskOutput, { taskId });
		expect(result2.details._isConsecutive).toBe(true);
	});
});
