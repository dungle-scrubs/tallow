import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import subagentExtension from "../index.js";
import {
	backgroundSubagents,
	cleanupCompletedBackgroundSubagents,
	getBackgroundSubagentOutput,
} from "../widget.js";

const originalSubagentFlag = process.env.PI_IS_SUBAGENT;

/**
 * Read a registered tool by name.
 * @param harness - Extension harness
 * @param name - Tool name
 * @returns Registered tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Tool not registered: ${name}`);
	return tool;
}

beforeEach(() => {
	delete process.env.PI_IS_SUBAGENT;
	backgroundSubagents.clear();
});

afterEach(() => {
	backgroundSubagents.clear();
	if (originalSubagentFlag === undefined) delete process.env.PI_IS_SUBAGENT;
	else process.env.PI_IS_SUBAGENT = originalSubagentFlag;
});

describe("subagent_status with compacted history", () => {
	it("reports retained final output even when messages were compacted away", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(subagentExtension);
		const statusTool = getTool(harness, "subagent_status");

		backgroundSubagents.set("bg_compacted", {
			agent: "reviewer",
			completedAt: Date.now(),
			historyCompacted: true,
			historyOriginalMessageCount: 42,
			historyRetainedMessageCount: 3,
			id: "bg_compacted",
			process: { kill: () => true } as never,
			result: {
				agent: "reviewer",
				agentSource: "user",
				exitCode: 0,
				messages: [],
				stderr: "",
				task: "summarize",
				usage: {
					cacheRead: 0,
					cacheWrite: 0,
					contextTokens: 0,
					cost: 0,
					denials: 0,
					input: 0,
					output: 0,
					turns: 0,
				},
			},
			retainedFinalOutput: "compacted final output",
			startTime: Date.now() - 5000,
			status: "completed",
			task: "summarize",
		});

		const result = await statusTool.execute("status-call", { taskId: "bg_compacted" });
		const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("compacted final output");
		expect(text).toContain("History:** compacted (3/42 messages retained)");
	});

	it("drops stale completed entries during cleanup without touching running ones", () => {
		backgroundSubagents.set("bg_stale", {
			agent: "worker",
			completedAt: 1_000,
			id: "bg_stale",
			process: { kill: () => true } as never,
			result: {
				agent: "worker",
				agentSource: "user",
				exitCode: 0,
				messages: [],
				stderr: "",
				task: "old",
				usage: {
					cacheRead: 0,
					cacheWrite: 0,
					contextTokens: 0,
					cost: 0,
					denials: 0,
					input: 0,
					output: 0,
					turns: 0,
				},
			},
			startTime: 0,
			status: "completed",
			task: "old",
		});
		backgroundSubagents.set("bg_running", {
			agent: "worker",
			id: "bg_running",
			process: { kill: () => true } as never,
			result: {
				agent: "worker",
				agentSource: "user",
				exitCode: -1,
				messages: [],
				stderr: "",
				task: "live",
				usage: {
					cacheRead: 0,
					cacheWrite: 0,
					contextTokens: 0,
					cost: 0,
					denials: 0,
					input: 0,
					output: 0,
					turns: 0,
				},
			},
			startTime: 0,
			status: "running",
			task: "live",
		});

		const removed = cleanupCompletedBackgroundSubagents(undefined, 10_000, 3_000);
		expect(removed).toBe(1);
		expect(backgroundSubagents.has("bg_stale")).toBe(false);
		expect(backgroundSubagents.has("bg_running")).toBe(true);
		const running = backgroundSubagents.get("bg_running");
		expect(running).toBeDefined();
		if (!running) throw new Error("Expected running background subagent to remain");
		expect(getBackgroundSubagentOutput(running)).toBe("");
	});
});
