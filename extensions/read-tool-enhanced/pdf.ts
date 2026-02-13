/**
 * PDF parsing module for the read-tool-enhanced extension.
 *
 * Isolates all PDF logic: detection, text extraction, page selection,
 * and metadata. Uses `unpdf` (bundled serverless pdf.js) for zero-native-dep
 * PDF processing.
 */

import * as fs from "node:fs";
import { extractText, getDocumentProxy, getMeta } from "unpdf";

// ── Types ───────────────────────────────────────────────────

/** Result of parsing a PDF for full text extraction. */
export interface PdfParseResult {
	readonly totalPages: number;
	/** Merged text for the selected pages. */
	readonly text: string;
	/** Per-page text array (0-indexed). */
	readonly pageTexts: string[];
	readonly title?: string;
	readonly author?: string;
}

/** Lightweight reference for large PDF @-mentions. */
export interface PdfReference {
	readonly totalPages: number;
	readonly title?: string;
	readonly author?: string;
	/** First page text, truncated to ~500 chars. */
	readonly preview: string;
}

// ── Errors ──────────────────────────────────────────────────

/** Thrown when a PDF is encrypted or password-protected. */
export class PdfEncryptedError extends Error {
	constructor(path?: string) {
		super(
			path
				? `Cannot read PDF: file is encrypted/password-protected (${path})`
				: "Cannot read PDF: file is encrypted/password-protected"
		);
		this.name = "PdfEncryptedError";
	}
}

/** Thrown when a PDF is corrupted or otherwise unparseable. */
export class PdfParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PdfParseError";
	}
}

// ── Detection ───────────────────────────────────────────────

/** PDF magic bytes: `%PDF-` */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/**
 * Detect whether a file is a PDF by checking magic bytes.
 * Does not rely on file extension — handles misnamed files correctly.
 *
 * @param absolutePath - Absolute path to the file
 * @returns True if the file starts with `%PDF-`
 */
