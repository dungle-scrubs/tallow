import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import { stripAnsi } from "../../../test-utils/virtual-terminal.js";
import { emitInteropEvent, INTEROP_EVENT_NAMES } from "../../_shared/interop-events.js";
import { registerTasksExtension } from "../commands/register-tasks-extension.js";
import { type SubagentView, TaskListStore } from "../state/index.js";

const ORIGINAL_PI_IS_SUBAGENT = process.env.PI_IS_SUBAGENT;
const ORIGINAL_PI_TEAM_NAME = process.env.PI_TEAM_NAME;

interface CapturedWidget {
	render: ((width: number) => string[]) | null;
}

interface WidgetFixture {
	captured: CapturedWidget;
	ctx: ExtensionContext;
	harness: ExtensionHarness;
	manage: ToolDefinition;
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

/**
 * Assert every rendered line fits inside the target width.
 *
 * @param lines - Rendered widget lines
 * @param width - Maximum allowed width
 * @returns void
 */
function expectLinesWithinWidth(lines: string[], width: number): void {
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

/**
 * Emit a subagent snapshot into the interop event bus.
 *
 * @param harness - Extension harness
 * @param snapshot - Foreground/background subagent payload
 * @returns void
 */
function emitSubagentsSnapshot(
	harness: ExtensionHarness,
	snapshot: { background?: SubagentView[]; foreground?: SubagentView[] }
): void {
	emitInteropEvent(harness.api.events, INTEROP_EVENT_NAMES.subagentsSnapshot, {
		background: snapshot.background ?? [],
		foreground: snapshot.foreground ?? [],
	});
}

/**
 * Build a deterministic subagent view for widget tests.
 *
 * @param overrides - Partial subagent fields to override
 * @returns Complete subagent view
 */
function createSubagent(
	overrides: Partial<SubagentView> & Pick<SubagentView, "agent" | "id" | "status" | "task">
): SubagentView {
	return {
		agent: overrides.agent,
		id: overrides.id,
		model: overrides.model ?? "anthropic/claude-sonnet-4-5",
		startTime: overrides.startTime ?? Date.now() - 10_000,
		status: overrides.status,
		task: overrides.task,
	};
}

/**
 * Create and initialize a widget fixture.
 *
 * @param withTask - Optional seed task to force side-by-side layout availability
 * @returns Ready-to-use fixture
 */
async function createFixture(withTask?: string): Promise<WidgetFixture> {
	const harness = ExtensionHarness.create();
	registerTasksExtension(harness.api, new TaskListStore(null), null);

	const captured: CapturedWidget = { render: null };
	const ctx = createWidgetContext(captured);
	const manage = getManageTool(harness);

	await harness.fireEvent("session_start", {}, ctx);
	if (withTask) {
		await execManage(manage, ctx, {
			action: "add",
			task: withTask,
		});
	}

	return { captured, ctx, harness, manage };
}

/**
 * Shutdown fixture resources and timers.
 *
 * @param fixture - Active fixture
 * @returns Promise resolving when cleanup is complete
 */
async function shutdownFixture(fixture: WidgetFixture): Promise<void> {
	await fixture.harness.fireEvent("session_shutdown", {}, fixture.ctx);
}

/**
 * Extract the task preview text for a line containing the provided token.
 *
 * @param lines - Rendered widget lines
 * @param token - Unique token present in preview text
 * @returns Preview text from token onward
 */
function extractPreview(lines: string[], token: string): string {
	const plainLines = lines.map((line) => stripAnsi(line));
	const matchingLine = plainLines.find((line) => line.includes(token));
	if (!matchingLine) throw new Error(`Expected preview line containing token: ${token}`);

	const separator = "  │  ";
	const separatorIndex = matchingLine.lastIndexOf(separator);
	const content =
		separatorIndex >= 0 ? matchingLine.slice(separatorIndex + separator.length) : matchingLine;
	const trimmedContent = content.trimStart();
	const tokenIndex = trimmedContent.indexOf(token);
	if (tokenIndex < 0) throw new Error(`Preview token not found in content: ${token}`);
	return trimmedContent.slice(tokenIndex);
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

describe("tasks widget subagent sections", () => {
	it("omits subagent sections for foreground-only snapshots", async () => {
		const fixture = await createFixture("Keep task list visible");
		try {
			emitSubagentsSnapshot(fixture.harness, {
				foreground: [
					createSubagent({
						agent: "reviewer",
						id: "fg_1",
						status: "running",
						task: "Review changed files",
					}),
				],
			});

			const lines = renderWidget(fixture.captured, 90);
			const text = stripAnsi(lines.join("\n"));
			expect(text).toContain("Tasks (0/1)");
			expect(text).not.toContain("Foreground Subagents (blocking");
			expect(text).not.toContain("Background Subagents (non-blocking");
			expectLinesWithinWidth(lines, 90);
		} finally {
			await shutdownFixture(fixture);
		}
	});

	it("does not mount the widget when foreground subagents are the only activity", async () => {
		const fixture = await createFixture();
		try {
			emitSubagentsSnapshot(fixture.harness, {
				foreground: [
					createSubagent({
						agent: "reviewer",
						id: "fg_only",
						status: "running",
						task: "Review changed files",
					}),
				],
			});

			expect(fixture.captured.render).toBeNull();
		} finally {
			await shutdownFixture(fixture);
		}
	});

	it("labels a background-only snapshot as non-blocking background subagents", async () => {
		const fixture = await createFixture();
		try {
			emitSubagentsSnapshot(fixture.harness, {
				background: [
					createSubagent({
						agent: "researcher",
						id: "bg_1",
						status: "running",
						task: "Research integration approach",
					}),
				],
			});

			const lines = renderWidget(fixture.captured, 90);
			const text = stripAnsi(lines.join("\n"));
			expect(text).toContain("Background Subagents (non-blocking · 1 running)");
			expect(text).not.toContain("Foreground Subagents (blocking");
			expectLinesWithinWidth(lines, 90);
		} finally {
			await shutdownFixture(fixture);
		}
	});

	it("renders only the background heading for mixed foreground/background snapshots", async () => {
		const fixture = await createFixture();
		try {
			emitSubagentsSnapshot(fixture.harness, {
				background: [
					createSubagent({
						agent: "researcher",
						id: "bg_stalled",
						status: "stalled",
						task: "Investigate flaky test suite",
					}),
				],
				foreground: [
					createSubagent({
						agent: "reviewer",
						id: "fg_running",
						status: "running",
						task: "Review PR changes",
					}),
				],
			});

			const lines = renderWidget(fixture.captured, 95);
			const text = stripAnsi(lines.join("\n"));
			expect(text).toContain("Background Subagents (non-blocking · 1 stalled)");
			expect(text).not.toContain("Foreground Subagents (blocking");
			expect(text).not.toContain("Subagents (1 running · 1 stalled)");
			expectLinesWithinWidth(lines, 95);
		} finally {
			await shutdownFixture(fixture);
		}
	});

	it("scales truncation budget with width in both stacked and side-by-side layouts", async () => {
		const fixture = await createFixture("Track width-aware truncation");
		const longTask = Array.from(
			{ length: 20 },
			(_value, index) => `seg${String(index + 1).padStart(2, "0")}`
		).join(" ");

		try {
			emitSubagentsSnapshot(fixture.harness, {
				background: [
					createSubagent({
						agent: "widthprobe",
						id: "width_bg",
						status: "running",
						task: longTask,
					}),
				],
			});

			const stackedNarrow = renderWidget(fixture.captured, 55);
			const stackedWide = renderWidget(fixture.captured, 95);
			const stackedNarrowPreview = extractPreview(stackedNarrow, "seg01");
			const stackedWidePreview = extractPreview(stackedWide, "seg01");
			expect(stackedNarrowPreview).toContain("...");
			expect(stackedWidePreview).toContain("...");
			expect(stackedNarrowPreview).not.toContain("seg10");
			expect(stackedWidePreview).toContain("seg10");
			expect(visibleWidth(stackedWidePreview)).toBeGreaterThan(visibleWidth(stackedNarrowPreview));
			expectLinesWithinWidth(stackedNarrow, 55);
			expectLinesWithinWidth(stackedWide, 95);

			const sideBySideNarrow = renderWidget(fixture.captured, 124);
			const sideBySideWide = renderWidget(fixture.captured, 180);
			const sideBySideNarrowPreview = extractPreview(sideBySideNarrow, "seg01");
			const sideBySideWidePreview = extractPreview(sideBySideWide, "seg01");
			expect(sideBySideNarrowPreview).toContain("...");
			expect(sideBySideWidePreview).toContain("...");
			expect(sideBySideNarrowPreview).not.toContain("seg12");
			expect(sideBySideWidePreview).toContain("seg12");
			expect(visibleWidth(sideBySideWidePreview)).toBeGreaterThan(
				visibleWidth(sideBySideNarrowPreview)
			);
			expectLinesWithinWidth(sideBySideNarrow, 124);
			expectLinesWithinWidth(sideBySideWide, 180);
		} finally {
			await shutdownFixture(fixture);
		}
	});
});
