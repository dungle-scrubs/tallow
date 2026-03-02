import { describe, expect, test } from "bun:test";
import {
	type ContextBudgetEnvelopeMetadata,
	cleanupStaleEnvelopes,
	ENVELOPE_DEFAULT_TTL_MS,
	isEnvelopeStale,
	isEnvelopeTurnValid,
	type StoredEnvelope,
} from "../../extensions/_shared/context-budget-interop.js";
import {
	applyToolResultRetentionToMessages,
	estimateRemainingTokens,
	formatBudgetStatusLine,
	resolveContextBudgetPolicy,
	resolveToolResultRetentionPolicy,
	TOOL_RESULT_BUDGET_GUARD_MARKER,
	TOOL_RESULT_RETENTION_MARKER,
	tokensToBytes,
	unknownUsageFallbackBudget,
} from "../sdk.js";

/**
 * Build a toolResult-like message with deterministic payload size.
 *
 * @param id - Tool call identifier
 * @param textSize - Number of characters in the text payload
 * @param toolName - Tool name for the message
 * @returns Mutable message object for retention tests
 */
function createToolResultMessage(
	id: string,
	textSize: number,
	toolName = "bash"
): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text: "x".repeat(textSize) }],
		details: { payload: "y".repeat(Math.floor(textSize / 2)) },
		isError: false,
		timestamp: Date.now(),
	};
}

// ─── Tool Result Retention Policy ────────────────────────────────────────────

describe("resolveToolResultRetentionPolicy", () => {
	test("returns conservative defaults when no settings are provided", () => {
		const policy = resolveToolResultRetentionPolicy({});
		expect(policy.enabled).toBe(true);
		expect(policy.keepRecentToolResults).toBe(12);
		expect(policy.maxRetainedBytesPerResult).toBe(48 * 1024);
		expect(policy.previewChars).toBe(600);
	});

	test("applies precedence runtime > project > global", () => {
		const policy = resolveToolResultRetentionPolicy({
			globalSettings: {
				toolResultRetention: {
					enabled: false,
					keepRecentToolResults: 3,
					maxRetainedBytesPerResult: 1_024,
					previewChars: 80,
				},
			},
			projectSettings: {
				toolResultRetention: {
					keepRecentToolResults: 6,
				},
			},
			runtimeSettings: {
				toolResultRetention: {
					enabled: true,
					previewChars: 120,
				},
			},
		});

		expect(policy.enabled).toBe(true);
		expect(policy.keepRecentToolResults).toBe(6);
		expect(policy.maxRetainedBytesPerResult).toBe(1_024);
		expect(policy.previewChars).toBe(120);
	});
});

describe("applyToolResultRetentionToMessages", () => {
	test("summarizes only oversized historical tool results outside keep-recent window", () => {
		const firstLarge = createToolResultMessage("tc_1", 4_096);
		const secondSmall = createToolResultMessage("tc_2", 64);
		const newestLarge = createToolResultMessage("tc_3", 4_096);

		const messages: Array<Record<string, unknown>> = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			firstLarge,
			secondSmall,
			newestLarge,
		];

		const stats = applyToolResultRetentionToMessages(messages, {
			enabled: true,
			keepRecentToolResults: 1,
			maxRetainedBytesPerResult: 512,
			previewChars: 120,
		});

		expect(stats.examinedCount).toBe(3);
		expect(stats.summarizedCount).toBe(1);
		expect(stats.summarizedBytes).toBeGreaterThan(512);

		const summarizedContent = firstLarge.content as Array<{ text?: string; type: string }>;
		expect(summarizedContent[0]?.type).toBe("text");
		expect(summarizedContent[0]?.text).toContain("summarized historical tool result");

		const summarizedDetails = firstLarge.details as Record<string, unknown>;
		expect(summarizedDetails[TOOL_RESULT_RETENTION_MARKER]).toBe(true);

		const newestContent = newestLarge.content as Array<{ text?: string; type: string }>;
		expect(newestContent[0]?.text).toBe("x".repeat(4_096));
	});

	test("does not re-summarize entries already summarized by retention", () => {
		const toolResult = createToolResultMessage("tc_4", 4_096);
		const messages = [toolResult];
		const policy = {
			enabled: true,
			keepRecentToolResults: 0,
			maxRetainedBytesPerResult: 512,
			previewChars: 80,
		};

		const first = applyToolResultRetentionToMessages(messages, policy);
		const second = applyToolResultRetentionToMessages(messages, policy);

		expect(first.summarizedCount).toBe(1);
		expect(second.summarizedCount).toBe(0);
	});
});

