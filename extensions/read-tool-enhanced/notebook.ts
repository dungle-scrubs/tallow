import { extname } from "node:path";

const DEFAULT_NOTEBOOK_LANGUAGE = "python";
const MAX_OUTPUT_CHARACTERS = 8_000;
const IMAGE_MIME_TYPES = [
	"image/gif",
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/webp",
] as const;

/** Marker for notebook results in details, used by renderResult/context restoration. */
export const NOTEBOOK_MARKER = "__notebook_read__";

/** Parsed notebook output cell. */
export interface NotebookOutput {
	readonly data?: Record<string, unknown>;
	readonly ename?: string;
	readonly evalue?: string;
	readonly metadata?: Record<string, unknown>;
	readonly name?: string;
	readonly output_type: string;
	readonly text?: string | readonly string[];
	readonly traceback?: readonly string[];
}

/** Parsed notebook cell. */
export interface NotebookCell {
	readonly cell_type: "code" | "markdown" | "raw";
	readonly execution_count?: number;
	readonly outputs?: readonly NotebookOutput[];
	readonly source: string | readonly string[];
}

/** Parsed notebook structure used by the read tool. */
export interface ParsedNotebook {
	readonly cells: readonly NotebookCell[];
	readonly language: string;
	readonly metadata: Record<string, unknown>;
}

/** Count summary for notebook cell/output types. */
export interface NotebookCellCounts {
	readonly codeCells: number;
	readonly markdownCells: number;
	readonly outputCount: number;
	readonly rawCells: number;
}

/** Thrown when a notebook cannot be parsed into a supported shape. */
export class NotebookParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotebookParseError";
	}
}

/**
 * Detect whether a file path looks like a Jupyter notebook.
 *
 * @param absolutePath - Absolute path to inspect
 * @returns True when extension is `.ipynb` (case-insensitive)
 */
export function isNotebook(absolutePath: string): boolean {
	return extname(absolutePath).toLowerCase() === ".ipynb";
}

/**
 * Parse notebook JSON into a normalized representation used by formatters.
 *
 * @param content - Raw `.ipynb` JSON content
 * @returns Parsed notebook structure with normalized cells and metadata
 * @throws {NotebookParseError} When JSON is invalid or notebook shape is unsupported
 */
export function parseNotebook(content: string): ParsedNotebook {
	const root = parseNotebookJson(content);
	const cellsValue = root.cells;
	if (!Array.isArray(cellsValue)) {
		throw new NotebookParseError("Cannot read notebook: missing cells array");
	}

	const metadata = toRecord(root.metadata) ?? {};
	const language = detectNotebookLanguage(metadata);
	const cells = cellsValue.map((cell) => normalizeCell(cell));

	return {
		cells,
		language,
		metadata,
	};
}

/**
 * Format parsed notebook cells into LLM-friendly plain text.
 *
 * @param notebook - Parsed notebook from `parseNotebook`
 * @returns Human-readable notebook text with cell separators and structured outputs
 */
export function formatNotebookOutput(notebook: ParsedNotebook): string {
	const counts = summarizeNotebookCounts(notebook);
	const lines: string[] = [
		`[Notebook: ${notebook.language} | ${notebook.cells.length} cells (${counts.codeCells} code, ${counts.markdownCells} markdown, ${counts.rawCells} raw, ${counts.outputCount} outputs)]`,
		"",
	];

	notebook.cells.forEach((cell, index) => {
		if (index > 0) {
			lines.push("---", "");
		}
		lines.push(...formatCell(cell, index + 1, notebook.language));
	});

	return lines.join("\n").trimEnd();
}

/**
 * Count notebook cell and output totals for summary display.
 *
 * @param notebook - Parsed notebook from `parseNotebook`
 * @returns Aggregated counts used in collapsed summaries
 */
