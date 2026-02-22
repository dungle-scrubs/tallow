import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import readSummary from "../index.js";

/**
 * Build a small notebook fixture for end-to-end read-tool execution.
 *
 * @returns Serialized notebook JSON string
 */
function createNotebookFixture(): string {
	return JSON.stringify({
		metadata: {
			kernelspec: {
				language: "python",
			},
		},
		cells: [
			{
				cell_type: "markdown",
				source: ["# Header\n", "Notebook body\n"],
			},
			{
				cell_type: "code",
				execution_count: 1,
				source: ["print('ok')\n"],
				outputs: [
					{
						output_type: "stream",
						name: "stdout",
						text: ["ok\n"],
					},
				],
			},
		],
	});
}

/**
 * Build a minimal extension context stub for tool execution.
 *
 * @param cwd - Working directory for tool execution
 * @returns Partial context cast to ExtensionContext
 */
function stubContext(cwd: string): ExtensionContext {
	return {
		hasUI: false,
		ui: { setWorkingMessage() {} },
		cwd,
	} as unknown as ExtensionContext;
}

let notebookPath: string;
let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-read-test-"));
	notebookPath = path.join(tmpDir, "sample.ipynb");
	fs.writeFileSync(notebookPath, createNotebookFixture(), "utf-8");
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("read tool notebook integration", () => {
	test("reads notebook with summarized result and full text details", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(readSummary);

		const tool = harness.tools.get("read");
		expect(tool).toBeDefined();
		if (!tool) return;

		const updates: Array<{ details?: Record<string, unknown> }> = [];
		const result = await tool.execute(
			"test-id",
			{ path: notebookPath },
			new AbortController().signal,
			(partial) => {
				updates.push(partial as { details?: Record<string, unknown> });
			},
			stubContext(tmpDir)
		);

		const summary = result.content[0]?.type === "text" ? result.content[0].text : "";
		const details = result.details as Record<string, unknown>;

		expect(summary).toContain("sample.ipynb (2 cells");
		expect(details.__notebook_read__).toBe(true);
		expect(details._cellCount).toBe(2);
		expect(typeof details._fullText).toBe("string");
		expect(String(details._fullText)).toContain("Cell 1 [markdown]");
		expect(String(details._fullText)).toContain("```python");
		expect(updates.some((update) => Boolean(update.details?._preview))).toBe(true);
	});
});
