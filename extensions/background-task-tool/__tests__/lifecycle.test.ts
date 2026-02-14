/**
 * Integration tests for background-task-tool lifecycle:
 * tool registration, bg_bash execution, task_output/task_status/task_kill flows,
 * and shell policy enforcement via event handlers.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import backgroundTasksExtension from "../index.js";

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
 * Extract first text block from a tool result.
 *
 * @param result - Tool result payload
 * @returns Text content string
 */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const text = result.content.find((block) => block.type === "text");
	if (!text?.text) throw new Error("Expected text tool result");
	return text.text;
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
 * @param signal - Optional abort signal
 * @returns Tool execution result
 */
async function execTool(
	tool: ToolDefinition,
	params: Record<string, unknown>,
	signal?: AbortSignal
): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> {
	return (await tool.execute(
		"test-tool-call",
		params as never,
		signal,
		undefined,
		createContext()
	)) as { content: Array<{ type: string; text?: string }>; details: unknown };
}

let harness: ExtensionHarness;

beforeEach(() => {
	harness = ExtensionHarness.create();
	backgroundTasksExtension(harness.api);
});

afterEach(() => {
	harness.reset();
});

// ── Tool Registration ────────────────────────────────────────────────────────

describe("Background task tool registration", () => {
	it("registers all four tools", () => {
		expect(harness.tools.has("bg_bash")).toBe(true);
		expect(harness.tools.has("task_output")).toBe(true);
		expect(harness.tools.has("task_status")).toBe(true);
		expect(harness.tools.has("task_kill")).toBe(true);
	});

	it("registers /bg command", () => {
		expect(harness.commands.has("bg")).toBe(true);
	});

	it("registers at least one shortcut", () => {
		expect(harness.shortcuts.length).toBeGreaterThanOrEqual(1);
	});
});

// ── bg_bash streaming mode ───────────────────────────────────────────────────

describe("bg_bash streaming mode", () => {
	it("runs a simple command and captures output", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const result = await execTool(bgBash, { command: "echo hello world" });

		expect(firstText(result)).toContain("hello world");
		const details = result.details as { status?: string; exitCode?: number };
		expect(details.status).toBe("completed");
		expect(details.exitCode).toBe(0);
	});

	it("captures exit code from failing commands", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const result = await execTool(bgBash, { command: "exit 42" });

		const details = result.details as { status?: string; exitCode?: number };
		expect(details.status).toBe("failed");
		expect(details.exitCode).toBe(42);
	});

	it("reports duration in result details", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const result = await execTool(bgBash, { command: "echo fast" });

		const details = result.details as { duration?: string };
		expect(details.duration).toBeDefined();
		expect(details.duration).toContain("s");
	});

	it("captures stderr in output", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const result = await execTool(bgBash, { command: "echo error >&2" });

		expect(firstText(result)).toContain("error");
	});
});

// ── bg_bash fire-and-forget mode ─────────────────────────────────────────────

describe("bg_bash fire-and-forget mode", () => {
	it("returns immediately with task ID", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const result = await execTool(bgBash, { command: "sleep 0.1", background: true });

		const details = result.details as { taskId?: string; fireAndForget?: boolean };
		expect(details.fireAndForget).toBe(true);
		expect(details.taskId).toBeDefined();
		expect(details.taskId).toMatch(/^bg_/);
		expect(firstText(result)).toContain("Task ID:");
	});

	it("task becomes available for status check", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const result = await execTool(bgBash, { command: "sleep 0.05", background: true });
		const taskId = (result.details as { taskId: string }).taskId;

		const status = await execTool(taskStatus, { taskId });
		const details = status.details as { status?: string };
		// Could be running or completed depending on timing
		expect(["running", "completed"]).toContain(details.status);
	});
});

// ── task_output ──────────────────────────────────────────────────────────────

