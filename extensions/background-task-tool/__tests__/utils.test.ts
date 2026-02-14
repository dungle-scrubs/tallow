/**
 * Tests for background-task-tool pure utility functions:
 * formatDuration and truncateCommand.
 */
import { describe, expect, it } from "bun:test";
import { formatDuration, truncateCommand } from "../index.js";

// ── formatDuration ───────────────────────────────────────────────────────────

describe("formatDuration", () => {
	it("formats zero as 0s", () => {
		expect(formatDuration(0)).toBe("0s");
	});

	it("formats sub-minute durations in seconds", () => {
		expect(formatDuration(5000)).toBe("5s");
		expect(formatDuration(59_000)).toBe("59s");
	});

	it("formats minutes with remaining seconds", () => {
		expect(formatDuration(90_000)).toBe("1m 30s");
		expect(formatDuration(120_000)).toBe("2m 0s");
	});

	it("formats hours with remaining minutes", () => {
		expect(formatDuration(3_600_000)).toBe("1h 0m");
		expect(formatDuration(3_900_000)).toBe("1h 5m");
		expect(formatDuration(7_530_000)).toBe("2h 5m");
	});

	it("truncates sub-second values to 0s", () => {
		expect(formatDuration(999)).toBe("0s");
	});
});

// ── truncateCommand ──────────────────────────────────────────────────────────

describe("truncateCommand", () => {
	it("returns short commands unchanged", () => {
		expect(truncateCommand("ls -la")).toBe("ls -la");
	});

	it("truncates at default maxLen of 40", () => {
		const longCmd = "a".repeat(50);
		const result = truncateCommand(longCmd);
		expect(result).toHaveLength(40);
		expect(result.endsWith("...")).toBe(true);
	});

	it("truncates at custom maxLen", () => {
		const result = truncateCommand("npm run build:production:all", 20);
		expect(result).toHaveLength(20);
		expect(result.endsWith("...")).toBe(true);
	});

	it("returns exact-length commands unchanged", () => {
		const exact = "a".repeat(40);
		expect(truncateCommand(exact)).toBe(exact);
	});

	it("handles empty string", () => {
		expect(truncateCommand("")).toBe("");
	});
});
