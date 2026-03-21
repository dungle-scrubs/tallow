/**
 * Tests for the write-tool-enhanced extension.
 *
 * Verifies tool registration, execute output shape, summary formatting,
 * error propagation, and renderResult presentation variants.
 *
 * `createWriteTool` is mocked via `mock.module` so no real filesystem
 * writes occur.  The extension is dynamically imported after the mock
 * is registered so that its module-level `createWriteTool(process.cwd())`
 * call also receives the mock.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";

// ── Mock setup ────────────────────────────────────────────────────────────────

/**
 * Controllable execute mock — default returns a "wrote file" success result.
 * Use `.mockImplementationOnce()` in individual tests to simulate errors.
 */
const mockExecute = mock(async () => ({
	content: [{ type: "text", text: "wrote file" }],
}));

/**
 * Mock the entire `@mariozechner/pi-coding-agent` module so that
 * `createWriteTool` never touches the real filesystem.
 * The factory is evaluated once (on first import) to produce the module exports.
 */
mock.module("@mariozechner/pi-coding-agent", () => ({
	createWriteTool: (_cwd: string) => ({
		label: "Write file",
		description: "Write a new file at path, or overwrite an existing file.",
		parameters: {},
		execute: mockExecute,
	}),
}));

// Dynamically import the extension AFTER the mock is registered.
const { default: writePreview } = await import("../index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Theme stub with deterministic wrappers for assertions.
 *
 * @returns Fake Theme where fg/bold produce `<tag>text</tag>` strings
 */
function createMockTheme(): Theme {
	return {
		bold: (text: string) => `<b>${text}</b>`,
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	} as unknown as Theme;
}

/**
 * Build a minimal ExtensionContext stub for execute calls.
 *
 * @returns Partial context cast to ExtensionContext
 */
function stubContext(): ExtensionContext {
	return {
		hasUI: false,
		ui: { setWorkingMessage() {} },
		cwd: "/tmp/test-write",
	} as unknown as ExtensionContext;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("write-tool-enhanced", () => {
	// ── Registration ──────────────────────────────────────────────────────────

	describe("registration", () => {
		test("registers a tool with name 'write'", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			expect(harness.tools.has("write")).toBe(true);
		});
	});

	// ── Execute ───────────────────────────────────────────────────────────────

	describe("execute", () => {
		test("attaches __write_preview__ marker to details", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write");
			expect(tool).toBeDefined();
			if (!tool) return;

			const result = await tool.execute(
				"test-id",
				{ path: "src/foo.ts", content: "hello\nworld" },
				new AbortController().signal,
				() => {},
				stubContext()
			);

			const details = result.details as Record<string, unknown>;
			expect(details.__write_preview__).toBe(true);
		});

		test("stores written content in details._content", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write")!;
			const content = "const x = 1;\nconst y = 2;";

			const result = await tool.execute(
				"test-id",
				{ path: "src/bar.ts", content },
				new AbortController().signal,
				() => {},
				stubContext()
			);

			const details = result.details as Record<string, unknown>;
			expect(details._content).toBe(content);
		});

		test("summary reports correct line count", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write")!;
			const content = "line1\nline2\nline3"; // 3 lines

			const result = await tool.execute(
				"test-id",
				{ path: "src/three.ts", content },
				new AbortController().signal,
				() => {},
				stubContext()
			);

			const details = result.details as Record<string, unknown>;
			const summary = details._summary as string;
			expect(summary).toContain("3 lines");
		});

		test("summary reports correct KB size", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write")!;
			// 1200 chars → 1200/1024 ≈ 1.171875 → toFixed(1) = "1.2"
			const content = "a".repeat(1200);
			const expectedKb = (content.length / 1024).toFixed(1);

			const result = await tool.execute(
				"test-id",
				{ path: "big.txt", content },
				new AbortController().signal,
				() => {},
				stubContext()
			);

			const details = result.details as Record<string, unknown>;
			const summary = details._summary as string;
			expect(summary).toContain(`${expectedKb}KB`);
		});

		test("summary format is 'path (N lines, X.XKB)'", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write")!;
			const content = "hello\nworld"; // 2 lines, 11 chars

			const result = await tool.execute(
				"test-id",
				{ path: "out/hello.ts", content },
				new AbortController().signal,
				() => {},
				stubContext()
			);

			const details = result.details as Record<string, unknown>;
			const expectedSizeKb = (content.length / 1024).toFixed(1);
			expect(details._summary).toBe(`out/hello.ts (2 lines, ${expectedSizeKb}KB)`);
		});

		test("passes through content from base tool result", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write")!;

			const result = await tool.execute(
				"test-id",
				{ path: "out.txt", content: "data" },
				new AbortController().signal,
				() => {},
				stubContext()
			);

			expect(result.content).toEqual([{ type: "text", text: "wrote file" }]);
		});

		test("propagates error thrown by base tool", async () => {
			mockExecute.mockImplementationOnce(async () => {
				throw new Error("disk full");
			});

			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write")!;

			await expect(
				tool.execute(
					"test-id",
					{ path: "out.txt", content: "data" },
					new AbortController().signal,
					() => {},
					stubContext()
				)
			).rejects.toThrow("disk full");
		});
	});

	// ── renderResult ──────────────────────────────────────────────────────────

	describe("renderResult", () => {
		test("returns '...' placeholder for partial state", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write");
			expect(tool?.renderResult).toBeDefined();
			if (!tool?.renderResult) return;

			const component = tool.renderResult(
				{ content: [], details: {} } as never,
				{ isPartial: true, expanded: false },
				createMockTheme()
			);

			const rendered = component.render(200).join("\n");
			expect(rendered).toContain("...");
		});

		test("falls back to text content when __write_preview__ marker is absent", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write");
			if (!tool?.renderResult) return;

			const component = tool.renderResult(
				{
					content: [{ type: "text", text: "fallback output line" }],
					details: {}, // no __write_preview__
				} as never,
				{ isPartial: false, expanded: false },
				createMockTheme()
			);

			const rendered = component.render(200).join("\n");
			expect(rendered).toContain("fallback output line");
		});

		test("renders content body and success footer when preview marker is present", async () => {
			const harness = ExtensionHarness.create();
			await harness.loadExtension(writePreview);

			const tool = harness.tools.get("write");
			if (!tool?.renderResult) return;

			const component = tool.renderResult(
				{
					content: [{ type: "text", text: "wrote file" }],
					details: {
						__write_preview__: true,
						_content: "const answer = 42;",
						_summary: "src/answer.ts (1 lines, 0.0KB)",
					},
				} as never,
				{ isPartial: false, expanded: false },
				createMockTheme()
			);

			const rendered = component.render(200).join("\n");
			// Footer uses success semantic color
			expect(rendered).toContain("<success>");
			// Written content body appears in output
			expect(rendered).toContain("const answer = 42;");
		});
	});
});
