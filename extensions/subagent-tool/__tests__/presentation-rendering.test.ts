import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message } from "@mariozechner/pi-ai";
import type { Theme, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import type { SingleResult, SubagentDetails } from "../formatting.js";
import subagentExtension from "../index.js";

/**
 * Build a lightweight theme that tags style roles for assertions.
 *
 * @returns Theme-like object for render tests
 */
function createTaggedTheme(): Theme {
	return {
		fg(color, text) {
			return `<${color}>${text}</${color}>`;
		},
		bold(text) {
			return `<b>${text}</b>`;
		},
	} as unknown as Theme;
}

/**
 * Render a component into normalized multiline text.
 *
 * @param component - TUI component returned by renderCall/renderResult
 * @returns Trimmed multiline output
 */
function renderComponent(component: { render: (width: number) => string[] }): string {
	return component
		.render(140)
		.map((line) => line.trimEnd())
		.join("\n");
}

/**
 * Get a registered tool by name.
 *
 * @param harness - Extension harness
 * @param name - Tool name
 * @returns Registered tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Tool not registered: ${name}`);
	return tool;
}

/**
 * Create a minimal assistant message for display rendering tests.
 *
 * @param text - Assistant text content
 * @returns Message object
 */
function assistantTextMessage(text: string): Message {
	return {
		content: [{ text, type: "text" }],
		role: "assistant",
	} as unknown as Message;
}

/**
 * Create a single result with sensible defaults.
 *
 * @param partial - Fields to override
 * @returns Complete single result
 */
function makeResult(
	partial: Partial<SingleResult> & Pick<SingleResult, "agent" | "exitCode" | "task">
): SingleResult {
	return {
		agent: partial.agent,
		agentSource: partial.agentSource ?? "user",
		deniedTools: partial.deniedTools,
		exitCode: partial.exitCode,
		errorMessage: partial.errorMessage,
		messages: partial.messages ?? [],
		model: partial.model,
		stderr: partial.stderr ?? "",
		step: partial.step,
		stopReason: partial.stopReason,
		task: partial.task,
		usage: partial.usage ?? {
			cacheRead: 0,
			cacheWrite: 0,
			contextTokens: 0,
			cost: 0,
			denials: 0,
			input: 0,
			output: 0,
			turns: 0,
		},
	};
}

describe("subagent presentation rendering", () => {
	const originalSubagentFlag = process.env.PI_IS_SUBAGENT;
	let harness: ExtensionHarness;
	let tool: ToolDefinition;
	let theme: Theme;

	beforeEach(async () => {
		delete process.env.PI_IS_SUBAGENT;
		harness = ExtensionHarness.create();
		await harness.loadExtension(subagentExtension);
		tool = getTool(harness, "subagent");
		theme = createTaggedTheme();
	});

	afterEach(() => {
		if (originalSubagentFlag === undefined) delete process.env.PI_IS_SUBAGENT;
		else process.env.PI_IS_SUBAGENT = originalSubagentFlag;
	});

	it("renders single-call hierarchy with prominent title/action/identity and muted metadata", () => {
		const component = tool.renderCall?.(
			{
				agent: "worker",
				agentScope: "both",
				model: "claude-sonnet",
				task: "Implement authentication flow with retry handling",
			},
			theme
		);
		if (!component) throw new Error("subagent.renderCall returned undefined");

		const rendered = renderComponent(component);
		expect(rendered).toContain("<b><toolTitle>subagent</toolTitle></b>");
		expect(rendered).toContain("<accent>single</accent>");
		expect(rendered).toContain("worker");
		expect(rendered).toContain("<muted>scope:both • model:claude-sonnet</muted>");
		expect(rendered).toContain("<dim>Implement authentication flow with retry handling</dim>");
	});

	it("keeps parallel running collapsed tree readable with short previews", () => {
		const details: SubagentDetails = {
			agentScope: "user",
			mode: "parallel",
			projectAgentsDir: null,
			results: [
				makeResult({
					agent: "alpha",
					exitCode: -1,
					model: "openai-codex/gpt-5.1",
					messages: [
						assistantTextMessage(
							"Investigating the codebase and collecting context before applying patches [END_MARKER_ALPHA]"
						),
					],
					task: "Investigate auth regression and identify root cause",
					usage: {
						cacheRead: 0,
						cacheWrite: 0,
						contextTokens: 0,
						cost: 0,
						denials: 0,
						input: 220,
						output: 48,
						turns: 1,
					},
				}),
				makeResult({
					agent: "beta",
					exitCode: -1,
					model: "openai-codex/gpt-5.1-mini",
					task: "Refactor metrics formatter for consistency",
					usage: {
						cacheRead: 0,
						cacheWrite: 0,
						contextTokens: 0,
						cost: 0,
						denials: 0,
						input: 180,
						output: 30,
						turns: 1,
					},
				}),
				makeResult({
					agent: "gamma",
					exitCode: 0,
					messages: [assistantTextMessage("Done: added regression test and updated docs")],
					task: "Write regression test",
					usage: {
						cacheRead: 0,
						cacheWrite: 0,
						contextTokens: 0,
						cost: 0,
						denials: 0,
						input: 140,
						output: 90,
						turns: 1,
					},
				}),
			],
			spinnerFrame: 2,
		};

		const component = tool.renderResult?.(
			{ content: [{ text: "", type: "text" }], details },
			{ expanded: false },
			theme
		);
		if (!component) throw new Error("subagent.renderResult returned undefined");

		const rendered = renderComponent(component);
		expect(rendered).toContain("<b><toolTitle>subagent</toolTitle></b>");
		expect(rendered).toContain("<accent>parallel</accent>");
		expect(rendered).toContain("├─");
		expect(rendered).toContain("└─");
		expect(rendered).toContain("<dim>(gpt-5.1)</dim>");
		expect(rendered).toMatch(/<warning>[^<]+<\/warning> .*alpha/);
		expect(rendered).not.toContain("END_MARKER_ALPHA");
		expect(rendered).not.toContain("─── Activity ───");
		expect((rendered.match(/↑/g) ?? []).length).toBe(1);
	});
});