export function summarizeNotebookCounts(notebook: ParsedNotebook): NotebookCellCounts {
	let codeCells = 0;
	let markdownCells = 0;
	let rawCells = 0;
	let outputCount = 0;

	for (const cell of notebook.cells) {
		if (cell.cell_type === "code") codeCells += 1;
		if (cell.cell_type === "markdown") markdownCells += 1;
		if (cell.cell_type === "raw") rawCells += 1;
		outputCount += cell.outputs?.length ?? 0;
	}

	return {
		codeCells,
		markdownCells,
		outputCount,
		rawCells,
	};
}

/**
 * Parse a JSON string and validate the top-level notebook object shape.
 *
 * @param content - Raw JSON string
 * @returns Parsed top-level notebook object
 * @throws {NotebookParseError} When JSON is invalid or top-level is not an object
 */
function parseNotebookJson(content: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch {
		throw new NotebookParseError("Cannot read notebook: invalid JSON");
	}

	if (!isRecord(parsed)) {
		throw new NotebookParseError("Cannot read notebook: expected top-level object");
	}

	return parsed;
}

/**
 * Normalize a raw notebook cell object.
 *
 * @param value - Raw cell value from parsed JSON
 * @returns Normalized notebook cell
 */
function normalizeCell(value: unknown): NotebookCell {
	if (!isRecord(value)) {
		return {
			cell_type: "raw",
			source: "[Unsupported cell structure]",
		};
	}

	const cellType = normalizeCellType(value.cell_type);
	const source = normalizeSource(value.source);
	const executionCount =
		typeof value.execution_count === "number" ? value.execution_count : undefined;
	const outputs = Array.isArray(value.outputs)
		? value.outputs
				.map((output) => normalizeOutput(output))
				.filter((output): output is NotebookOutput => output !== null)
		: undefined;

	return {
		cell_type: cellType,
		execution_count: executionCount,
		outputs,
		source,
	};
}

/**
 * Normalize a raw notebook output object.
 *
 * @param value - Raw output value from parsed JSON
 * @returns Normalized output, or null when value is not an object
 */
function normalizeOutput(value: unknown): NotebookOutput | null {
	if (!isRecord(value)) return null;

	const traceback = Array.isArray(value.traceback)
		? value.traceback.filter((line): line is string => typeof line === "string")
		: undefined;
	const text = normalizeOptionalSource(value.text);

	return {
		data: toRecord(value.data),
		ename: typeof value.ename === "string" ? value.ename : undefined,
		evalue: typeof value.evalue === "string" ? value.evalue : undefined,
		metadata: toRecord(value.metadata),
		name: typeof value.name === "string" ? value.name : undefined,
		output_type: typeof value.output_type === "string" ? value.output_type : "stream",
		text,
		traceback,
	};
}

/**
 * Normalize an optional source/text field.
 *
 * @param value - Raw source value
 * @returns Normalized source value, or undefined when missing/unsupported
 */
function normalizeOptionalSource(value: unknown): string | readonly string[] | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	return undefined;
}

/**
 * Normalize a required source field.
 *
 * @param value - Raw source value
 * @returns Normalized source string or string-array
 */
function normalizeSource(value: unknown): string | readonly string[] {
	return normalizeOptionalSource(value) ?? "";
}

/**
 * Normalize notebook cell type to supported values.
 *
 * @param value - Raw `cell_type` value
 * @returns One of `markdown`, `code`, or `raw`
 */
function normalizeCellType(value: unknown): "code" | "markdown" | "raw" {
	if (value === "code" || value === "markdown" || value === "raw") return value;
	return "raw";
}

/**
 * Detect notebook language from metadata.
 *
 * @param metadata - Top-level notebook metadata
 * @returns Kernel language name, falling back to python
 */
function detectNotebookLanguage(metadata: Record<string, unknown>): string {
	const kernelspec = toRecord(metadata.kernelspec);
	const kernelLanguage = typeof kernelspec?.language === "string" ? kernelspec.language.trim() : "";
	if (kernelLanguage.length > 0) return kernelLanguage;

	const languageInfo = toRecord(metadata.language_info);
	const languageName = typeof languageInfo?.name === "string" ? languageInfo.name.trim() : "";
	if (languageName.length > 0) return languageName;

	return DEFAULT_NOTEBOOK_LANGUAGE;
}