// ─── Context Budget Policy ───────────────────────────────────────────────────

describe("resolveContextBudgetPolicy", () => {
	test("returns defaults when no settings are provided", () => {
		const policy = resolveContextBudgetPolicy({});
		expect(policy.softThresholdPercent).toBe(75);
		expect(policy.hardThresholdPercent).toBe(90);
		expect(policy.minPerToolBytes).toBe(4 * 1024);
		expect(policy.maxPerToolBytes).toBe(512 * 1024);
		expect(policy.perTurnReserveTokens).toBe(8_000);
		expect(policy.unknownUsageFallbackCapBytes).toBe(32 * 1024);
	});

	test("applies precedence runtime > project > global", () => {
		const policy = resolveContextBudgetPolicy({
			globalSettings: {
				contextBudget: {
					softThresholdPercent: 60,
					hardThresholdPercent: 85,
					minPerToolBytes: 2048,
					maxPerToolBytes: 100_000,
					perTurnReserveTokens: 4000,
					unknownUsageFallbackCapBytes: 16_384,
				},
			},
			projectSettings: {
				contextBudget: {
					hardThresholdPercent: 80,
					minPerToolBytes: 8192,
				},
			},
			runtimeSettings: {
				contextBudget: {
					softThresholdPercent: 70,
				},
			},
		});

		expect(policy.softThresholdPercent).toBe(70); // runtime wins
		expect(policy.hardThresholdPercent).toBe(80); // project wins over global
		expect(policy.minPerToolBytes).toBe(8192); // project wins over global
		expect(policy.maxPerToolBytes).toBe(100_000); // global (no override)
		expect(policy.perTurnReserveTokens).toBe(4000); // global (no override)
		expect(policy.unknownUsageFallbackCapBytes).toBe(16_384); // global (no override)
	});

	test("clamps negative values to 0", () => {
		const policy = resolveContextBudgetPolicy({
			runtimeSettings: {
				contextBudget: {
					softThresholdPercent: -10,
					minPerToolBytes: -500,
				},
			},
		});

		expect(policy.softThresholdPercent).toBe(0);
		expect(policy.minPerToolBytes).toBe(0);
	});

	test("clamps percentage fields to 100", () => {
		const policy = resolveContextBudgetPolicy({
			runtimeSettings: {
				contextBudget: {
					softThresholdPercent: 200,
					hardThresholdPercent: 150,
				},
			},
		});

		expect(policy.softThresholdPercent).toBe(100);
		expect(policy.hardThresholdPercent).toBe(100);
	});

	test("ignores non-numeric values and falls back to defaults", () => {
		const policy = resolveContextBudgetPolicy({
			runtimeSettings: {
				contextBudget: {
					softThresholdPercent: "high",
					minPerToolBytes: null,
					perTurnReserveTokens: NaN,
				},
			},
		});

		expect(policy.softThresholdPercent).toBe(75); // default
		expect(policy.minPerToolBytes).toBe(4 * 1024); // default
		expect(policy.perTurnReserveTokens).toBe(8_000); // default
	});

	test("ignores non-object contextBudget values", () => {
		const policy = resolveContextBudgetPolicy({
			globalSettings: { contextBudget: "invalid" },
			projectSettings: { contextBudget: 42 },
			runtimeSettings: { contextBudget: null },
		});

		// All should be defaults
		expect(policy.softThresholdPercent).toBe(75);
		expect(policy.hardThresholdPercent).toBe(90);
	});
});

