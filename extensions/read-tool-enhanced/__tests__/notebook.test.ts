import { describe, expect, test } from "bun:test";
import {
	formatNotebookOutput,
	isNotebook,
	NotebookParseError,
	parseNotebook,
	summarizeNotebookCounts,
} from "../notebook.js";

/**
 * Build a representative notebook fixture with markdown, code, and rich outputs.
 *
 * @returns Serialized notebook JSON string
 */
function createSampleNotebook(): string {
	return JSON.stringify({
		metadata: {
			kernelspec: {
				language: "python",
			},
		},
		cells: [
			{
				cell_type: "markdown",
				source: ["# Notebook title\n", "Some markdown context\n"],
			},
			{
				cell_type: "code",
				execution_count: 5,
				source: ["print('hello')\n"],
				outputs: [
					{
						output_type: "stream",
						name: "stdout",
						text: ["hello\n"],
					},
				],
			},
			{
				cell_type: "code",
				execution_count: 6,
				source: ["1 / 0\n"],
				outputs: [
					{
						output_type: "error",
						ename: "ZeroDivisionError",
						evalue: "division by zero",
						traceback: [
							"Traceback (most recent call last):",
							"ZeroDivisionError: division by zero",
						],
					},
				],
			},
			{
				cell_type: "code",
				execution_count: 7,
				source: ["plot()\n"],
				outputs: [
					{
						output_type: "display_data",
						data: {
							"image/png": "iVBORw0KGgoAAAANSUhEUgAA",
							"text/html": "<img src='plot.png' />",
						},
						metadata: {
							"image/png": {
								height: 600,
								width: 800,
							},
						},
					},
				],
			},
		],
	});
}

describe("isNotebook", () => {
	test("detects .ipynb path", () => {
		expect(isNotebook("/tmp/analysis.ipynb")).toBe(true);
		expect(isNotebook("/tmp/analysis.IPYNB")).toBe(true);
		expect(isNotebook("/tmp/script.py")).toBe(false);
	});
});

describe("parseNotebook", () => {
	test("parses notebook cells and language", () => {
		const parsed = parseNotebook(createSampleNotebook());
		expect(parsed.language).toBe("python");
		expect(parsed.cells).toHaveLength(4);
		expect(parsed.cells[0]?.cell_type).toBe("markdown");
		expect(parsed.cells[1]?.cell_type).toBe("code");
		expect(parsed.cells[1]?.execution_count).toBe(5);
		expect(parsed.cells[1]?.outputs?.[0]?.output_type).toBe("stream");
	});

	test("throws NotebookParseError for invalid JSON", () => {
		expect(() => parseNotebook("not-json")).toThrow(NotebookParseError);
	});

	test("throws NotebookParseError when cells are missing", () => {
		expect(() => parseNotebook(JSON.stringify({ metadata: {} }))).toThrow("missing cells array");
	});
});

describe("formatNotebookOutput", () => {
	test("formats code cells, outputs, errors, and image placeholders", () => {
		const parsed = parseNotebook(createSampleNotebook());
		const output = formatNotebookOutput(parsed);

		expect(output).toContain("[Notebook: python | 4 cells");
		expect(output).toContain("Cell 2 [code]");
		expect(output).toContain("# [5]");
		expect(output).toContain("```python");
		expect(output).toContain("[Output 1: stream]");
		expect(output).toContain("hello");
		expect(output).toContain("[Output 1: error]");
		expect(output).toContain("ZeroDivisionError: division by zero");
		expect(output).toContain("[Image output: PNG 800x600]");
		expect(output).toContain("[HTML output]");
		expect(output).not.toContain("iVBORw0KGgoAAAANSUhEUgAA");
	});
});

describe("summarizeNotebookCounts", () => {
	test("returns code/markdown/raw/output totals", () => {
		const parsed = parseNotebook(createSampleNotebook());
		const counts = summarizeNotebookCounts(parsed);

		expect(counts.codeCells).toBe(3);
		expect(counts.markdownCells).toBe(1);
		expect(counts.rawCells).toBe(0);
		expect(counts.outputCount).toBe(3);
	});
});