/**
 * Format a single notebook cell and its outputs.
 *
 * @param cell - Notebook cell to format
 * @param cellNumber - 1-indexed cell number
 * @param language - Notebook language used for code fences
 * @returns Formatted cell lines
 */
function formatCell(cell: NotebookCell, cellNumber: number, language: string): string[] {
	if (cell.cell_type === "markdown") {
		const markdown = joinSource(cell.source).trimEnd();
		return [`Cell ${cellNumber} [markdown]`, markdown || "[Empty markdown cell]"];
	}

	if (cell.cell_type === "raw") {
		const raw = joinSource(cell.source).trimEnd();
		return [
			`Cell ${cellNumber} [raw]`,
			"```text",
			raw.length > 0 ? raw : "[Empty raw cell]",
			"```",
		];
	}

	const lines: string[] = [`Cell ${cellNumber} [code]`];
	if (typeof cell.execution_count === "number") {
		lines.push(`# [${cell.execution_count}]`);
	}

	const code = joinSource(cell.source).trimEnd();
	lines.push(`\`\`\`${language}`, code.length > 0 ? code : "", "```");
	lines.push(...formatCellOutputs(cell.outputs));
	return lines;
}

/**
 * Format all outputs for a code cell.
 *
 * @param outputs - Optional code cell outputs
 * @returns Formatted output lines
 */
function formatCellOutputs(outputs: readonly NotebookOutput[] | undefined): string[] {
	if (!outputs || outputs.length === 0) return [];

	const lines: string[] = ["Outputs:"];
	outputs.forEach((output, index) => {
		if (index > 0) lines.push("");
		lines.push(...formatOutput(output, index + 1));
	});
	return lines;
}

/**
 * Format one notebook output entry.
 *
 * @param output - Output entry to format
 * @param outputNumber - 1-indexed output number within a cell
 * @returns Formatted output lines
 */
function formatOutput(output: NotebookOutput, outputNumber: number): string[] {
	if (output.output_type === "error") {
		return formatErrorOutput(output, outputNumber);
	}

	if (output.output_type === "stream") {
		return formatStreamOutput(output, outputNumber);
	}

	if (output.output_type === "execute_result" || output.output_type === "display_data") {
		return formatRichOutput(output, outputNumber);
	}

	return formatUnknownOutput(output, outputNumber);
}

/**
 * Format stream output text.
 *
 * @param output - Stream output entry
 * @param outputNumber - 1-indexed output number
 * @returns Formatted output lines
 */
function formatStreamOutput(output: NotebookOutput, outputNumber: number): string[] {
	const text = truncateForDisplay(joinSource(output.text).trimEnd());
	if (text.length === 0) {
		return [`[Output ${outputNumber}: stream]`, "[No text output]"];
	}
	return [`[Output ${outputNumber}: stream]`, "```text", text, "```"];
}

/**
 * Format rich display output (`execute_result` / `display_data`).
 *
 * @param output - Rich output entry
 * @param outputNumber - 1-indexed output number
 * @returns Formatted output lines
 */
function formatRichOutput(output: NotebookOutput, outputNumber: number): string[] {
	const lines: string[] = [`[Output ${outputNumber}: ${output.output_type}]`];
	const data = output.data ?? {};

	const plainText = extractPlainText(data);
	if (plainText.length > 0) {
		lines.push("```text", truncateForDisplay(plainText.trimEnd()), "```");
	}

	const imageLines = IMAGE_MIME_TYPES.flatMap((mimeType) => {
		if (!(mimeType in data)) return [];
		const dimensions = getImageDimensionsFromMetadata(output.metadata, mimeType);
		const format = mimeType.split("/")[1]?.toUpperCase() ?? "IMAGE";
		return dimensions
			? [`[Image output: ${format} ${dimensions.width}x${dimensions.height}]`]
			: [`[Image output: ${format}]`];
	});
	lines.push(...imageLines);

	const hasHtml = typeof data["text/html"] === "string" || Array.isArray(data["text/html"]);
	if (hasHtml) {
		lines.push("[HTML output]");
	}

	if (plainText.length === 0 && imageLines.length === 0 && !hasHtml) {
		const fallbackText = truncateForDisplay(joinSource(output.text).trimEnd());
		if (fallbackText.length > 0) {
			lines.push("```text", fallbackText, "```");
		} else {
			lines.push("[Unsupported rich output]");
		}
	}

	return lines;
}

