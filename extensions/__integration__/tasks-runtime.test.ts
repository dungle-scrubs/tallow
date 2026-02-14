import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../test-utils/extension-harness.js";
import { registerTasksExtension } from "../tasks/commands/register-tasks-extension.js";
import { TaskListStore } from "../tasks/state/index.js";

const ORIGINAL_PI_IS_SUBAGENT = process.env.PI_IS_SUBAGENT;
const ORIGINAL_PI_TEAM_NAME = process.env.PI_TEAM_NAME;

/**
 * Build a minimal extension context for direct tool execution in tests.
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
				throw new Error("Theme not available in tasks runtime tests");
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
		sessionManager: {
			getEntries: () => [],
			appendEntry: () => {},
		} as never,
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
		} as never,
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
 * Extract first text block from a tool result payload.
 *
 * @param result - Tool result payload
 * @returns Text block content
 */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const text = result.content.find((block) => block.type === "text");
	if (!text?.text) throw new Error("Expected text tool result");
	return text.text;
}

/**
 * Read a required registered tool by name.
 *
 * @param harness - Extension harness instance
 * @param name - Tool name
 * @returns Registered tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Expected tool "${name}" to be registered`);
	return tool;
}

/**
 * Execute manage_tasks with a test context.
 *
 * @param tool - Registered manage_tasks tool
 * @param params - Tool parameters
 * @returns Tool execution result
 */
async function execManage(
	tool: ToolDefinition,
	params: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> {
	return (await tool.execute(
		"test-tool-call",
		params as never,
		undefined,
		undefined,
		createContext()
	)) as { content: Array<{ type: string; text?: string }>; details: unknown };
}

beforeEach(() => {
	process.env.PI_IS_SUBAGENT = "1";
	delete process.env.PI_TEAM_NAME;
});

afterEach(() => {
	if (ORIGINAL_PI_IS_SUBAGENT === undefined) delete process.env.PI_IS_SUBAGENT;
	else process.env.PI_IS_SUBAGENT = ORIGINAL_PI_IS_SUBAGENT;
	if (ORIGINAL_PI_TEAM_NAME === undefined) delete process.env.PI_TEAM_NAME;
	else process.env.PI_TEAM_NAME = ORIGINAL_PI_TEAM_NAME;
});

describe("Tasks runtime wiring", () => {
	it("registers /tasks command and shortcut in main-agent mode", () => {
		process.env.PI_IS_SUBAGENT = "0";
		const harness = ExtensionHarness.create();
		registerTasksExtension(harness.api, new TaskListStore(null), null);

		expect(harness.commands.has("tasks")).toBe(true);
		expect(harness.shortcuts.length).toBeGreaterThanOrEqual(1);
		expect(harness.tools.has("manage_tasks")).toBe(true);
	});

	it("enforces busy-check when claiming multiple in-progress tasks for one owner", async () => {
		const harness = ExtensionHarness.create();
		registerTasksExtension(harness.api, new TaskListStore(null), null);
		const manage = getTool(harness, "manage_tasks");

		await execManage(manage, { action: "add", task: "Investigate flaky tests" });
		await execManage(manage, { action: "add", task: "Write regression coverage" });

		const claimFirst = await execManage(manage, { action: "claim", index: 1, owner: "alice" });
		expect(firstText(claimFirst)).toContain("Claimed #1");

		const claimSecond = await execManage(manage, { action: "claim", index: 2, owner: "alice" });
		expect(firstText(claimSecond)).toContain("alice is busy with #1");
	});

	it("blocks completion when blockedBy dependencies are unmet", async () => {
		const harness = ExtensionHarness.create();
		registerTasksExtension(harness.api, new TaskListStore(null), null);
		const manage = getTool(harness, "manage_tasks");

		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "Collect logs" }, { subject: "Patch production" }],
		});
		await execManage(manage, { action: "update", index: 2, addBlockedBy: ["1"] });

		const blocked = await execManage(manage, { action: "complete", index: 2 });
		expect(firstText(blocked)).toContain("blocked by tasks 1");
	});

	it("auto-completes and advances active task from turn_end completion markers", async () => {
		const harness = ExtensionHarness.create();
		registerTasksExtension(harness.api, new TaskListStore(null), null);
		const manage = getTool(harness, "manage_tasks");

		await execManage(manage, {
			action: "add",
			tasks: [{ subject: "Analyze outage" }, { subject: "Deploy fix" }],
		});

		await harness.fireEvent(
			"turn_end",
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "[DONE: #1]" }],
				},
			},
			createContext()
		);

		const list = await execManage(manage, { action: "list" });
		const listText = firstText(list);
		expect(listText).toContain("1. [completed] Analyze outage");
		expect(listText).toContain("2. [in_progress] Deploy fix");
	});

	it("injects active-task context before agent start and clears orphaned in-progress tasks on agent_end", async () => {
		const harness = ExtensionHarness.create();
		registerTasksExtension(harness.api, new TaskListStore(null), null);
		const manage = getTool(harness, "manage_tasks");

		await execManage(manage, { action: "add", task: "Finish migration" });

		const [beforeStartResult] = await harness.fireEvent("before_agent_start", {}, createContext());
		expect(beforeStartResult).toBeDefined();
		const beforeStart = beforeStartResult as { message?: { content?: string } };
		expect(beforeStart.message?.content).toContain("[ACTIVE TASKS]");

		await harness.fireEvent("agent_end", {}, createContext());
		const list = await execManage(manage, { action: "list" });
		expect(firstText(list)).toBe("No tasks.");
	});
});