export async function isPdf(absolutePath: string): Promise<boolean> {
	try {
		const fd = fs.openSync(absolutePath, "r");
		try {
			const buf = Buffer.alloc(5);
			fs.readSync(fd, buf, 0, 5, 0);
			return buf.equals(PDF_MAGIC);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

/**
 * Synchronous variant of isPdf for use in the file-reference extension.
 *
 * @param buffer - File content buffer
 * @returns True if the buffer starts with `%PDF-`
 */
export function isPdfBuffer(buffer: Buffer): boolean {
	if (buffer.length < 5) return false;
	return buffer.subarray(0, 5).equals(PDF_MAGIC);
}

// ── Page Range Parsing ──────────────────────────────────────

/**
 * Parse a page range string into an array of 1-indexed page numbers.
 * Supports individual pages, ranges, and comma-separated combinations.
 *
 * @param input - Page range string, e.g. `"1-5"`, `"1,3,7-10"`
 * @returns Array of 1-indexed page numbers, sorted and deduplicated
 * @throws {Error} When input contains invalid ranges (e.g. `"5-3"`, `"0"`)
 */
export function parsePageRanges(input: string): number[] {
	const pages = new Set<number>();
	const parts = input.split(",").map((s) => s.trim());

	for (const part of parts) {
		if (!part) continue;

		const rangeParts = part.split("-");
		if (rangeParts.length === 1) {
			const num = Number.parseInt(rangeParts[0], 10);
			if (Number.isNaN(num) || num < 1) {
				throw new Error(`Invalid page number: "${part}" (pages are 1-indexed)`);
			}
			pages.add(num);
		} else if (rangeParts.length === 2) {
			const start = Number.parseInt(rangeParts[0], 10);
			const end = Number.parseInt(rangeParts[1], 10);
			if (Number.isNaN(start) || Number.isNaN(end) || start < 1 || end < 1) {
				throw new Error(`Invalid page range: "${part}" (pages are 1-indexed)`);
			}
			if (start > end) {
				throw new Error(`Invalid page range: "${part}" (start > end)`);
			}
			for (let i = start; i <= end; i++) pages.add(i);
		} else {
			throw new Error(`Invalid page range format: "${part}"`);
		}
	}

	return [...pages].sort((a, b) => a - b);
}

// ── Core Parsing ────────────────────────────────────────────

/**
 * Extract text from a PDF buffer, optionally filtering to specific pages.
 *
 * @param buffer - Raw PDF file bytes
 * @param pages - Optional array of 1-indexed page numbers to extract.
 *                If omitted, all pages are extracted.
 * @returns Parsed PDF result with text, page count, and metadata
 * @throws {PdfEncryptedError} When the PDF is password-protected
 * @throws {PdfParseError} When the PDF is corrupted or unparseable
 */
export async function parsePdf(buffer: Buffer, pages?: readonly number[]): Promise<PdfParseResult> {
	let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
	try {
		pdf = await getDocumentProxy(new Uint8Array(buffer));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("password") || msg.includes("encrypted")) {
			throw new PdfEncryptedError();
		}
		throw new PdfParseError(`Cannot read PDF: file appears corrupted or is not a valid PDF`);
	}

	try {
		const { totalPages, text: allPageTexts } = await extractText(pdf, { mergePages: false });

		// Validate requested pages are in range
		if (pages) {
			const outOfRange = pages.filter((p) => p < 1 || p > totalPages);
			if (outOfRange.length > 0) {
				throw new PdfParseError(
					`Page(s) ${outOfRange.join(", ")} out of range (PDF has ${totalPages} pages)`
				);
			}
		}

		// Extract metadata (best-effort)
		let title: string | undefined;
		let author: string | undefined;
		try {
			const meta = await getMeta(pdf);
			title = (meta.info as Record<string, unknown>)?.Title as string | undefined;
			author = (meta.info as Record<string, unknown>)?.Author as string | undefined;
		} catch {
			// Metadata extraction is optional
		}

		// Filter to requested pages (convert 1-indexed to 0-indexed)
		const selectedTexts = pages
			? pages.map((p) => allPageTexts[p - 1] ?? "")
			: (allPageTexts as string[]);

		const mergedText = selectedTexts.join("\n\n");

		return {
			totalPages,
			text: mergedText,
			pageTexts: selectedTexts,
			title: title || undefined,
			author: author || undefined,
		};
	} finally {
		pdf.destroy();
	}
}

/**
 * Extract a lightweight reference from a PDF for @-mention expansion.
 * Returns metadata and a preview of the first page only.
 *
 * @param buffer - Raw PDF file bytes
 * @returns Reference with page count, title, author, and first-page preview
 * @throws {PdfParseError} When the PDF cannot be parsed
 */
export async function parsePdfReference(buffer: Buffer): Promise<PdfReference> {
	let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
	try {
		pdf = await getDocumentProxy(new Uint8Array(buffer));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("password") || msg.includes("encrypted")) {
			throw new PdfEncryptedError();
		}
		throw new PdfParseError(`Cannot read PDF: file appears corrupted or is not a valid PDF`);
	}

	try {
		const { totalPages, text: allPageTexts } = await extractText(pdf, { mergePages: false });

		let title: string | undefined;
		let author: string | undefined;
		try {
			const meta = await getMeta(pdf);
			title = (meta.info as Record<string, unknown>)?.Title as string | undefined;
			author = (meta.info as Record<string, unknown>)?.Author as string | undefined;
		} catch {
			// Best-effort
		}

		const firstPage = (allPageTexts[0] as string) ?? "";
		const preview = firstPage.length > 500 ? `${firstPage.slice(0, 500)}…` : firstPage;

		return {
			totalPages,
			title: title || undefined,
			author: author || undefined,
			preview,
		};
	} finally {
		pdf.destroy();
	}
}

// ── Formatting Helpers ──────────────────────────────────────

/** Maximum extracted text size before truncation (50KB). */
const MAX_EXTRACTED_BYTES = 50 * 1024;

/** Page threshold for large PDF warnings. */
const LARGE_PDF_THRESHOLD = 10;

/** Max pages to auto-extract when a large PDF exceeds the byte limit. */
const LARGE_PDF_AUTO_PAGES = 10;

/**
 * Format extracted PDF text with page markers and size management.
 *
 * Handles large PDF truncation: if extracted text exceeds 50KB and no
 * specific pages were requested, extracts only the first 10 pages and
 * appends a truncation notice.
 *
 * @param result - Parsed PDF result from `parsePdf`
 * @param requestedPages - Pages the user explicitly requested, if any
 * @returns Formatted text string ready for the LLM
 */
export function formatPdfOutput(
	result: PdfParseResult,
	requestedPages?: readonly number[]
): string {
	const { totalPages, title, pageTexts } = result;
	const titlePart = title ? `"${title}" | ` : "";

	// Determine which page numbers to label
	const pageNumbers = requestedPages ?? Array.from({ length: totalPages }, (_, i) => i + 1);
	const isLarge = totalPages > LARGE_PDF_THRESHOLD && !requestedPages;

	let header: string;
	if (requestedPages) {
		header = `[PDF: ${titlePart}${totalPages} pages | Showing pages ${formatRanges(requestedPages)}]`;
	} else if (isLarge) {
		header = `[PDF: ${titlePart}${totalPages} pages | Showing all. Use pages="1-10" to read specific pages.]`;
	} else {
		header = `[PDF: ${titlePart}${totalPages} pages]`;
	}

	// Build page-separated output
	const sections: string[] = [header, ""];
	for (let i = 0; i < pageTexts.length; i++) {
		sections.push(`--- Page ${pageNumbers[i]} ---`);
		sections.push(pageTexts[i]);
		sections.push("");
	}

	let output = sections.join("\n");

	// Truncate if exceeds size limit
	if (Buffer.byteLength(output, "utf-8") > MAX_EXTRACTED_BYTES) {
		if (!requestedPages && totalPages > LARGE_PDF_AUTO_PAGES) {
			// Re-extract first N pages only
			const truncatedTexts = pageTexts.slice(0, LARGE_PDF_AUTO_PAGES);
			const truncSections: string[] = [
				`[PDF: ${titlePart}${totalPages} pages | Showing pages 1-${LARGE_PDF_AUTO_PAGES} of ${totalPages}]`,
				"",
			];
			for (let i = 0; i < truncatedTexts.length; i++) {
				truncSections.push(`--- Page ${i + 1} ---`);
				truncSections.push(truncatedTexts[i]);
				truncSections.push("");
			}
			truncSections.push(
				`[Truncated: showing pages 1-${LARGE_PDF_AUTO_PAGES} of ${totalPages}. Use pages="${LARGE_PDF_AUTO_PAGES + 1}-${Math.min(totalPages, LARGE_PDF_AUTO_PAGES * 2)}" to continue.]`
			);
			output = truncSections.join("\n");
		} else {
			output =
				output.slice(0, MAX_EXTRACTED_BYTES) +
				`\n[Truncated at 50KB. Use pages="..." to read specific sections.]`;
		}
	}

	return output;
}

/**
 * Compress an array of page numbers into a readable range string.
 * E.g. `[1,2,3,5,7,8,9]` → `"1-3, 5, 7-9"`
 *
 * @param pages - Sorted array of 1-indexed page numbers
 * @returns Compact range string
 */
function formatRanges(pages: readonly number[]): string {
	if (pages.length === 0) return "";
	const ranges: string[] = [];
	let start = pages[0];
	let end = pages[0];

	for (let i = 1; i < pages.length; i++) {
		if (pages[i] === end + 1) {
			end = pages[i];
		} else {
			ranges.push(start === end ? `${start}` : `${start}-${end}`);
			start = pages[i];
			end = pages[i];
		}
	}
	ranges.push(start === end ? `${start}` : `${start}-${end}`);
	return ranges.join(", ");
}