describe("task_output", () => {
	it("retrieves output from a completed task", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskOutput = getTool(harness, "task_output");

		const run = await execTool(bgBash, { command: "echo line1; echo line2" });
		const taskId = (run.details as { taskId: string }).taskId;

		const output = await execTool(taskOutput, { taskId });
		expect(firstText(output)).toContain("line1");
		expect(firstText(output)).toContain("line2");
	});

	it("returns error for nonexistent task ID", async () => {
		const taskOutput = getTool(harness, "task_output");
		const result = await execTool(taskOutput, { taskId: "nonexistent_123" });

		expect(firstText(result)).toContain("Task not found");
	});

	it("respects tail parameter", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskOutput = getTool(harness, "task_output");

		const run = await execTool(bgBash, {
			command: "for i in $(seq 1 10); do echo line$i; done",
		});
		const taskId = (run.details as { taskId: string }).taskId;

		const output = await execTool(taskOutput, { taskId, tail: 3 });
		const text = firstText(output);
		expect(text).toContain("line10");
		expect(text).toContain("line9");
	});
});

// ── task_status ──────────────────────────────────────────────────────────────

describe("task_status", () => {
	it("returns status for completed task", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = (run.details as { taskId: string }).taskId;

		const status = await execTool(taskStatus, { taskId });
		const details = status.details as { status?: string; exitCode?: number };
		expect(details.status).toBe("completed");
		expect(details.exitCode).toBe(0);
	});

	it("returns error for nonexistent task", async () => {
		const taskStatus = getTool(harness, "task_status");
		const result = await execTool(taskStatus, { taskId: "fake_id" });

		expect(firstText(result)).toContain("Task not found");
	});
});

// ── task_kill ────────────────────────────────────────────────────────────────

describe("task_kill", () => {
	it("returns error for nonexistent task", async () => {
		const taskKill = getTool(harness, "task_kill");
		const result = await execTool(taskKill, { taskId: "nonexistent" });

		expect(firstText(result)).toContain("Task not found");
	});

	it("returns error for already-completed task", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskKill = getTool(harness, "task_kill");

		const run = await execTool(bgBash, { command: "echo done" });
		const taskId = (run.details as { taskId: string }).taskId;

		const result = await execTool(taskKill, { taskId });
		expect(firstText(result)).toContain("not running");
	});

	it("kills a running background task", async () => {
		const bgBash = getTool(harness, "bg_bash");
		const taskKill = getTool(harness, "task_kill");
		const taskStatus = getTool(harness, "task_status");

		const run = await execTool(bgBash, { command: "sleep 30", background: true });
		const taskId = (run.details as { taskId: string }).taskId;

		const killResult = await execTool(taskKill, { taskId });
		expect(firstText(killResult)).toContain("Killed");

		const status = await execTool(taskStatus, { taskId });
		const details = status.details as { status?: string };
		expect(details.status).toBe("killed");
	});
});

// ── Shell policy enforcement (tool_call event handlers) ──────────────────────

describe("Shell policy: backgrounding & detection", () => {
	it("blocks bash commands with trailing &", async () => {
		const results = await harness.fireEvent(
			"tool_call",
			{ toolName: "bash", input: { command: "sleep 10 &" } },
			createContext()
		);
		const blocking = results.find(
			(r) => r && typeof r === "object" && (r as { block?: boolean }).block
		);
		expect(blocking).toBeDefined();
	});

	it("allows bash commands with && (logical AND)", async () => {
		const results = await harness.fireEvent(
			"tool_call",
			{ toolName: "bash", input: { command: "cmd1 && cmd2" } },
			createContext()
		);
		const blocking = results.find(
			(r) => r && typeof r === "object" && (r as { block?: boolean }).block
		);
		expect(blocking).toBeUndefined();
	});

	it("blocks bash commands with hang-prone patterns", async () => {
		const results = await harness.fireEvent(
			"tool_call",
			{ toolName: "bash", input: { command: "tail -f /var/log/syslog" } },
			createContext()
		);
		const blocking = results.find(
			(r) => r && typeof r === "object" && (r as { block?: boolean }).block
		);
		expect(blocking).toBeDefined();
	});

	it("ignores non-bash tool calls", async () => {
		const results = await harness.fireEvent(
			"tool_call",
			{ toolName: "read", input: { path: "/etc/hosts" } },
			createContext()
		);
		const blocking = results.find(
			(r) => r && typeof r === "object" && (r as { block?: boolean }).block
		);
		expect(blocking).toBeUndefined();
	});
});
