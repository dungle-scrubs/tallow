import { describe, expect, it } from "bun:test";
import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import { formatContextUsageDisplay } from "../context-display.js";

describe("formatContextUsageDisplay", () => {
	it("formats known context usage as a percentage", () => {
		const usage: ContextUsage = { contextWindow: 272_000, percent: 27.5625, tokens: 74_967 };
		const result = formatContextUsageDisplay(usage, 0, true);

		expect(result.percent).toBeCloseTo(27.56139705882353);
		expect(result.text).toBe("27.6%/272k (auto)");
	});

	it("preserves unknown usage after compaction", () => {
		const usage: ContextUsage = { contextWindow: 272_000, percent: null, tokens: null };

		expect(formatContextUsageDisplay(usage, 0, true)).toEqual({
			percent: null,
			text: "?/272k (auto)",
		});
	});

	it("falls back to the model context window when usage is unavailable", () => {
		expect(formatContextUsageDisplay(undefined, 1_000_000, true)).toEqual({
			percent: 0,
			text: "0.0%/1.0M (auto)",
		});
	});
});
