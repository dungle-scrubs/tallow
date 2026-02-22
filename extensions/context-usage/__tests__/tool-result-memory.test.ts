import { describe, expect, test } from "bun:test";
import { computeToolResultMemoryStats } from "../index.js";

const RETENTION_MARKER = "__tallow_summarized_tool_result__";

/**
 * Build a branch entry with a toolResult message payload.
 *
 * @param id - Tool call id
 * @param text - Text payload
 * @param details - Optional details payload
 * @returns Session branch entry-like object
 */
function toolResultEntry(
	id: string,
	text: string,
	details?: Record<string, unknown>
): { message: Record<string, unknown>; type: string } {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text }],
			details,
			isError: false,
			timestamp: Date.now(),
		},
	};
}

describe("computeToolResultMemoryStats", () => {
	test("returns zero stats for empty branches", () => {
		const stats = computeToolResultMemoryStats([]);
		expect(stats.totalResults).toBe(0);
		expect(stats.summarizedResults).toBe(0);
		expect(stats.retainedBytes).toBe(0);
		expect(stats.reclaimedBytes).toBe(0);
	});

	test("counts retained and reclaimed bytes for summarized historical results", () => {
		const summarized = toolResultEntry("tc_1", "short summary", {
			[RETENTION_MARKER]: true,
			originalBytes: 20_000,
		});
		const full = toolResultEntry("tc_2", "x".repeat(2_000), { foo: "bar" });
		const nonToolMessage = {
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
			},
		};

		const stats = computeToolResultMemoryStats([summarized, full, nonToolMessage]);
		expect(stats.totalResults).toBe(2);
		expect(stats.summarizedResults).toBe(1);
		expect(stats.retainedBytes).toBeGreaterThan(0);
		expect(stats.reclaimedBytes).toBeGreaterThan(0);
	});
});
