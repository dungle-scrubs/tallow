import { afterEach, describe, expect, test } from "bun:test";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import webFetchExtension, { readResponseBodyWithCap } from "../index.js";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("readResponseBodyWithCap", () => {
	test("cancels large streams once the retention limit is reached", async () => {
		let cancelCalled = false;
		let pulls = 0;

		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancelCalled = true;
				},
				pull(controller) {
					pulls += 1;
					controller.enqueue(encoder.encode("x".repeat(4096)));
				},
			}),
			{ headers: { "content-type": "text/plain" } }
		);

		const result = await readResponseBodyWithCap(response, 4096, 4096);

		expect(cancelCalled).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.totalBytesExact).toBe(false);
		expect(result.totalBytes).toBeGreaterThanOrEqual(8192);
		expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(8192);
		expect(pulls).toBeLessThanOrEqual(3);
	});
});

describe("web_fetch streaming limits", () => {
	test("returns truncated output without buffering the full stream", async () => {
		const harness = ExtensionHarness.create();

		globalThis.fetch = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(encoder.encode("y".repeat(16384)));
					},
				}),
				{ headers: { "content-type": "text/plain" } }
			);

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const result = await tool.execute(
			"tc-stream",
			{ maxBytes: 4096, url: "https://example.com/large.txt" },
			undefined,
			() => {}
		);

		const text = result.content[0];
		const details = result.details as {
			totalBytes?: number;
			totalBytesExact?: boolean;
			truncated?: boolean;
		};

		expect(text?.type).toBe("text");
		expect(text?.type === "text" ? text.text : "").toContain(
			"[Truncated: showing 4.0KB of at least"
		);
		expect(details.truncated).toBe(true);
		expect(details.totalBytesExact).toBe(false);
		expect(details.totalBytes).toBeGreaterThanOrEqual(4096);
	});
});
