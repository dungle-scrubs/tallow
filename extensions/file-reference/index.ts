/**
 * File Reference Extension
 *
 * Expands @path/to/file patterns in user input by reading the referenced
 * files and inlining their contents in fenced code blocks. Compatible
 * with Claude Code's @file syntax.
 *
 * The core transform is exported as a named function so other extensions
 * (e.g. subagent-tool) can import and call it directly on arbitrary strings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isPdfBuffer, parsePdf, parsePdfReference } from "../read-tool-enhanced/pdf.js";

/**
 * Matches @path/to/file patterns.
 * Negative lookbehind prevents matching emails (user@domain) or decorators (@Override).
 * Global flag for multiple occurrences.
 */
const FILE_PATTERN =
	/(?<![a-zA-Z0-9_])@((?:[a-zA-Z0-9_\-.]+\/)*[a-zA-Z0-9_\-.]+(?:\.[a-zA-Z0-9]+)?)/g;

/** Maximum file size to inline (100 KB). */
const MAX_FILE_SIZE = 100 * 1024;

/** Bytes to sample for binary detection. */
const BINARY_CHECK_SIZE = 8192;

/** Extension-to-language hint map for fenced code blocks. */
const LANG_MAP: Readonly<Record<string, string>> = {
	ts: "ts",
	tsx: "tsx",
	js: "js",
	jsx: "jsx",
	mjs: "js",
	cjs: "js",
	py: "python",
	rs: "rust",
	go: "go",
	rb: "ruby",
	java: "java",
	sh: "bash",
	bash: "bash",
	zsh: "zsh",
	css: "css",
	html: "html",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "md",
	sql: "sql",
	swift: "swift",
	lua: "lua",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
};

interface ReadResult {
	readonly content: string;
	readonly truncated: boolean;
}

/**
 * Collect [start, end] index ranges for fenced code blocks (``` or ~~~).
 * Patterns inside these regions should not be expanded.
 *
 * @param text - Input text to scan
 * @returns Array of [start, end] index pairs
 */
function getFencedRegions(text: string): Array<[number, number]> {
	const regions: Array<[number, number]> = [];
	const fencePattern = /^(`{3,}|~{3,})/gm;
	let openFence: { index: number; marker: string } | null = null;

	for (const match of text.matchAll(fencePattern)) {
		const idx = match.index ?? 0;
		if (!openFence) {
			openFence = { index: idx, marker: match[1] };
		} else if (match[1][0] === openFence.marker[0] && match[1].length >= openFence.marker.length) {
			regions.push([openFence.index, idx + match[0].length]);
			openFence = null;
		}
	}

	// Unclosed fence extends to end of text
	if (openFence) {
		regions.push([openFence.index, text.length]);
	}

	return regions;
}

/**
 * Check whether an index falls inside any fenced code block region.
 *
 * @param index - Character index to check
 * @param regions - Fenced code block regions from getFencedRegions
 * @returns True if the index is inside a fenced region
 */
function isInFencedRegion(index: number, regions: ReadonlyArray<[number, number]>): boolean {
	return regions.some(([start, end]) => index >= start && index < end);
}

/**
 * Detect binary content by checking for null bytes in the first 8 KB.
 *
 * @param buffer - File content buffer to check
 * @returns True if null bytes detected (binary file)
 */
function isBinaryContent(buffer: Buffer): boolean {
	const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE);
	for (let i = 0; i < checkLength; i++) {
		if (buffer[i] === 0) return true;
	}
	return false;
}

/** Page count threshold: PDFs with more pages get a lightweight reference. */
const PDF_INLINE_THRESHOLD = 10;

/**
 * Read file content with size truncation and binary detection.
 * PDFs are detected but NOT read here (they need async handling).
 *
 * @param filePath - Absolute path to the file
 * @param fileSize - File size in bytes (from stat)
 * @returns Read result, `"pdf"` for PDF files, or null for binary files
 */
function readFileContent(filePath: string, fileSize: number): ReadResult | "pdf" | null {
	const buffer = fs.readFileSync(filePath);

	// PDF detection — before binary check since PDFs contain null bytes
	if (isPdfBuffer(buffer)) return "pdf";

	if (isBinaryContent(buffer)) return null;

	const truncated = fileSize > MAX_FILE_SIZE;
	const content = truncated
		? buffer.subarray(0, MAX_FILE_SIZE).toString("utf-8")
		: buffer.toString("utf-8");

	return { content, truncated };
}

/**
 * Read PDF content for @-mention expansion (async).
 * Small PDFs (≤10 pages) get full text inlined; large PDFs get a reference.
 *
 * @param filePath - Absolute path to the PDF file
 * @param relPath - Relative path for display
 * @returns Formatted string for prompt insertion, or null on failure
 */
async function readPdfForReference(filePath: string, relPath: string): Promise<string | null> {
	try {
		const buffer = fs.readFileSync(filePath);
		const ref = await parsePdfReference(buffer);

		if (ref.totalPages <= PDF_INLINE_THRESHOLD) {
			// Small PDF: inline full text
			const result = await parsePdf(buffer);
			const lines: string[] = [`\`${relPath}\` [PDF, ${result.totalPages} pages]:`];
			lines.push("```");
			lines.push(result.text);
			lines.push("```");
			return lines.join("\n");
		}

		// Large PDF: lightweight reference
		const lines: string[] = [`\`${relPath}\` [PDF, ${ref.totalPages} pages]:`];
		if (ref.title) lines.push(`Title: ${ref.title}`);
		if (ref.author) lines.push(`Author: ${ref.author}`);
		lines.push("");
		lines.push("Preview (page 1):");
		lines.push(`> ${ref.preview.split("\n").join("\n> ")}`);
		lines.push("");
		lines.push(`Use \`read ${relPath} pages="1-5"\` to read specific pages.`);
		return lines.join("\n");
	} catch {
		return `[unreadable PDF: ${relPath}]`;
	}
}

