import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatPdfOutput,
	isPdf,
	isPdfBuffer,
	PdfParseError,
	parsePageRanges,
	parsePdf,
	parsePdfReference,
} from "../pdf.js";

/**
 * Minimal valid PDF with one page containing "Hello World".
 * Generated from the PDF spec — just enough structure for unpdf to parse.
 */
function createMinimalPdf(text = "Hello World", pageCount = 1): Buffer {
	// Build a minimal PDF with N pages, each containing the given text
	const objects: string[] = [];
	let objNum = 1;

	// Catalog
	const catalogObj = objNum++;
	const pagesObj = objNum++;

	// Create page objects
	const pageObjs: number[] = [];
	const contentObjs: number[] = [];
	const fontObj = objNum++;

	for (let i = 0; i < pageCount; i++) {
		pageObjs.push(objNum++);
		contentObjs.push(objNum++);
	}

	// Build objects
	objects.push(`${catalogObj} 0 obj\n<< /Type /Catalog /Pages ${pagesObj} 0 R >>\nendobj`);

	const kids = pageObjs.map((p) => `${p} 0 R`).join(" ");
	objects.push(`${pagesObj} 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj`);

	objects.push(`${fontObj} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`);

	for (let i = 0; i < pageCount; i++) {
		const pageText = pageCount > 1 ? `${text} Page ${i + 1}` : text;
		const stream = `BT /F1 12 Tf 100 700 Td (${pageText}) Tj ET`;
		objects.push(
			`${pageObjs[i]} 0 obj\n<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${contentObjs[i]} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>\nendobj`
		);
		objects.push(
			`${contentObjs[i]} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`
		);
	}

	// Build xref and trailer
	const header = "%PDF-1.4\n";
	let body = "";
	const offsets: number[] = [];

	for (const obj of objects) {
		offsets.push(header.length + body.length);
		body += `${obj}\n`;
	}

	const xrefOffset = header.length + body.length;
	let xref = `xref\n0 ${offsets.length + 1}\n`;
	xref += "0000000000 65535 f \n";
	for (const off of offsets) {
		xref += `${String(off).padStart(10, "0")} 00000 n \n`;
	}

	const trailer = `trailer\n<< /Size ${offsets.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

	return Buffer.from(header + body + xref + trailer);
}

/** Temporary directory for test fixtures. */
let tmpDir: string;
let singlePagePdf: string;
let multiPagePdf: string;
let nonPdfFile: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));

	// Write test fixtures
	singlePagePdf = path.join(tmpDir, "single.pdf");
	fs.writeFileSync(singlePagePdf, createMinimalPdf("Hello World"));

	multiPagePdf = path.join(tmpDir, "multi.pdf");
	fs.writeFileSync(multiPagePdf, createMinimalPdf("Content", 15));

	nonPdfFile = path.join(tmpDir, "not-a-pdf.txt");
	fs.writeFileSync(nonPdfFile, "This is not a PDF\n");
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── parsePageRanges ─────────────────────────────────────────

describe("parsePageRanges", () => {
	test("parses single page", () => {
		expect(parsePageRanges("5")).toEqual([5]);
	});

	test("parses basic range", () => {
		expect(parsePageRanges("1-5")).toEqual([1, 2, 3, 4, 5]);
	});

	test("parses mixed ranges and singles", () => {
		expect(parsePageRanges("1,3,7-10")).toEqual([1, 3, 7, 8, 9, 10]);
	});

	test("deduplicates overlapping ranges", () => {
		expect(parsePageRanges("1-3,2-4")).toEqual([1, 2, 3, 4]);
	});

	test("throws on reversed range", () => {
		expect(() => parsePageRanges("5-3")).toThrow("start > end");
	});

	test("throws on zero page", () => {
		expect(() => parsePageRanges("0")).toThrow("1-indexed");
	});

	test("throws on negative page", () => {
		expect(() => parsePageRanges("-1")).toThrow();
	});

	test("handles whitespace in input", () => {
		expect(parsePageRanges(" 1 , 3 , 5-7 ")).toEqual([1, 3, 5, 6, 7]);
	});
});

// ── isPdf / isPdfBuffer ─────────────────────────────────────

describe("isPdf", () => {
	test("detects real PDF file", async () => {
		expect(await isPdf(singlePagePdf)).toBe(true);
	});

	test("rejects non-PDF file", async () => {
		expect(await isPdf(nonPdfFile)).toBe(false);
	});

	test("returns false for non-existent file", async () => {
		expect(await isPdf(path.join(tmpDir, "nope.pdf"))).toBe(false);
	});
});

describe("isPdfBuffer", () => {
	test("detects PDF buffer", () => {
		const buf = createMinimalPdf("test");
		expect(isPdfBuffer(buf)).toBe(true);
	});

	test("rejects non-PDF buffer", () => {
		expect(isPdfBuffer(Buffer.from("not a pdf"))).toBe(false);
	});

	test("rejects empty buffer", () => {
		expect(isPdfBuffer(Buffer.alloc(0))).toBe(false);
	});

	test("rejects short buffer", () => {
		expect(isPdfBuffer(Buffer.from("%PD"))).toBe(false);
	});
});

// ── parsePdf ────────────────────────────────────────────────

describe("parsePdf", () => {
	test("extracts text from single-page PDF", async () => {
		const buf = createMinimalPdf("Hello World");
		const result = await parsePdf(buf);
		expect(result.totalPages).toBe(1);
		expect(result.text).toContain("Hello World");
		expect(result.pageTexts).toHaveLength(1);
	});

	test("extracts text from multi-page PDF", async () => {
		const buf = createMinimalPdf("Content", 3);
		const result = await parsePdf(buf);
		expect(result.totalPages).toBe(3);
		expect(result.pageTexts).toHaveLength(3);
		expect(result.pageTexts[0]).toContain("Page 1");
		expect(result.pageTexts[2]).toContain("Page 3");
	});

	test("filters to specific pages", async () => {
		const buf = createMinimalPdf("Content", 5);
		const result = await parsePdf(buf, [2, 4]);
		expect(result.totalPages).toBe(5);
		expect(result.pageTexts).toHaveLength(2);
		expect(result.pageTexts[0]).toContain("Page 2");
		expect(result.pageTexts[1]).toContain("Page 4");
	});

	test("throws on out-of-range pages", async () => {
		const buf = createMinimalPdf("Content", 3);
		await expect(parsePdf(buf, [5])).rejects.toThrow("out of range");
	});

	test("throws PdfParseError on corrupted data", async () => {
		const garbage = Buffer.from("%PDF-1.4\ngarbage data that is not valid pdf");
		await expect(parsePdf(garbage)).rejects.toBeInstanceOf(PdfParseError);
	});
});

// ── parsePdfReference ───────────────────────────────────────

describe("parsePdfReference", () => {
	test("returns metadata and preview", async () => {
		const buf = createMinimalPdf("Preview Text");
		const ref = await parsePdfReference(buf);
		expect(ref.totalPages).toBe(1);
		expect(ref.preview).toContain("Preview Text");
	});

	test("truncates long first-page preview to ~500 chars", async () => {
		// Create a PDF with a very long first page
		const longText = "A".repeat(600);
		const buf = createMinimalPdf(longText);
		const ref = await parsePdfReference(buf);
		expect(ref.preview.length).toBeLessThanOrEqual(601); // 500 + "…"
	});
});

// ── formatPdfOutput ─────────────────────────────────────────

describe("formatPdfOutput", () => {
	test("includes page markers", () => {
		const result = {
			totalPages: 2,
			text: "Page 1 text\n\nPage 2 text",
			pageTexts: ["Page 1 text", "Page 2 text"],
			title: "Test Doc",
		};
		const output = formatPdfOutput(result);
		expect(output).toContain('[PDF: "Test Doc" | 2 pages]');
		expect(output).toContain("--- Page 1 ---");
		expect(output).toContain("--- Page 2 ---");
	});

	test("shows page range when specific pages requested", () => {
		const result = {
			totalPages: 10,
			text: "text",
			pageTexts: ["text"],
		};
		const output = formatPdfOutput(result, [3]);
		expect(output).toContain("Showing pages 3");
	});

	test("adds large PDF warning for >10 pages", () => {
		const result = {
			totalPages: 20,
			text: "text",
			pageTexts: Array.from({ length: 20 }, (_, i) => `Page ${i + 1}`),
		};
		const output = formatPdfOutput(result);
		expect(output).toContain('Use pages="1-10"');
	});
});
