import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import planModeExtension from "../index.js";
import type { TodoItem } from "../utils.js";

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
	"questionnaire",
	"plan_mode",
] as const;

/**
 * Register mock tools for the test session.
 *
 * @param pi - Extension API
 */
function registerMockTools(pi: ExtensionAPI): void {
	for (const name of [
		"read",
		"bash",
		"grep",
		"find",
		"ls",
		"edit",
		"write",
		"subagent",
		"bg_bash",
		"questionnaire",
	] as const) {
		pi.registerTool({
			name,
			label: name,
			description: `Mock ${name}`,
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: `${name}-ok` }], details: {} };
			},
		});
	}
}

/**
 * Build persisted session entries that place the extension in execution mode.
 *
 * @param todos - Todo items for the plan
 * @returns Array of session entries
 */
function executionModeEntries(todos: TodoItem[]): unknown[] {
	return [
		{
			type: "custom",
			customType: "plan-mode",
			data: {
				enabled: false,
				executing: true,
				normalTools: [...BASELINE_TOOLS],
				todos,
				currentStepIndex: 0,
			},
		},
		{ type: "custom", customType: "plan-mode-execute" },
	];
}

/**
 * Create an extension context with a configurable `select` stub.
 *
 * @param entries - Session entries for state restoration
 * @param selectReturn - Value that ctx.ui.select() resolves to
 * @returns Context and a record of select calls
 */