/**
 * Derive a fenced code block language hint from a file path's extension.
 *
 * @param filePath - File path to extract extension from
 * @returns Language hint string (empty string if no extension)
 */
function getLanguageHint(filePath: string): string {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	if (!ext) return "";
	return LANG_MAP[ext] ?? ext;
}

/**
 * Format file content as an inlined code block for prompt insertion.
 *
 * @param filePath - Relative path used in the reference
 * @param readResult - Content and truncation info from readFileContent
 * @param lang - Language hint for the fenced code block
 * @returns Formatted string with filename header and fenced content
 */
function formatFileContent(
	filePath: string,
	readResult: ReadResult,
	lang: string,
	fileSize: number
): string {
	let body = readResult.content.trimEnd();
	if (readResult.truncated) {
		body += `\n[truncated: file is ${fileSize} bytes, showing first 100KB]`;
	}
	return `\`${filePath}\`:\n\`\`\`${lang}\n${body}\n\`\`\``;
}

/**
 * Expand @path/to/file patterns in text by reading files and replacing
 * each pattern with the file's contents in a fenced code block.
 *
 * Non-recursive: output is never re-scanned for additional patterns.
 * Patterns inside fenced code blocks are skipped.
 * PDFs are extracted asynchronously via `unpdf`.
 *
 * @param text - Input text potentially containing @file patterns
 * @param cwd - Working directory for path resolution
 * @returns Text with all valid patterns replaced by inlined file contents
 */
export async function expandFileReferences(text: string, cwd: string): Promise<string> {
	if (!FILE_PATTERN.test(text)) return text;
	FILE_PATTERN.lastIndex = 0;

	const fencedRegions = getFencedRegions(text);

	// Collect all replacements first, then apply in reverse order to preserve indices
	interface Replacement {
		start: number;
		end: number;
		text: string;
	}
	const replacements: Replacement[] = [];
	const pdfPromises: Array<{ index: number; filePath: string; resolved: string }> = [];

	for (const match of text.matchAll(FILE_PATTERN)) {
		const matchIndex = match.index ?? 0;
		if (isInFencedRegion(matchIndex, fencedRegions)) continue;

		const filePath = match[1];
		const resolved = path.resolve(cwd, filePath);

		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;

		const readResult = readFileContent(resolved, stat.size);

		if (readResult === "pdf") {
			// Queue for async PDF processing
			const repIdx = replacements.length;
			replacements.push({ start: matchIndex, end: matchIndex + match[0].length, text: "" });
			pdfPromises.push({ index: repIdx, filePath, resolved });
			continue;
		}

		if (!readResult) {
			replacements.push({
				start: matchIndex,
				end: matchIndex + match[0].length,
				text: `[binary file: ${filePath}]`,
			});
			continue;
		}

		const lang = getLanguageHint(filePath);
		replacements.push({
			start: matchIndex,
			end: matchIndex + match[0].length,
			text: formatFileContent(filePath, readResult, lang, stat.size),
		});
	}

	// Resolve PDF references in parallel
	if (pdfPromises.length > 0) {
		const results = await Promise.all(
			pdfPromises.map(({ filePath, resolved }) => readPdfForReference(resolved, filePath))
		);
		for (let i = 0; i < pdfPromises.length; i++) {
			replacements[pdfPromises[i].index].text =
				results[i] ?? `[unreadable PDF: ${pdfPromises[i].filePath}]`;
		}
	}

	// Apply replacements in reverse order (preserves indices)
	let result = text;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		result = result.slice(0, r.start) + r.text + result.slice(r.end);
	}

	return result;
}

/**
 * Extension factory. Registers an input handler that expands
 * @path/to/file patterns before the prompt reaches the agent.
 *
 * @param pi - Extension API provided by the runtime
 */
export default function (pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		const result = await expandFileReferences(event.text, process.cwd());
		if (result === event.text) {
			return { action: "continue" as const };
		}
		return { action: "transform" as const, text: result };
	});
}
