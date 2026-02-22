import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import { stripAnsi } from "../../../test-utils/virtual-terminal.js";
import { emitInteropEvent, INTEROP_EVENT_NAMES } from "../../_shared/interop-events.js";
import { registerTasksExtension } from "../commands/register-tasks-extension.js";
import { TaskListStore } from "../state/index.js";

const ORIGINAL_PI_IS_SUBAGENT = process.env.PI_IS_SUBAGENT;
const ORIGINAL_PI_TEAM_NAME = process.env.PI_TEAM_NAME;

interface CapturedWidget {
	render: ((width: number) => string[]) | null;
}

/**
 * Build a minimal UI context that captures task widget renders.
 *
 * @param captured - Mutable widget capture sink
 * @returns Extension context for event/tool execution
 */
function createWidgetContext(captured: CapturedWidget): ExtensionContext {
	const theme = {
		fg: (_color: unknown, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as ExtensionContext["ui"]["theme"];

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
			setWidget(_name, widget) {
				if (!widget) {
					captured.render = null;
					return;
				}
				if (Array.isArray(widget)) {
					captured.render = () => widget;
					return;
				}
				if (typeof widget === "function") {
					const component = widget(undefined as never, undefined as never);
					captured.render = (width) => component.render(width);
				}
			},
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
			get theme() {
				return theme;
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
		hasUI: true,
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
 * Get the registered manage_tasks tool.
 *
 * @param harness - Extension harness instance
 * @returns Registered tool definition
 */
function getManageTool(harness: ExtensionHarness): ToolDefinition {
	const tool = harness.tools.get("manage_tasks");
	if (!tool) throw new Error("Expected manage_tasks tool to be registered");
	return tool;
}

/**
 * Execute manage_tasks with a provided extension context.
 *
 * @param tool - manage_tasks tool
 * @param ctx - Runtime extension context
 * @param params - Tool parameters
 * @returns Promise resolving after tool execution completes
 */
async function execManage(
	tool: ToolDefinition,
	ctx: ExtensionContext,
	params: Record<string, unknown>
): Promise<void> {
	await tool.execute("test-call", params as never, undefined, undefined, ctx);
}

/**
 * Render the currently captured tasks widget at a specific width.
 *
 * @param captured - Widget capture sink
 * @param width - Terminal width
 * @returns Rendered widget lines
 */
function renderWidget(captured: CapturedWidget, width: number): string[] {
	if (!captured.render) throw new Error("Expected tasks widget to be captured");
	return captured.render(width);
}

beforeEach(() => {
	process.env.PI_IS_SUBAGENT = "0";
	delete process.env.PI_TEAM_NAME;
});

afterEach(() => {
	if (ORIGINAL_PI_IS_SUBAGENT === undefined) delete process.env.PI_IS_SUBAGENT;
	else process.env.PI_IS_SUBAGENT = ORIGINAL_PI_IS_SUBAGENT;
	if (ORIGINAL_PI_TEAM_NAME === undefined) delete process.env.PI_TEAM_NAME;
	else process.env.PI_TEAM_NAME = ORIGINAL_PI_TEAM_NAME;
});

describe("tasks widget stalled subagent rendering", () => {
	it("shows running/stalled split headers, stalled row labels, and bounded previews", async () => {
		const harness = ExtensionHarness.create();
		registerTasksExtension(harness.api, new TaskListStore(null), null);

		const captured: CapturedWidget = { render: null };
		const ctx = createWidgetContext(captured);
		const manage = getManageTool(harness);

		await harness.fireEvent("session_start", {}, ctx);
		await execManage(manage, ctx, {
			action: "add",
			task: "Track stalled subagent rendering",
		});

		const longTask =
			"Investigate a very long stalled subagent preview string that should be truncated in " +
			"both side-by-side and stacked layouts so text remains bounded.";
		emitInteropEvent(harness.api.events, INTEROP_EVENT_NAMES.subagentsSnapshot, {
			background: [
				{
					agent: "researcher",
					id: "bg_stalled",
					model: "anthropic/claude-opus-4-5",
					startTime: Date.now() - 20_000,
					status: "stalled",
					task: longTask,
				},
			],
			foreground: [
				{
					agent: "reviewer",
					id: "fg_running",
					model: "anthropic/claude-sonnet-4-5",
					startTime: Date.now() - 10_000,
					status: "running",
					task: "Review changed files",
				},
			],
		});

		const sideBySideLines = renderWidget(captured, 140);
		const sideBySideText = stripAnsi(sideBySideLines.join("\n"));
		expect(sideBySideText).toContain("Subagents (1 running · 1 stalled)");
		expect(sideBySideText).toContain("@researcher");
		expect(sideBySideText).toContain("stalled");
		expect(sideBySideText).toContain("...");
		for (const line of sideBySideLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(140);
		}

		const stackedLines = renderWidget(captured, 80);
		const stackedText = stripAnsi(stackedLines.join("\n"));
		expect(stackedText).toContain("Subagents (1 running · 1 stalled)");
		expect(stackedText).toContain("@researcher");
		expect(stackedText).toContain("stalled");
		expect(stackedText).toContain("...");
		for (const line of stackedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}

		await harness.fireEvent("session_shutdown", {}, ctx);
	});
});