// ─── Pure Helpers ────────────────────────────────────────────────────────────

describe("estimateRemainingTokens", () => {
	test("returns remaining tokens minus reserve", () => {
		const result = estimateRemainingTokens(
			{ tokens: 50_000, contextWindow: 200_000, percent: 25 },
			8_000
		);
		expect(result).toBe(142_000); // 200000 - 50000 - 8000
	});

	test("returns 0 when tokens is null (unknown usage)", () => {
		const result = estimateRemainingTokens(
			{ tokens: null, contextWindow: 200_000, percent: null },
			8_000
		);
		expect(result).toBe(0);
	});

	test("clamps to 0 when usage exceeds window", () => {
		const result = estimateRemainingTokens(
			{ tokens: 210_000, contextWindow: 200_000, percent: 105 },
			8_000
		);
		expect(result).toBe(0);
	});

	test("clamps to 0 when reserve alone exceeds remaining", () => {
		const result = estimateRemainingTokens(
			{ tokens: 195_000, contextWindow: 200_000, percent: 97 },
			8_000
		);
		expect(result).toBe(0);
	});
});

describe("tokensToBytes", () => {
	test("converts tokens to bytes at 4x ratio", () => {
		expect(tokensToBytes(1_000)).toBe(4_000);
		expect(tokensToBytes(0)).toBe(0);
	});

	test("returns 0 for negative input", () => {
		expect(tokensToBytes(-100)).toBe(0);
	});

	test("floors fractional results", () => {
		expect(tokensToBytes(1)).toBe(4);
		expect(tokensToBytes(0.5)).toBe(2);
	});
});

describe("formatBudgetStatusLine", () => {
	test("formats known usage with percentage and remaining tokens", () => {
		const line = formatBudgetStatusLine(
			{ tokens: 90_000, contextWindow: 200_000, percent: 45 },
			resolveContextBudgetPolicy({})
		);
		expect(line).toContain("Context budget: 45% used");
		expect(line).toContain("~102k tokens remaining");
	});

	test("formats unknown usage with deterministic fallback line", () => {
		const line = formatBudgetStatusLine(
			{ tokens: null, contextWindow: 200_000, percent: null },
			resolveContextBudgetPolicy({})
		);
		expect(line).toBe("Context budget: unknown (waiting for fresh usage sample)");
	});

	test("is deterministic for same inputs", () => {
		const usage = { tokens: 100_000, contextWindow: 200_000, percent: 50 };
		const policy = resolveContextBudgetPolicy({});
		const a = formatBudgetStatusLine(usage, policy);
		const b = formatBudgetStatusLine(usage, policy);
		expect(a).toBe(b);
	});

	test("unknown usage line is deterministic", () => {
		const usage = { tokens: null, contextWindow: 200_000, percent: null };
		const policy = resolveContextBudgetPolicy({});
		const a = formatBudgetStatusLine(usage, policy);
		const b = formatBudgetStatusLine(usage, policy);
		expect(a).toBe(b);
	});
});

describe("unknownUsageFallbackBudget", () => {
	test("returns the policy fallback cap", () => {
		const policy = resolveContextBudgetPolicy({});
		expect(unknownUsageFallbackBudget(policy)).toBe(32 * 1024);
	});

	test("respects overridden fallback cap", () => {
		const policy = resolveContextBudgetPolicy({
			runtimeSettings: {
				contextBudget: { unknownUsageFallbackCapBytes: 65_536 },
			},
		});
		expect(unknownUsageFallbackBudget(policy)).toBe(65_536);
	});
});

// ─── Compatibility Invariants ────────────────────────────────────────────────

