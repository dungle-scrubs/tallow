/**
 * Tests that read tool error paths return `isError: true`.
 *
 * Covers the PDF page range parsing error — the only error path
 * in the enhanced read tool's own logic (base tool errors are
 * handled by the framework wrapper).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import readSummary from "../index.js";

/**
 * Create a minimal valid PDF buffer.
 * Just enough structure for `isPdf()` detection and `parsePdf()` to succeed.
 * @returns Buffer containing a minimal single-page PDF
 */
function createMinimalPdf(): Buffer {
	const stream = "BT /F1 12 Tf 100 700 Td (Hello) Tj ET";
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj",
		`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`,
		"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj",
	];

	const header = "%PDF-1.4\n";
	let body = "";
	const offsets: number[] = [];

	for (const obj of objects) {
		offsets.push(header.length + body.length);
		body += `${obj}\n`;
	}

	const xrefOffset = header.length + body.length;
	let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) {
		xref += `${String(off).padStart(10, "0")} 00000 n \n`;
	}

	const trailer = `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(header + body + xref + trailer);
}

let tmpDir: string;
let pdfPath: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-error-test-"));
	pdfPath = path.join(tmpDir, "test.pdf");
	fs.writeFileSync(pdfPath, createMinimalPdf());
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a minimal ExtensionContext stub.
 * @returns Partial context cast to ExtensionContext
 */
function stubContext(): ExtensionContext {
	return {
		hasUI: false,
		ui: { setWorkingMessage() {} },
		cwd: tmpDir,
	} as unknown as ExtensionContext;
}

describe("read tool error paths", () => {
	test("invalid page range returns isError: true", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(readSummary);

		const tool = harness.tools.get("read");
		expect(tool).toBeDefined();
		if (!tool) return;

		// "5-3" is a reversed range — parsePageRanges throws "start > end"
		const result = await tool.execute(
			"test-id",
			{ path: pdfPath, pages: "5-3" },
			new AbortController().signal,
			() => {},
			stubContext()
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Error parsing page range");
	});

	test("zero page number returns isError: true", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(readSummary);

		const tool = harness.tools.get("read");
		if (!tool) return;

		const result = await tool.execute(
			"test-id",
			{ path: pdfPath, pages: "0" },
			new AbortController().signal,
			() => {},
			stubContext()
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Error parsing page range");
	});
});
