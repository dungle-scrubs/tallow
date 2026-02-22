import { describe, expect, test } from "bun:test";
import {
	applyToolResultRetentionToMessages,
	resolveToolResultRetentionPolicy,
	TOOL_RESULT_RETENTION_MARKER,
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
