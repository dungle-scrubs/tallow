import { afterEach, describe, expect, test } from "bun:test";
import type {
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TOOL_RESULT_BUDGET_GUARD_MARKER } from "../../src/sdk.js";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";
import { createSessionRunner, type SessionRunner } from "../../test-utils/session-runner.js";
import webFetchExtension from "../web-fetch-tool/index.js";

let runner: SessionRunner | undefined;
const originalFetch = globalThis.fetch;

afterEach(() => {
	runner?.dispose();
	runner = undefined;
	globalThis.fetch = originalFetch;
});

/** Build a read-like probe tool with structured details. */
function createReadProbeExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "read_probe",
			label: "read_probe",
			description: "Probe read-like result details",
			parameters: Type.Object({ path: Type.String() }),
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: `read:${params.path}` }],
					details: { _readProbe: true, path: params.path, size: 42 },
				};
			},
		});
	};
}

/** Build a bash-like probe tool with structured details. */
function createBashProbeExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "bash_probe",
			label: "bash_probe",
			description: "Probe bash-like result details",
			parameters: Type.Object({ command: Type.String() }),
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: `bash:${params.command}` }],
					details: { _bashProbe: true, command: params.command, exitCode: 0 },
				};
			},
		});
	};
}

/** Build a tool that emits an intentionally huge text payload. */
function createHugeOutputExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "huge_text",
			label: "huge_text",
			description: "Emit large text to exercise ingestion-time guardrails",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text", text: "z".repeat(2 * 1024 * 1024) }],
					details: { source: "integration" },
				};
			},
		});
	};
}

/** True when run events indicate overflow recovery failure. */
function hasOverflowRecoveryFailure(events: AgentSessionEvent[]): boolean {
	return events.some(
		(event) =>
			(event.type === "auto_compaction_start" && event.reason === "overflow") ||
			(event.type === "agent_end" && "error" in event && event.error != null)
	);
}

describe("context budget guard integration", () => {
	test("applies planner envelopes to batched web_fetch and preserves read/bash details", async () => {
		globalThis.fetch = async () =>
			new Response("x".repeat(200 * 1024), {
				headers: { "content-type": "text/html" },
				status: 200,
			});

		const webFetchDetails: Array<{
			batchSize?: number;
			budgetLimited?: boolean;
			effectiveMaxBytes?: number;
			truncated?: boolean;
		}> = [];
		let readProbeDetails: Record<string, unknown> | undefined;
		let bashProbeDetails: Record<string, unknown> | undefined;

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName === "web_fetch") {
					webFetchDetails.push(event.details as (typeof webFetchDetails)[number]);
					return;
				}
				if (event.toolName === "read_probe") {
					readProbeDetails = event.details as Record<string, unknown>;
					return;
				}
				if (event.toolName === "bash_probe") {
					bashProbeDetails = event.details as Record<string, unknown>;
				}
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [
						{ name: "web_fetch", arguments: { url: "https://example.com/a" } },
						{ name: "web_fetch", arguments: { url: "https://example.com/b" } },
						{ name: "web_fetch", arguments: { url: "https://example.com/c" } },
						{ name: "read_probe", arguments: { path: "README.md" } },
						{ name: "bash_probe", arguments: { command: "echo ok" } },
					],
				},
				{ text: "done" },
			]),
			extensionFactories: [
				webFetchExtension,
				createReadProbeExtension(),
				createBashProbeExtension(),
				tracker,
			],
		});

		const result = await runner.run("Run a mixed tool batch");

		expect(webFetchDetails).toHaveLength(3);
		for (const details of webFetchDetails) {
			expect(details.batchSize).toBe(5);
			expect(typeof details.effectiveMaxBytes).toBe("number");
			expect(details.effectiveMaxBytes).toBeGreaterThan(0);
		}
		expect(webFetchDetails.some((details) => details.truncated === true)).toBe(true);

		expect(readProbeDetails?._readProbe).toBe(true);
		expect(bashProbeDetails?._bashProbe).toBe(true);

		expect(hasOverflowRecoveryFailure(result.events)).toBe(false);
	});

	test("envelopes are consumed and reset between turns", async () => {
		globalThis.fetch = async () =>
			new Response("x".repeat(64 * 1024), {
				headers: { "content-type": "text/html" },
				status: 200,
			});

		const batchSizes: number[] = [];
		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName !== "web_fetch") return;
				const details = event.details as { batchSize?: number };
				batchSizes.push(details.batchSize ?? -1);
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{
					toolCalls: [
						{ name: "web_fetch", arguments: { url: "https://example.com/1" } },
						{ name: "web_fetch", arguments: { url: "https://example.com/2" } },
					],
				},
				{ text: "turn one complete" },
				{ toolCalls: [{ name: "web_fetch", arguments: { url: "https://example.com/3" } }] },
				{ text: "turn two complete" },
			]),
			extensionFactories: [webFetchExtension, tracker],
		});

		await runner.run("First turn");
		await runner.run("Second turn");

		expect(batchSizes).toHaveLength(3);
		expect(batchSizes[0]).toBe(2);
		expect(batchSizes[1]).toBe(2);
		expect(batchSizes[2]).toBe(1);
	});

	test("ingestion-time guard truncates oversized uncapped tool results", async () => {
		let guardedResult:
			| {
					contentText: string;
					details: Record<string, unknown> | undefined;
					toolCallId: string;
					toolName: string;
			  }
			| undefined;

		const tracker: ExtensionFactory = (pi: ExtensionAPI): void => {
			pi.on("tool_result", async (event) => {
				if (event.toolName !== "huge_text") return;
				const textBlock = event.content.find((block) => block.type === "text");
				guardedResult = {
					contentText: textBlock?.type === "text" ? textBlock.text : "",
					details: event.details as Record<string, unknown> | undefined,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
				};
			});
		};

		runner = await createSessionRunner({
			streamFn: createScriptedStreamFn([
				{ toolCalls: [{ name: "huge_text", arguments: {} }] },
				{ text: "done" },
			]),
			extensionFactories: [createHugeOutputExtension(), tracker],
		});

		await runner.run("Call huge_text once");

		expect(guardedResult).toBeDefined();
		expect(guardedResult?.toolCallId).toContain("mock-tc-");
		expect(guardedResult?.toolName).toBe("huge_text");
		expect(guardedResult?.contentText).toContain("[output truncated by context-budget guard");

		const guardMeta = guardedResult?.details?.[TOOL_RESULT_BUDGET_GUARD_MARKER];
		expect(typeof guardMeta).toBe("object");
	});
});
