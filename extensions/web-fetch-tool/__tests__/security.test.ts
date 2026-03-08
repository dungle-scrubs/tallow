import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import webFetchExtension, {
	isBlockedIpAddress,
	performPinnedDirectHttpRequest,
	setDirectHttpRequestImplForTests,
	validateFetchUrl,
} from "../index.js";

afterEach(() => {
	setDirectHttpRequestImplForTests(undefined);
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

describe("pinned direct HTTP requests", () => {
	test("uses the validated IP while preserving the original Host header", async () => {
		let observedHost = "";
		let observedPath = "";
		const server = createServer((req, res) => {
			observedHost = req.headers.host ?? "";
			observedPath = req.url ?? "";
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("ok");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server address missing");

			const result = await performPinnedDirectHttpRequest(
				{
					ok: true,
					resolvedAddresses: ["127.0.0.1"],
					url: new URL(`http://example.com:${address.port}/pinned`),
				},
				undefined
			);
			const text = await result.response.text();

			expect(text).toBe("ok");
			expect(result.pinnedAddress).toBe("127.0.0.1");
			expect(result.url).toBe(`http://example.com:${address.port}/pinned`);
			expect(observedHost).toBe(`example.com:${address.port}`);
			expect(observedPath).toBe("/pinned");
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		}
	});
});

describe("web_fetch security enforcement", () => {
	test("returns an error before fetch for blocked private URLs", async () => {
		const harness = ExtensionHarness.create();
		let requestCalled = false;
		setDirectHttpRequestImplForTests(async (validation) => {
			requestCalled = true;
			return {
				response: new Response("should not run"),
				url: validation.url.toString(),
			};
		});

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const result = await tool.execute(
			"tc-blocked",
			{ url: "http://localhost:3000/admin" },
			undefined,
			() => {}
		);

		expect(requestCalled).toBe(false);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Blocked URL: blocked local hostname: localhost",
		});
		expect(result.details).toMatchObject({ isError: true });
	});

	test("reports redirect telemetry for successful redirect chains", async () => {
		const harness = ExtensionHarness.create();
		let requestCalls = 0;
		setDirectHttpRequestImplForTests(async (validation) => {
			requestCalls += 1;
			if (requestCalls === 1) {
				return {
					pinnedAddress: "93.184.216.34",
					response: new Response("", {
						headers: { location: "https://example.com/final" },
						status: 301,
					}),
					url: validation.url.toString(),
				};
			}
			return {
				pinnedAddress: "93.184.216.35",
				response: new Response("ok", {
					headers: { "content-type": "text/plain" },
					status: 200,
				}),
				url: validation.url.toString(),
			};
		});

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const result = await tool.execute(
			"tc-redirect-success",
			{ url: "https://example.com/start" },
			undefined,
			() => {}
		);

		expect(requestCalls).toBe(2);
		expect(result.details).toMatchObject({
			pinnedAddress: "93.184.216.35",
			redirectChain: [
				{
					fromUrl: "https://example.com/start",
					pinnedAddress: "93.184.216.34",
					status: 301,
					toUrl: "https://example.com/final",
				},
			],
			redirectCount: 1,
			status: 200,
			url: "https://example.com/final",
		});
	});

	test("blocks redirect targets that jump to localhost", async () => {
		const harness = ExtensionHarness.create();
		let requestCalls = 0;
		setDirectHttpRequestImplForTests(async (validation) => {
			requestCalls += 1;
			return {
				pinnedAddress: "93.184.216.34",
				response: new Response("", {
					headers: { location: "http://localhost:3000/admin" },
					status: 302,
				}),
				url: validation.url.toString(),
			};
		});

		await harness.loadExtension(webFetchExtension);
		const tool = harness.tools.get("web_fetch");
		if (!tool) throw new Error("web_fetch tool missing");

		const result = await tool.execute(
			"tc-redirect",
			{ url: "https://example.com/start" },
			undefined,
			() => {}
		);
		const text = result.content[0];

		expect(requestCalls).toBe(1);
		expect(text).toEqual({
			type: "text",
			text: "Blocked redirect target: blocked local hostname: localhost",
		});
		expect(result.details).toMatchObject({
			isError: true,
			pinnedAddress: "93.184.216.34",
			redirectChain: [
				{
					fromUrl: "https://example.com/start",
					pinnedAddress: "93.184.216.34",
					status: 302,
					toUrl: "http://localhost:3000/admin",
				},
			],
			redirectCount: 1,
			status: 302,
			url: "http://localhost:3000/admin",
		});
	});
});
