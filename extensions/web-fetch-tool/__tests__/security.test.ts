import { afterEach, describe, expect, test } from "bun:test";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import webFetchExtension, { isBlockedIpAddress, validateFetchUrl } from "../index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("validateFetchUrl", () => {
	test("blocks localhost hostnames", async () => {
		const result = await validateFetchUrl("http://localhost:3000");
		expect(result).toEqual({ ok: false, reason: "blocked local hostname: localhost" });
	});

	test("blocks private IP literals", async () => {
		expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
		expect(isBlockedIpAddress("10.0.0.42")).toBe(true);
		expect(isBlockedIpAddress("192.168.1.10")).toBe(true);
		expect(isBlockedIpAddress("::1")).toBe(true);
		expect(isBlockedIpAddress("fe80::1")).toBe(true);
		expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
	});

	test("blocks hostnames that resolve to private addresses", async () => {
		const result = await validateFetchUrl("https://example.com", async () => ["127.0.0.1"]);
		expect(result).toEqual({
			ok: false,
			reason: "hostname resolved to blocked private IP address: 127.0.0.1",
		});
	});

	test("blocks credentialed URLs", async () => {
		const result = await validateFetchUrl("https://user:pass@example.com");
		expect(result).toEqual({ ok: false, reason: "credentialed URLs are not allowed" });
	});

	test("blocks unsupported protocols", async () => {
		const result = await validateFetchUrl("file:///tmp/test.txt");
		expect(result).toEqual({ ok: false, reason: "unsupported protocol: file:" });
	});
});

describe("web_fetch security enforcement", () => {
	test("returns an error before fetch for blocked private URLs", async () => {
		const harness = ExtensionHarness.create();
		let fetchCalled = false;
		globalThis.fetch = async () => {
			fetchCalled = true;
			return new Response("should not run");
		};

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const result = await tool.execute(
			"tc-blocked",
			{ url: "http://localhost:3000/admin" },
			undefined,
			() => {}
		);

		expect(fetchCalled).toBe(false);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Blocked URL: blocked local hostname: localhost",
		});
		expect(result.details).toMatchObject({ isError: true });
	});
});