/**
 * Format error output with traceback.
 *
 * @param output - Error output entry
 * @param outputNumber - 1-indexed output number
 * @returns Formatted output lines
 */
function formatErrorOutput(output: NotebookOutput, outputNumber: number): string[] {
	const header = [output.ename, output.evalue].filter(Boolean).join(": ") || "Execution error";
	const traceback = output.traceback?.join("\n");
	const body = traceback ? `${header}\n${traceback}` : header;
	return [`[Output ${outputNumber}: error]`, "```text", truncateForDisplay(body), "```"];
}

/**
 * Format unsupported output types using best-effort text extraction.
 *
 * @param output - Unknown output entry
 * @param outputNumber - 1-indexed output number
 * @returns Formatted output lines
 */
function formatUnknownOutput(output: NotebookOutput, outputNumber: number): string[] {
	const text = truncateForDisplay(joinSource(output.text).trimEnd());
	if (text.length === 0) {
		return [`[Output ${outputNumber}: ${output.output_type}]`, "[Unsupported output]"];
	}
	return [`[Output ${outputNumber}: ${output.output_type}]`, "```text", text, "```"];
}

/**
 * Extract plain text from rich output data payloads.
 *
 * @param data - Rich output `data` map
 * @returns Joined plain-text content, or empty string when absent
 */
function extractPlainText(data: Record<string, unknown>): string {
	const plain = data["text/plain"];
	if (typeof plain === "string") return plain;
	if (Array.isArray(plain)) {
		return plain.filter((part): part is string => typeof part === "string").join("");
	}
	return "";
}

/**
 * Join notebook source/text fields into a single string.
 *
 * @param source - String or line-array field
 * @returns Combined text string
 */
function joinSource(source: string | readonly string[] | undefined): string {
	if (typeof source === "string") return source;
	if (Array.isArray(source)) return source.join("");
	return "";
}

/**
 * Truncate very large output segments while preserving context.
 *
 * @param value - Text to truncate
 * @returns Original text if short, otherwise truncated text with notice
 */
function truncateForDisplay(value: string): string {
	if (value.length <= MAX_OUTPUT_CHARACTERS) return value;
	return `${value.slice(0, MAX_OUTPUT_CHARACTERS)}\n[Output truncated at ${MAX_OUTPUT_CHARACTERS} chars]`;
}

/**
 * Read image dimensions from notebook output metadata.
 *
 * @param metadata - Output metadata payload
 * @param mimeType - Image MIME type key
 * @returns Width/height pair when available, otherwise null
 */
function getImageDimensionsFromMetadata(
	metadata: Record<string, unknown> | undefined,
	mimeType: string
): { height: number; width: number } | null {
	if (!metadata) return null;
	const nested = readDimensionCandidate(metadata[mimeType]);
	if (nested) return nested;
	return readDimensionCandidate(metadata);
}

/**
 * Parse a metadata object and extract numeric width/height.
 *
 * @param value - Metadata candidate object
 * @returns Dimensions when both values are valid positive numbers
 */
function readDimensionCandidate(value: unknown): { height: number; width: number } | null {
	if (!isRecord(value)) return null;
	const width = typeof value.width === "number" ? value.width : null;
	const height = typeof value.height === "number" ? value.height : null;
	if (width === null || height === null || width <= 0 || height <= 0) return null;
	return { height, width };
}

/**
 * Narrow an unknown value to a plain object record.
 *
 * @param value - Value to narrow
 * @returns Record value or undefined when value is not a plain object
 */
function toRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

/**
 * Check whether a value is a non-null object (excluding arrays).
 *
 * @param value - Value to check
 * @returns True for plain object-like records
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
