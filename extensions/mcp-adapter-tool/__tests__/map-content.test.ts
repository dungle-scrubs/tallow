import { describe, expect, test } from "bun:test";
import { type McpContentItem, mapContent } from "../index.js";

describe("mapContent", () => {
	test("maps text content unchanged", () => {
		const items: McpContentItem[] = [{ type: "text", text: "hello world" }];
		expect(mapContent(items)).toEqual([{ type: "text", text: "hello world" }]);
	});

	test("maps image content with data and mimeType", () => {
		const items: McpContentItem[] = [{ type: "image", data: "base64data", mimeType: "image/png" }];
		expect(mapContent(items)).toEqual([
			{ type: "image", data: "base64data", mimeType: "image/png" },
		]);
	});

	test("maps resource content with URI", () => {
		const items: McpContentItem[] = [
			{ type: "resource", resource: { uri: "file:///tmp/data.json" } },
		];
		const result = mapContent(items);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("text");
		expect((result[0] as { text: string }).text).toContain("file:///tmp/data.json");
	});

	test("maps resource with mimeType and inline text", () => {
		const items: McpContentItem[] = [
			{
				type: "resource",
				resource: {
					uri: "file:///data.csv",
					mimeType: "text/csv",
					text: "a,b,c\n1,2,3",
				},
			},
		];
		const result = mapContent(items);
		const text = (result[0] as { text: string }).text;
		expect(text).toContain("file:///data.csv");
		expect(text).toContain("text/csv");
		expect(text).toContain("a,b,c\n1,2,3");
	});

	test("appends annotations to text content", () => {
		const items: McpContentItem[] = [
			{ type: "text", text: "result", annotations: { priority: "high", source: "api" } },
		];
		const result = mapContent(items);
		const text = (result[0] as { text: string }).text;
		expect(text).toContain("result");
		expect(text).toContain("Annotations:");
		expect(text).toContain("priority");
	});

	test("handles unknown content types as labeled JSON", () => {
		const items: McpContentItem[] = [
			{ type: "custom_widget", text: "widget data" } as McpContentItem,
		];
		const result = mapContent(items);
		const text = (result[0] as { text: string }).text;
		expect(text).toContain("[custom_widget]");
	});

	test("maps mixed content array correctly", () => {
		const items: McpContentItem[] = [
			{ type: "text", text: "intro" },
			{ type: "resource", resource: { uri: "file:///doc.md" } },
			{ type: "image", data: "abc", mimeType: "image/jpeg" },
		];
		const result = mapContent(items);
		expect(result).toHaveLength(3);
		expect(result[0].type).toBe("text");
		expect(result[1].type).toBe("text");
		expect(result[2].type).toBe("image");
	});

	test("handles empty items array", () => {
		expect(mapContent([])).toEqual([]);
	});

	test("handles null/undefined text gracefully", () => {
		const items: McpContentItem[] = [{ type: "text" }];
		const result = mapContent(items);
		// Falls through to unknown type handler since text is undefined
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("text");
	});

	test("handles resource without resource field as unknown type", () => {
		const items: McpContentItem[] = [{ type: "resource" }];
		const result = mapContent(items);
		expect(result).toHaveLength(1);
		expect((result[0] as { text: string }).text).toContain("[resource]");
	});

	test("skips empty annotations", () => {
		const items: McpContentItem[] = [{ type: "text", text: "clean", annotations: {} }];
		const result = mapContent(items);
		expect((result[0] as { text: string }).text).toBe("clean");
	});

	// ── resource_link tests ──────────────────────────────────────────────

	test("maps resource_link with URI", () => {
		const items: McpContentItem[] = [{ type: "resource_link", uri: "file:///tmp/data.csv" }];
		const result = mapContent(items);
		expect(result).toHaveLength(1);
		expect((result[0] as { text: string }).text).toBe("[Resource: file:///tmp/data.csv]");
	});

	test("maps resource_link with mimeType", () => {
		const items: McpContentItem[] = [
			{ type: "resource_link", uri: "https://api.example.com/users", mimeType: "application/json" },
		];
		const text = (mapContent(items)[0] as { text: string }).text;
		expect(text).toBe("[Resource (application/json): https://api.example.com/users]");
	});

	test("maps resource_link with description", () => {
		const items: McpContentItem[] = [
			{ type: "resource_link", uri: "file:///logs/app.log", description: "Application logs" },
		];
		const text = (mapContent(items)[0] as { text: string }).text;
		expect(text).toContain("file:///logs/app.log");
		expect(text).toContain("Application logs");
	});

	test("maps resource_link with mimeType and description", () => {
		const items: McpContentItem[] = [
			{
				type: "resource_link",
				uri: "s3://bucket/report.pdf",
				mimeType: "application/pdf",
				description: "Monthly report",
			},
		];
		const text = (mapContent(items)[0] as { text: string }).text;
		expect(text).toBe("[Resource (application/pdf): s3://bucket/report.pdf] — Monthly report");
	});

	test("handles resource_link with missing URI", () => {
		const items: McpContentItem[] = [{ type: "resource_link" }];
		const text = (mapContent(items)[0] as { text: string }).text;
		expect(text).toContain("unknown");
	});

	test("maps multiple resource_links in one result", () => {
		const items: McpContentItem[] = [
			{ type: "resource_link", uri: "file:///a.txt" },
			{ type: "resource_link", uri: "file:///b.txt" },
		];
		const result = mapContent(items);
		expect(result).toHaveLength(2);
		expect((result[0] as { text: string }).text).toContain("a.txt");
		expect((result[1] as { text: string }).text).toContain("b.txt");
	});
});
