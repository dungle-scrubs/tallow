import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import planModeExtension from "../index.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "../utils.js";

const BASELINE_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
	"subagent",
	"bg_bash",
	"mcp__mock__ping",
	"questionnaire",
	"plan_mode",
] as const;

/**
 * Register mock tools used to test plan-mode gating and restoration.
 *
 * @param pi - Extension API test double
 * @returns void
 */
function registerMockTools(pi: ExtensionAPI): void {
	const names = [
		"read",
		"bash",
		"grep",
		"find",
		"ls",
		"edit",
		"write",
		"subagent",
		"bg_bash",
		"mcp__mock__ping",
		"questionnaire",
	] as const;

	for (const name of names) {
		pi.registerTool({
			name,
			label: name,
			description: `Mock ${name}`,
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text", text: `${name}-ok` }],
					details: {},
				};
			},
		});
	}
}

/**
 * Create an extension context with optional persisted session entries.
 *
 * @param entries - Session entries returned by sessionManager.getEntries
 * @returns Context object compatible with extension handlers
 */
function createContext(entries: unknown[] = []): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
			setEditorComponent() {},
			setWidget() {},
			theme: {
				fg(_token: string, value: string) {
					return value;
				},
				strikethrough(value: string) {
					return value;
				},
			},
		} as never,
		sessionManager: {
			getEntries() {
				return entries;
			},
		} as never,
	} as unknown as ExtensionContext;
}

/**
 * Resolve a registered tool from the test harness.
 *
 * @param harness - Extension harness
 * @param name - Tool name
 * @returns Tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Tool not registered: ${name}`);
	return tool;
}

describe("plan-mode strict readonly enforcement", () => {
	let harness: ExtensionHarness;

	beforeEach(async () => {
		harness = ExtensionHarness.create();
		await harness.loadExtension(registerMockTools);
		await harness.loadExtension(planModeExtension);
		harness.api.setActiveTools([...BASELINE_TOOLS]);
	});

	test("enable applies strict allowlist and disable restores previous tools", async () => {
		const tool = getTool(harness, "plan_mode");
		const ctx = createContext();

		await tool.execute("tc-enable", { action: "enable" }, undefined, () => {}, ctx);
		expect(harness.api.getActiveTools()).toEqual(
			PLAN_MODE_ALLOWED_TOOLS.filter((name) => BASELINE_TOOLS.includes(name))
		);

		await tool.execute("tc-disable", { action: "disable" }, undefined, () => {}, ctx);
		expect(harness.api.getActiveTools()).toEqual([...BASELINE_TOOLS]);
	});

	test("tool_call blocks non-allowlisted tools and unsafe bash", async () => {
		const tool = getTool(harness, "plan_mode");
		const ctx = createContext();
		await tool.execute("tc-enable", { action: "enable" }, undefined, () => {}, ctx);

		const [blockedToolResult] = await harness.fireEvent(
			"tool_call",
			{ toolName: "subagent", input: { task: "x" } },
			ctx
		);
		expect(blockedToolResult).toMatchObject({ block: true });
		expect((blockedToolResult as { reason: string }).reason).toContain('tool "subagent" blocked');

		const [safeBashResult] = await harness.fireEvent(
			"tool_call",
			{ toolName: "bash", input: { command: "ls -la" } },
			ctx
		);
		expect(safeBashResult).toBeUndefined();

		const [unsafeBashResult] = await harness.fireEvent(
			"tool_call",
			{ toolName: "bash", input: { command: "rm -rf /tmp/nope" } },
			ctx
		);
		expect(unsafeBashResult).toMatchObject({ block: true });
	});

	test("resumed plan mode re-applies strict policy", async () => {
		const persistedEntries = [
			{
				type: "custom",
				customType: "plan-mode",
				data: {
					enabled: true,
					executing: false,
					normalTools: [...BASELINE_TOOLS],
					todos: [],
				},
			},
		];
		const ctx = createContext(persistedEntries);

		await harness.fireEvent("session_start", { type: "session_start" }, ctx);

		expect(harness.api.getActiveTools()).toEqual(
			PLAN_MODE_ALLOWED_TOOLS.filter((name) => BASELINE_TOOLS.includes(name))
		);

		const [blockedResult] = await harness.fireEvent(
			"tool_call",
			{ toolName: "bg_bash", input: { command: "echo hi" } },
			ctx
		);
		expect(blockedResult).toMatchObject({ block: true });
	});
});
