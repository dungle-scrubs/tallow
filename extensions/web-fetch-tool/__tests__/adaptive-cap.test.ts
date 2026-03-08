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

describe("web_fetch dendrite fallback", () => {
	test("does not run package fallback unless explicitly enabled", async () => {
		const harness = ExtensionHarness.create();
		const execCalls: string[] = [];
		(harness.api as { exec: typeof harness.api.exec }).exec = async (command, args) => {
			execCalls.push([command, ...args].join(" "));
			return {
				code: 0,
				killed: false,
				stderr: "",
				stdout: "",
			};
		};

		globalThis.fetch = async () =>
			new Response("Access denied. Please enable JavaScript.", {
				headers: { "content-type": "text/html" },
				status: 403,
				statusText: "Forbidden",
			});

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const result = await tool.execute("tc-1", { url: "https://example.com" }, undefined, () => {});
		const text = result.content[0];
		const details = result.details as {
			error?: string;
			fallbackReason?: string;
			fallbackUsed?: boolean;
		};

		expect(text?.type).toBe("text");
		expect(text?.type === "text" ? text.text : "").toContain("Package fallback disabled");
		expect(details.fallbackReason).toContain("HTTP 403");
		expect(details.fallbackUsed).toBe(false);
		expect(execCalls).toEqual([]);
	});

	test("uses dendrite-scraper binary on retryable HTTP pages when explicitly enabled", async () => {
		const harness = ExtensionHarness.create();
		const execCalls: string[] = [];
		(harness.api as { exec: typeof harness.api.exec }).exec = async (command, args) => {
			execCalls.push([command, ...args].join(" "));
			return {
				code: 0,
				killed: false,
				stderr: "",
				stdout: JSON.stringify({
					attempts: ["jina fallback"],
					markdown: "# Clean page",
					ok: true,
					source: "jina",
					url: "https://example.com",
				}),
			};
		};

		globalThis.fetch = async () =>
			new Response("Access denied. Please enable JavaScript.", {
				headers: { "content-type": "text/html" },
				status: 403,
				statusText: "Forbidden",
			});

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const result = await tool.execute(
			"tc-1",
			{ allowPackageFallback: true, url: "https://example.com" },
			undefined,
			() => {}
		);
		const text = result.content[0];
		const details = result.details as {
			backend?: string;
			fallbackCommand?: string;
			fallbackUsed?: boolean;
			source?: string;
		};

		expect(text?.type).toBe("text");
		expect(text?.type === "text" ? text.text : "").toContain("# Clean page");
		expect(details.backend).toBe("dendrite-scraper");
		expect(details.fallbackCommand).toBe("dendrite-scraper");
		expect(details.fallbackUsed).toBe(true);
		expect(details.source).toBe("jina");
		expect(execCalls).toEqual(["dendrite-scraper scrape --timeout 45 https://example.com"]);
	});

	test("falls back to uvx when the binary is unavailable and fallback is enabled", async () => {
		const harness = ExtensionHarness.create();
		const execCalls: string[] = [];
		(harness.api as { exec: typeof harness.api.exec }).exec = async (command, args) => {
			execCalls.push([command, ...args].join(" "));
			if (command === "dendrite-scraper") {
				throw new Error("spawn dendrite-scraper ENOENT");
			}
			return {
				code: 0,
				killed: false,
				stderr: "",
				stdout: JSON.stringify({
					markdown: "# Clean via uvx",
					ok: true,
					source: "crawl4ai",
					url: "https://example.com",
				}),
			};
		};

		globalThis.fetch = async () => {
			throw new Error("getaddrinfo ENOTFOUND example.com");
		};

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const result = await tool.execute(
			"tc-1",
			{ allowPackageFallback: true, url: "https://example.com" },
			undefined,
			() => {}
		);
		const text = result.content[0];
		const details = result.details as {
			fallbackCommand?: string;
			fallbackUsed?: boolean;
			source?: string;
		};

		expect(text?.type).toBe("text");
		expect(text?.type === "text" ? text.text : "").toContain("# Clean via uvx");
		expect(details.fallbackCommand).toBe("uvx --from dendrite-scraper dendrite-scraper");
		expect(details.fallbackUsed).toBe(true);
		expect(details.source).toBe("crawl4ai");
		expect(execCalls).toEqual([
			"dendrite-scraper scrape --timeout 45 https://example.com",
			"uvx --from dendrite-scraper dendrite-scraper scrape --timeout 45 https://example.com",
		]);
	});
});