describe("compatibility invariants", () => {
	test("retention never changes toolCallId, toolName, or isError", () => {
		const msg = createToolResultMessage("tc_compat_1", 8_192, "web_fetch");
		(msg as { isError: boolean }).isError = true;

		const messages = [msg];
		applyToolResultRetentionToMessages(messages, {
			enabled: true,
			keepRecentToolResults: 0,
			maxRetainedBytesPerResult: 512,
			previewChars: 80,
		});

		expect(msg.toolCallId).toBe("tc_compat_1");
		expect(msg.toolName).toBe("web_fetch");
		expect(msg.isError).toBe(true);
	});

	test("retention preserves role as toolResult", () => {
		const msg = createToolResultMessage("tc_compat_2", 8_192);
		applyToolResultRetentionToMessages([msg], {
			enabled: true,
			keepRecentToolResults: 0,
			maxRetainedBytesPerResult: 512,
			previewChars: 80,
		});

		expect(msg.role).toBe("toolResult");
	});

	test("summarized details include retention marker and byte counts", () => {
		const msg = createToolResultMessage("tc_compat_3", 8_192);
		applyToolResultRetentionToMessages([msg], {
			enabled: true,
			keepRecentToolResults: 0,
			maxRetainedBytesPerResult: 512,
			previewChars: 80,
		});

		const details = msg.details as Record<string, unknown>;
		expect(details[TOOL_RESULT_RETENTION_MARKER]).toBe(true);
		expect(typeof details.originalBytes).toBe("number");
		expect(typeof details.contentBytes).toBe("number");
		expect(typeof details.detailsBytes).toBe("number");
		expect(typeof details.summarizedAt).toBe("string");
	});
});

// ─── Non-text Content Handling ───────────────────────────────────────────────

describe("non-text content handling", () => {
	test("retention handles image content blocks without crashing", () => {
		const msg: Record<string, unknown> = {
			role: "toolResult",
			toolCallId: "tc_img_1",
			toolName: "read",
			content: [{ type: "image", data: "base64data".repeat(500), mimeType: "image/png" }],
			details: undefined,
			isError: false,
			timestamp: Date.now(),
		};

		const stats = applyToolResultRetentionToMessages([msg], {
			enabled: true,
			keepRecentToolResults: 0,
			maxRetainedBytesPerResult: 512,
			previewChars: 80,
		});

		// Image data is large enough to trigger summarization
		expect(stats.summarizedCount).toBe(1);
		const content = msg.content as Array<{ type: string; text?: string }>;
		expect(content[0]?.text).toContain("Image output omitted");
	});

	test("retention handles mixed text and image blocks", () => {
		const msg: Record<string, unknown> = {
			role: "toolResult",
			toolCallId: "tc_mixed_1",
			toolName: "read",
			content: [
				{ type: "text", text: "a".repeat(2_000) },
				{ type: "image", data: "base64data".repeat(500), mimeType: "image/png" },
			],
			details: undefined,
			isError: false,
			timestamp: Date.now(),
		};

		const stats = applyToolResultRetentionToMessages([msg], {
			enabled: true,
			keepRecentToolResults: 0,
			maxRetainedBytesPerResult: 256,
			previewChars: 40,
		});

		expect(stats.summarizedCount).toBe(1);
		const content = msg.content as Array<{ type: string; text?: string }>;
		// After summarization, content is replaced with a single text summary
		expect(content).toHaveLength(1);
		expect(content[0]?.type).toBe("text");
	});

	test("empty content array does not crash", () => {
		const msg: Record<string, unknown> = {
			role: "toolResult",
			toolCallId: "tc_empty_1",
			toolName: "bash",
			content: [],
			details: undefined,
			isError: false,
			timestamp: Date.now(),
		};

		// Empty content = 0 bytes, under any threshold
		const stats = applyToolResultRetentionToMessages([msg], {
			enabled: true,
			keepRecentToolResults: 0,
			maxRetainedBytesPerResult: 0,
			previewChars: 80,
		});

		// 0 bytes is <= 0 threshold, so no summarization
		expect(stats.summarizedCount).toBe(0);
	});
});

// ─── Envelope Lifecycle ──────────────────────────────────────────────────────

