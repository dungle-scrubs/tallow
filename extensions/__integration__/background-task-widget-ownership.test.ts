import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../test-utils/extension-harness.js";
import backgroundTasksExtension, {
	setBackgroundTaskSpawnForTests,
} from "../background-task-tool/index.js";
import { registerTasksExtension } from "../tasks/commands/register-tasks-extension.js";
import { TaskListStore } from "../tasks/state/index.js";

const ORIGINAL_PI_IS_SUBAGENT = process.env.PI_IS_SUBAGENT;
const ORIGINAL_PI_TEAM_NAME = process.env.PI_TEAM_NAME;

interface CapturedWidget {
	render: ((width: number) => string[]) | null;
}

interface WidgetCapture {
	widgets: Map<string, CapturedWidget>;
}

/**
 * Build an interactive-mode-like context that captures widgets by key.
 *
 * @param captured - Mutable widget capture registry
 * @returns Extension context for event and tool execution
 */
function createContext(captured: WidgetCapture): ExtensionContext {
	const theme = {
		bold: (text: string) => text,
		fg: (_color: unknown, text: string) => text,
		strikethrough: (text: string) => text,
	} as ExtensionContext["ui"]["theme"];

	return {
		ui: {
			async confirm() {
				return false;
			},
			async custom() {
				return undefined as never;
			},
			async editor() {
				return undefined;
			},
			get theme() {
				return theme;
			},
			getAllThemes() {
				return [];
			},
			getEditorText() {
				return "";
			},
			getTheme() {
				return undefined;
			},
			getToolsExpanded() {
				return false;
			},
			async input() {
				return undefined;
			},
			notify() {},
			pasteToEditor() {},
			async select() {
				return undefined;
			},
			setEditorComponent() {},
			setEditorText() {},
			setFooter() {},
			setHeader() {},
			setStatus() {},
			setTheme() {
				return { success: false, error: "Test stub" };
			},
			setTitle() {},
			setToolsExpanded() {},
			setWidget(name, widget) {
				if (!widget) {
					captured.widgets.delete(name);
					return;
				}
				if (Array.isArray(widget)) {
					captured.widgets.set(name, {
						render: () => widget,
					});
					return;
				}
				const component = widget(undefined as never, undefined as never);
				captured.widgets.set(name, {
					render: (width) => component.render(width),
				});
			},
			setWorkingMessage() {},
		} as ExtensionContext["ui"],
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: {
			appendEntry: () => {},
			getEntries: () => [],
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
 * Read a registered tool by name.
 *
 * @param harness - Extension harness instance
 * @param name - Tool name to resolve
 * @returns Registered tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Expected tool "${name}" to be registered`);
	return tool;
}

/**
 * Execute a tool with the widget-capturing context.
 *
 * @param ctx - Extension execution context
 * @param tool - Tool definition to execute
 * @param params - Tool parameters
 * @returns Tool result payload
 */
async function execTool(
	ctx: ExtensionContext,
	tool: ToolDefinition,
	params: Record<string, unknown>
): Promise<{ details: Record<string, unknown> }> {
	return (await tool.execute("test-tool-call", params as never, undefined, undefined, ctx)) as {
		details: Record<string, unknown>;
	};
}

/**
 * Render a captured widget to plain text.
 *
 * @param captured - Widget capture registry
 * @param name - Widget key
 * @param width - Terminal width to render at
 * @returns Joined widget text
 */
function renderWidget(captured: WidgetCapture, name: string, width: number): string {
	const widget = captured.widgets.get(name);
	if (!widget?.render) throw new Error(`Expected widget "${name}" to be captured`);
	return widget.render(width).join("\n");
}

beforeEach(() => {
	process.env.PI_IS_SUBAGENT = "0";
	delete process.env.PI_TEAM_NAME;
	setBackgroundTaskSpawnForTests(undefined);
});

afterEach(() => {
	setBackgroundTaskSpawnForTests(undefined);
	if (ORIGINAL_PI_IS_SUBAGENT === undefined) delete process.env.PI_IS_SUBAGENT;
	else process.env.PI_IS_SUBAGENT = ORIGINAL_PI_IS_SUBAGENT;
	if (ORIGINAL_PI_TEAM_NAME === undefined) delete process.env.PI_TEAM_NAME;
	else process.env.PI_TEAM_NAME = ORIGINAL_PI_TEAM_NAME;
});

describe("background task widget ownership", () => {
	it("keeps the standalone bg-tasks widget when tasks is not registered", async () => {
		const harness = ExtensionHarness.create();
		const captured: WidgetCapture = { widgets: new Map() };
		const ctx = createContext(captured);
		backgroundTasksExtension(harness.api);

		try {
			await harness.fireEvent("session_start", {}, ctx);
			const bgBash = getTool(harness, "bg_bash");
			await execTool(ctx, bgBash, { command: "sleep 5" });

			expect(captured.widgets.has("bg-tasks")).toBe(true);
			expect(renderWidget(captured, "bg-tasks", 120)).toContain("sleep 5");
		} finally {
			await harness.fireEvent("session_shutdown", {}, ctx);
			harness.reset();
		}
	});

	it("suppresses the standalone widget when tasks owns background-task presentation", async () => {
		const harness = ExtensionHarness.create();
		const captured: WidgetCapture = { widgets: new Map() };
		const ctx = createContext(captured);
		backgroundTasksExtension(harness.api);
		registerTasksExtension(harness.api, new TaskListStore(null), null);

		try {
			await harness.fireEvent("session_start", {}, ctx);
			const bgBash = getTool(harness, "bg_bash");
			await execTool(ctx, bgBash, { command: "sleep 5" });

			expect(captured.widgets.has("bg-tasks")).toBe(false);
			expect(captured.widgets.has("1-tasks")).toBe(true);
			expect(renderWidget(captured, "1-tasks", 120)).toContain("Background Tasks (1)");
			expect(renderWidget(captured, "1-tasks", 120)).toContain("sleep 5");
		} finally {
			await harness.fireEvent("session_shutdown", {}, ctx);
			harness.reset();
		}
	});
});