function createUIContext(
	entries: unknown[] = [],
	selectReturn?: string
): { ctx: ExtensionContext; selectCalls: Array<{ title: string; options: string[] }> } {
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
			setEditorComponent() {},
			setWidget() {},
			setWorkingMessage() {},
			async select(title: string, options: string[]) {
				selectCalls.push({ title, options });
				return selectReturn;
			},
			async editor() {
				return undefined;
			},
			theme: {
				fg(_token: string, value: string) {
					return value;
				},
				bg(_token: string, value: string) {
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
	return { ctx, selectCalls };
}

/**
 * Create a headless context (no UI).
 *
 * @param entries - Session entries for state restoration
 * @returns Extension context with hasUI=false
 */
function createHeadlessContext(entries: unknown[] = []): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: false,
		ui: {
			notify() {},
			setStatus() {},
			setEditorComponent() {},
			setWidget() {},
			setWorkingMessage() {},
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

const SAMPLE_TODOS: TodoItem[] = [
	{ step: 1, text: "Add error handling", completed: false },
	{ step: 2, text: "Write tests", completed: false },
	{ step: 3, text: "Update docs", completed: false },
];

describe("agent_end execution mode — partial completion", () => {
	let harness: ExtensionHarness;

	beforeEach(async () => {
		harness = ExtensionHarness.create();
		await harness.loadExtension(registerMockTools);
		await harness.loadExtension(planModeExtension);
		harness.api.setActiveTools([...BASELINE_TOOLS]);
	});

	test("shows select menu when agent finishes with incomplete steps", async () => {
		const todos = SAMPLE_TODOS.map((t) => ({ ...t }));
		const entries = executionModeEntries(todos);
		const { ctx, selectCalls } = createUIContext(entries, "Abort plan");

		// Restore execution mode state
		await harness.fireEvent("session_start", { type: "session_start" }, ctx);

		// Agent finishes a turn — no [DONE:n] markers
		await harness.fireEvent(
			"agent_end",
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "Did some work." }] }] },
			ctx
		);

		expect(selectCalls).toHaveLength(1);
		expect(selectCalls[0].title).toContain("0/3");
		expect(selectCalls[0].options).toEqual([
			"Continue execution",
			"Provide guidance",
			"Mark plan as done",
			"Abort plan",
		]);
	});

	test("shows correct count when some steps are completed", async () => {
		const todos = SAMPLE_TODOS.map((t) => ({ ...t }));
		todos[0].completed = true; // step 1 done
		const entries = executionModeEntries(todos);
		const { ctx, selectCalls } = createUIContext(entries, "Abort plan");

		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		await harness.fireEvent(
			"agent_end",
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "Finished step 1." }] }] },
			ctx
		);

		expect(selectCalls).toHaveLength(1);
		expect(selectCalls[0].title).toContain("1/3");
	});

	test("'Continue execution' sends message with triggerTurn", async () => {
		const todos = SAMPLE_TODOS.map((t) => ({ ...t }));
		const entries = executionModeEntries(todos);
		const { ctx } = createUIContext(entries, "Continue execution");

		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		await harness.fireEvent(
			"agent_end",
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "Partial." }] }] },
			ctx
		);

		const execMsg = harness.sentMessages.find((m) => m.customType === "plan-mode-execute");
		expect(execMsg).toBeDefined();
		expect(execMsg?.options?.triggerTurn).toBe(true);
		expect(execMsg?.content).toContain("step 1");
	});

	test("'Mark plan as done' clears execution mode and restores tools", async () => {
		const todos = SAMPLE_TODOS.map((t) => ({ ...t }));
		const entries = executionModeEntries(todos);
		const { ctx } = createUIContext(entries, "Mark plan as done");

		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		await harness.fireEvent(
			"agent_end",
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "Done enough." }] }] },
			ctx
		);

		// Should send plan-complete message
		const completeMsg = harness.sentMessages.find((m) => m.customType === "plan-complete");
		expect(completeMsg).toBeDefined();
		expect(completeMsg?.options?.triggerTurn).toBe(false);

		// Should restore full tool set
		expect(harness.api.getActiveTools()).toEqual([...BASELINE_TOOLS]);

		// Persisted state should reflect cleared execution mode
		const lastEntry = harness.appendedEntries.findLast((e) => e.customType === "plan-mode");
		expect(lastEntry?.data).toMatchObject({ executing: false, todos: [] });
	});

	test("'Abort plan' clears execution mode without completion message", async () => {
		const todos = SAMPLE_TODOS.map((t) => ({ ...t }));
		const entries = executionModeEntries(todos);
		const { ctx } = createUIContext(entries, "Abort plan");

		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		await harness.fireEvent(
			"agent_end",
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "Stopping." }] }] },
			ctx
		);

		// Should NOT send plan-complete message
		const completeMsg = harness.sentMessages.find((m) => m.customType === "plan-complete");
		expect(completeMsg).toBeUndefined();

		// Should restore full tool set
		expect(harness.api.getActiveTools()).toEqual([...BASELINE_TOOLS]);

		// Persisted state should reflect cleared execution mode
		const lastEntry = harness.appendedEntries.findLast((e) => e.customType === "plan-mode");
		expect(lastEntry?.data).toMatchObject({ executing: false, todos: [] });
	});

	test("headless mode (no UI) returns silently", async () => {
		const todos = SAMPLE_TODOS.map((t) => ({ ...t }));
		const entries = executionModeEntries(todos);
		const ctx = createHeadlessContext(entries);

		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		await harness.fireEvent(
			"agent_end",
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }] },
			ctx
		);

		// No select calls, no crash, no sent messages
		expect(harness.sentMessages).toHaveLength(0);
	});

	test("all steps completed via [DONE:n] triggers clean completion", async () => {
		const todos = SAMPLE_TODOS.map((t) => ({ ...t }));
		const entries = executionModeEntries(todos);
		const { ctx, selectCalls } = createUIContext(entries);

		await harness.fireEvent("session_start", { type: "session_start" }, ctx);

		// Simulate turn_end with all DONE markers
		await harness.fireEvent(
			"turn_end",
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "[DONE:1] [DONE:2] [DONE:3]" }],
				},
			},
			ctx
		);

		// Now agent_end fires — all steps are complete
		await harness.fireEvent(
			"agent_end",
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "[DONE:1] [DONE:2] [DONE:3]" }],
					},
				],
			},
			ctx
		);

		// Should get "Plan Complete!" not the select menu
		const completeMsg = harness.sentMessages.find((m) => m.customType === "plan-complete");
		expect(completeMsg).toBeDefined();
		expect(selectCalls).toHaveLength(0);
	});
});

describe("execution mode widgets removed", () => {
	let harness: ExtensionHarness;
	let widgetCalls: Array<{ name: string; value: unknown }>;

	beforeEach(async () => {
		harness = ExtensionHarness.create();
		await harness.loadExtension(registerMockTools);
		await harness.loadExtension(planModeExtension);
		harness.api.setActiveTools([...BASELINE_TOOLS]);
		widgetCalls = [];
	});

	test("execution mode does not render banner or todo widgets", async () => {
		const todos = SAMPLE_TODOS.map((t) => ({ ...t }));
		const entries = executionModeEntries(todos);
		const { ctx } = createUIContext(entries, "Abort plan");

		// Intercept setWidget calls
		ctx.ui.setWidget = ((name: string, value: unknown) => {
			widgetCalls.push({ name, value });
		}) as never;

		await harness.fireEvent("session_start", { type: "session_start" }, ctx);

		// All plan-banner and plan-todos calls should be clearing (undefined)
		const bannerCalls = widgetCalls.filter((c) => c.name === "plan-banner");
		const todoCalls = widgetCalls.filter((c) => c.name === "plan-todos");

		for (const call of bannerCalls) {
			expect(call.value).toBeUndefined();
		}
		for (const call of todoCalls) {
			expect(call.value).toBeUndefined();
		}
	});
});
