import { describe, expect, it } from "bun:test";

/**
 * isToolDenialEvent — extracted from subagent/index.ts for testability.
 *
 * Checks if a tool_result_end event message indicates a permission denial
 * rather than a regular tool execution failure.
 */

const DENIAL_PATTERNS = [
	"permission denied",
	"tool denied",
	"user declined",
	"denied by user",
	"user rejected",
	"request denied",
];

function isToolDenialEvent(eventMessage: Record<string, unknown>): boolean {
	if (!eventMessage.isError) return false;

	// Explicit denial flag (forward-compatible with pi framework changes)
	if (eventMessage.isDenied === true) return true;

	// Pattern-match content array for denial indicators
	const content = eventMessage.content;
	if (Array.isArray(content)) {
		const text = content
			.filter((p: Record<string, unknown>) => p.type === "text")
			.map((p: Record<string, unknown>) => p.text as string)
			.join(" ")
			.toLowerCase();
		return DENIAL_PATTERNS.some((p) => text.includes(p));
	}

	return false;
}

describe("isToolDenialEvent", () => {
	it("returns false when isError is false", () => {
		expect(
			isToolDenialEvent({
				isError: false,
				content: [{ type: "text", text: "permission denied" }],
			})
		).toBe(false);
	});

	it("returns false when isError is undefined", () => {
		expect(
			isToolDenialEvent({
				content: [{ type: "text", text: "permission denied" }],
			})
		).toBe(false);
	});

	it("detects explicit isDenied flag", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				isDenied: true,
				content: [],
			})
		).toBe(true);
	});

	it("detects 'permission denied' in content", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "text", text: "Error: Permission denied for this operation" }],
			})
		).toBe(true);
	});

	it("detects 'tool denied' in content", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "text", text: "Tool denied by security policy" }],
			})
		).toBe(true);
	});

	it("detects 'user declined' in content", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "text", text: "The user declined this tool call" }],
			})
		).toBe(true);
	});

	it("detects 'denied by user' in content", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "text", text: "Operation was denied by user" }],
			})
		).toBe(true);
	});

	it("detects 'user rejected' in content", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "text", text: "User rejected the bash command" }],
			})
		).toBe(true);
	});

	it("detects 'request denied' in content", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "text", text: "Request denied: insufficient permissions" }],
			})
		).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "text", text: "PERMISSION DENIED" }],
			})
		).toBe(true);
	});

	it("matches across multiple content parts", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [
					{ type: "text", text: "Error occurred." },
					{ type: "text", text: "Tool denied." },
				],
			})
		).toBe(true);
	});

	it("returns false for regular tool errors", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "text", text: "Command failed with exit code 1" }],
			})
		).toBe(false);
	});

	it("returns false for empty content array", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [],
			})
		).toBe(false);
	});

	it("returns false when content is not an array", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: "not an array",
			})
		).toBe(false);
	});

	it("returns false when content is missing", () => {
		expect(
			isToolDenialEvent({
				isError: true,
			})
		).toBe(false);
	});

	it("ignores non-text content parts", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "image", url: "permission denied" }],
			})
		).toBe(false);
	});

	it("does not match partial words (e.g., 'denied' in unrelated context)", () => {
		// "permission denied" is a full pattern, but "denied" alone is not a pattern
		// The word "denied" only matches as part of "permission denied", "tool denied", etc.
		expect(
			isToolDenialEvent({
				isError: true,
				content: [{ type: "text", text: "Access was denied to the file" }],
			})
		).toBe(false);
	});

	it("matches embedded patterns in longer strings", () => {
		expect(
			isToolDenialEvent({
				isError: true,
				content: [
					{
						type: "text",
						text: "Failed to execute: permission denied for bash command 'rm -rf /'",
					},
				],
			})
		).toBe(true);
	});
});
