import { afterEach, describe, expect, test } from "bun:test";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import {
	CONTEXT_BUDGET_API_CHANNELS,
	type ContextBudgetEnvelope,
} from "../../_shared/context-budget-interop.js";
import webFetchExtension, { type CapResolutionInput, resolveAdaptiveCap } from "../index.js";

/** Build a CapResolutionInput with test defaults. */
function makeInput(overrides: Partial<CapResolutionInput> = {}): CapResolutionInput {
	return {
		defaultMaxBytes: 32 * 1024,
		envelope: undefined,
		policyMax: 512 * 1024,
		policyMin: 4 * 1024,
		userMaxBytes: undefined,
		...overrides,
	};
}

/** Build a planner envelope. */
function makeEnvelope(maxBytes: number, batchSize = 1): ContextBudgetEnvelope {
	return { batchSize, maxBytes };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("resolveAdaptiveCap", () => {
	test("uses strict fallback when no envelope exists", () => {
		const result = resolveAdaptiveCap(makeInput());
		expect(result.effectiveMaxBytes).toBe(32 * 1024);
		expect(result.budgetLimited).toBe(false);
		expect(result.budgetReason).toContain("strict fallback");
		expect(result.batchSize).toBe(1);
	});

	test("marks budgetLimited when envelope reduces cap", () => {
		const result = resolveAdaptiveCap(makeInput({ envelope: makeEnvelope(8 * 1024, 3) }));
		expect(result.effectiveMaxBytes).toBe(8 * 1024);
		expect(result.budgetLimited).toBe(true);
		expect(result.batchSize).toBe(3);
	});

	test("clamps envelope to policy max", () => {
		const result = resolveAdaptiveCap(makeInput({ envelope: makeEnvelope(900 * 1024) }));
		expect(result.effectiveMaxBytes).toBe(512 * 1024);
		expect(result.budgetReason).toContain("policy max");
	});

	test("user maxBytes is a hard upper bound", () => {
		const result = resolveAdaptiveCap(
			makeInput({
				envelope: makeEnvelope(20 * 1024),
				userMaxBytes: 2 * 1024,
			})
		);
		expect(result.effectiveMaxBytes).toBe(2 * 1024);
		expect(result.budgetReason).toContain("user maxBytes");
	});
});

describe("web_fetch planner handshake", () => {
	test("requests planner API and consumes envelope by toolCallId", async () => {
		const harness = ExtensionHarness.create();
		const takeCalls: string[] = [];
		const envelopes = new Map<string, ContextBudgetEnvelope>([["tc-1", makeEnvelope(7 * 1024, 2)]]);

		harness.eventBus.on(CONTEXT_BUDGET_API_CHANNELS.budgetApiRequest, () => {
			harness.eventBus.emit(CONTEXT_BUDGET_API_CHANNELS.budgetApi, {
				api: {
					take(toolCallId: string): ContextBudgetEnvelope | undefined {
						takeCalls.push(toolCallId);
						const envelope = envelopes.get(toolCallId);
						envelopes.delete(toolCallId);
						return envelope;
					},
				},
			});
		});

		globalThis.fetch = async () =>
			new Response("x".repeat(20 * 1024), {
				headers: { "content-type": "text/html" },
				status: 200,
			});

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const result = await tool.execute("tc-1", { url: "https://example.com" }, undefined, () => {});
		const details = result.details as {
			effectiveMaxBytes?: number;
			batchSize?: number;
			budgetLimited?: boolean;
		};

		expect(takeCalls).toEqual(["tc-1"]);
		expect(details.effectiveMaxBytes).toBe(7 * 1024);
		expect(details.batchSize).toBe(2);
		expect(details.budgetLimited).toBe(true);
	});

	test("consumed envelope falls back on next call", async () => {
		const harness = ExtensionHarness.create();
		const envelopes = new Map<string, ContextBudgetEnvelope>([["tc-1", makeEnvelope(6 * 1024, 2)]]);

		harness.eventBus.on(CONTEXT_BUDGET_API_CHANNELS.budgetApiRequest, () => {
			harness.eventBus.emit(CONTEXT_BUDGET_API_CHANNELS.budgetApi, {
				api: {
					take(toolCallId: string): ContextBudgetEnvelope | undefined {
						const envelope = envelopes.get(toolCallId);
						envelopes.delete(toolCallId);
						return envelope;
					},
				},
			});
		});

		globalThis.fetch = async () =>
			new Response("x".repeat(80 * 1024), {
				headers: { "content-type": "text/html" },
				status: 200,
			});

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const first = await tool.execute("tc-1", { url: "https://example.com/1" }, undefined, () => {});
		const second = await tool.execute(
			"tc-1",
			{ url: "https://example.com/2" },
			undefined,
			() => {}
		);

		const firstDetails = first.details as { effectiveMaxBytes?: number };
		const secondDetails = second.details as { effectiveMaxBytes?: number; budgetReason?: string };
		expect(firstDetails.effectiveMaxBytes).toBe(6 * 1024);
		expect(secondDetails.effectiveMaxBytes).toBe(32 * 1024);
		expect(secondDetails.budgetReason).toContain("strict fallback");
	});
});