describe("envelope lifecycle helpers", () => {
	test("isEnvelopeStale returns false within TTL", () => {
		const meta: ContextBudgetEnvelopeMetadata = {
			createdAtMs: 1000,
			turnIndex: 0,
			ttlMs: 30_000,
		};
		expect(isEnvelopeStale(meta, 1000)).toBe(false);
		expect(isEnvelopeStale(meta, 30_999)).toBe(false);
	});

	test("isEnvelopeStale returns true after TTL", () => {
		const meta: ContextBudgetEnvelopeMetadata = {
			createdAtMs: 1000,
			turnIndex: 0,
			ttlMs: 30_000,
		};
		expect(isEnvelopeStale(meta, 31_001)).toBe(true);
		expect(isEnvelopeStale(meta, 100_000)).toBe(true);
	});

	test("isEnvelopeTurnValid matches current turn", () => {
		const meta: ContextBudgetEnvelopeMetadata = {
			createdAtMs: 1000,
			turnIndex: 5,
			ttlMs: 30_000,
		};
		expect(isEnvelopeTurnValid(meta, 5)).toBe(true);
		expect(isEnvelopeTurnValid(meta, 4)).toBe(false);
		expect(isEnvelopeTurnValid(meta, 6)).toBe(false);
	});

	test("cleanupStaleEnvelopes removes expired entries", () => {
		const store = new Map<string, StoredEnvelope>();

		store.set("fresh", {
			envelope: { maxBytes: 1024, batchSize: 1 },
			metadata: { createdAtMs: 1000, turnIndex: 3, ttlMs: 30_000 },
		});

		store.set("stale-time", {
			envelope: { maxBytes: 1024, batchSize: 1 },
			metadata: { createdAtMs: 1000, turnIndex: 3, ttlMs: 5_000 },
		});

		store.set("stale-turn", {
			envelope: { maxBytes: 1024, batchSize: 1 },
			metadata: { createdAtMs: 1000, turnIndex: 1, ttlMs: 30_000 },
		});

		const removed = cleanupStaleEnvelopes(store, 10_000, 3);
		expect(removed).toBe(2);
		expect(store.size).toBe(1);
		expect(store.has("fresh")).toBe(true);
		expect(store.has("stale-time")).toBe(false);
		expect(store.has("stale-turn")).toBe(false);
	});

	test("cleanupStaleEnvelopes handles empty store", () => {
		const store = new Map<string, StoredEnvelope>();
		const removed = cleanupStaleEnvelopes(store, Date.now(), 0);
		expect(removed).toBe(0);
	});

	test("cleanupStaleEnvelopes keeps all entries when none are stale", () => {
		const store = new Map<string, StoredEnvelope>();
		const nowMs = 5000;

		store.set("a", {
			envelope: { maxBytes: 1024, batchSize: 2 },
			metadata: { createdAtMs: 4000, turnIndex: 0, ttlMs: 30_000 },
		});

		store.set("b", {
			envelope: { maxBytes: 2048, batchSize: 2 },
			metadata: { createdAtMs: 4500, turnIndex: 0, ttlMs: 30_000 },
		});

		const removed = cleanupStaleEnvelopes(store, nowMs, 0);
		expect(removed).toBe(0);
		expect(store.size).toBe(2);
	});

	test("ENVELOPE_DEFAULT_TTL_MS is 30 seconds", () => {
		expect(ENVELOPE_DEFAULT_TTL_MS).toBe(30_000);
	});
});

// ─── Budget Guard Marker ─────────────────────────────────────────────────────

describe("budget guard marker constant", () => {
	test("TOOL_RESULT_BUDGET_GUARD_MARKER is a namespaced string", () => {
		expect(TOOL_RESULT_BUDGET_GUARD_MARKER).toBe("__tallow_budget_guard__");
		expect(typeof TOOL_RESULT_BUDGET_GUARD_MARKER).toBe("string");
	});

	test("budget guard marker is different from retention marker", () => {
		expect(TOOL_RESULT_BUDGET_GUARD_MARKER).not.toBe(TOOL_RESULT_RETENTION_MARKER);
	});
});
