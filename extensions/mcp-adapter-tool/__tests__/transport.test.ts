import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTransport, type McpTransport } from "../index.js";

/**
 * Builds an open-ended SSE response stream with optional initial events.
 *
 * @param events - Preloaded SSE event payloads to enqueue
 * @returns Response with text/event-stream content type
 */
function createSseResponse(events: string[] = []): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(event));
			}
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

/**
 * Waits one macrotask turn to allow async callbacks to run.
 *
 * @returns Promise resolved on next tick
 */
async function nextTick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("StdioTransport", () => {
	let transport: McpTransport;

	afterEach(() => {
		transport?.stop();
	});

	test("starts and connects with a valid process", async () => {
		transport = createTransport("test", { command: "cat" });
		expect(transport.connected).toBe(false);
		await transport.start();
		expect(transport.connected).toBe(true);
	});

	test("stop kills process and rejects pending requests", async () => {
		transport = createTransport("test", { command: "cat" });
		await transport.start();
		expect(transport.connected).toBe(true);

		transport.stop();
		expect(transport.connected).toBe(false);
	});

	test("send/receive cycle resolves with matching ID", async () => {
		// 'cat' echoes stdin to stdout — a valid JSON-RPC line written to stdin
		// comes back on stdout and resolves the pending request.
		transport = createTransport("test", { command: "cat" });
		await transport.start();

		const resp = await transport.send(
			{ jsonrpc: "2.0", id: 42, method: "echo", params: { foo: "bar" } },
			2000
		);

		// cat echoes the request verbatim — it becomes the "response"
		expect(resp.id).toBe(42);
		expect(resp.method).toBe("echo");
	});

	test("send rejects when not started", async () => {
		transport = createTransport("test", { command: "cat" });
		// Don't call start()
		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "test" }, 500)).rejects.toThrow(
			/not running/
		);
	});

	test("send times out with unresponsive process", async () => {
		transport = createTransport("test", { command: "sleep", args: ["60"] });
		await transport.start();

		const sendPromise = transport.send({ jsonrpc: "2.0", id: 1, method: "test" }, 500);

		await expect(sendPromise).rejects.toThrow(/timed out/);
	});

	test("connected becomes false when process exits", async () => {
		transport = createTransport("test", { command: "echo", args: [""] });
		await transport.start();

		// echo exits immediately
		await new Promise((r) => setTimeout(r, 100));
		expect(transport.connected).toBe(false);
	});

	test("pending requests rejected when process exits", async () => {
		transport = createTransport("test", {
			command: "sh",
			args: ["-c", "sleep 0.2 && exit 1"],
		});
		await transport.start();

		// Send a request, then the process will die before responding
		const promise = transport.send({ jsonrpc: "2.0", id: 1, method: "slow" }, 5000);

		await expect(promise).rejects.toThrow(/exited/);
	});

	test("can restart after stop", async () => {
		transport = createTransport("test", { command: "cat" });
		await transport.start();
		expect(transport.connected).toBe(true);

		transport.stop();
		expect(transport.connected).toBe(false);

		await transport.start();
		expect(transport.connected).toBe(true);
	});

	test("notify does not throw on connected transport", async () => {
		transport = createTransport("test", { command: "cat" });
		await transport.start();
		transport.notify({ jsonrpc: "2.0", method: "test/ping" });
	});

	test("onNotification fires for server-initiated messages", async () => {
		// Use a script that writes a JSON-RPC notification to stdout
		transport = createTransport("test", {
			command: "sh",
			args: [
				"-c",
				'echo \'{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\' && sleep 5',
			],
		});

		let receivedMethod: string | null = null;
		transport.onNotification((method) => {
			receivedMethod = method;
		});

		await transport.start();
		await new Promise((r) => setTimeout(r, 200));

		expect(receivedMethod).toBe("notifications/tools/list_changed");
	});

	test("onDisconnect fires when process exits unexpectedly", async () => {
		transport = createTransport("test", {
			command: "sh",
			args: ["-c", "sleep 0.1 && exit 1"],
		});

		let disconnected = false;
		transport.onDisconnect(() => {
			disconnected = true;
		});

		await transport.start();
		expect(transport.connected).toBe(true);

		await new Promise((r) => setTimeout(r, 300));
		expect(disconnected).toBe(true);
		expect(transport.connected).toBe(false);
	});
});

describe("StreamableHttpTransport", () => {
	test("start sets connected, stop clears it", async () => {
		const transport = createTransport("api", {
			type: "streamable-http",
			url: "http://localhost:9999/mcp",
		});

		expect(transport.connected).toBe(false);
		await transport.start();
		expect(transport.connected).toBe(true);
		transport.stop();
		expect(transport.connected).toBe(false);
	});

	test("can restart after stop", async () => {
		const transport = createTransport("api", {
			type: "streamable-http",
			url: "http://localhost:9999/mcp",
		});

		await transport.start();
		transport.stop();
		await transport.start();
		expect(transport.connected).toBe(true);
		transport.stop();
	});

	test("send rejects when not connected", async () => {
		const transport = createTransport("api", {
			type: "streamable-http",
			url: "http://localhost:9999/mcp",
		});

		// Don't call start()
		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "test" }, 500)).rejects.toThrow();
	});
});

describe("SseTransport", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("send rejects when not connected", async () => {
		const transport = createTransport("remote", {
			type: "sse",
			url: "http://localhost:9999/sse",
		});

		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "test" }, 500)).rejects.toThrow(
			/not connected/
		);
	});

	test("stop is safe to call when not started", () => {
		const transport = createTransport("remote", {
			type: "sse",
			url: "http://localhost:9999/sse",
		});

		// Should not throw
		transport.stop();
		expect(transport.connected).toBe(false);
	});

	test("timed-out request aborts in-flight SSE POST and clears pending state", async () => {
		let postAborted = false;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/sse")) {
				return createSseResponse(["event: endpoint\ndata: /mcp\n\n"]);
			}
			if (url.endsWith("/mcp")) {
				const signal = init?.signal;
				signal?.addEventListener(
					"abort",
					() => {
						postAborted = true;
					},
					{ once: true }
				);
				return new Promise<Response>(() => {});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as typeof fetch;

		const transport = createTransport("remote", {
			type: "sse",
			url: "http://localhost:9999/sse",
		});
		await transport.start();

		await expect(
			transport.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} }, 25)
		).rejects.toThrow(/timed out/);

		expect(postAborted).toBe(true);
		expect(
			(transport as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.size
		).toBe(0);
		transport.stop();
	});

	test("stop aborts stream fetch and all in-flight requests", async () => {
		let streamAborted = false;
		let postAbortCount = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/sse")) {
				init?.signal?.addEventListener(
					"abort",
					() => {
						streamAborted = true;
					},
					{ once: true }
				);
				return createSseResponse(["event: endpoint\ndata: /mcp\n\n"]);
			}
			if (url.endsWith("/mcp")) {
				init?.signal?.addEventListener(
					"abort",
					() => {
						postAbortCount++;
					},
					{ once: true }
				);
				return new Promise<Response>(() => {});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as typeof fetch;

		const transport = createTransport("remote", {
			type: "sse",
			url: "http://localhost:9999/sse",
		});
		await transport.start();

		const req1 = transport.send({ jsonrpc: "2.0", id: 11, method: "tools/call" }, 10_000);
		const req2 = transport.send({ jsonrpc: "2.0", id: 12, method: "tools/call" }, 10_000);
		await nextTick();

		expect(
			(transport as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.size
		).toBe(2);

		transport.stop();
		const results = await Promise.allSettled([req1, req2]);

		for (const result of results) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(String(result.reason)).toContain("Transport stopped");
			}
		}

		expect(streamAborted).toBe(true);
		expect(postAbortCount).toBe(2);
		expect(
			(transport as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.size
		).toBe(0);
		expect(
			(transport as unknown as { pendingRequestControllers: Map<number, AbortController> })
				.pendingRequestControllers.size
		).toBe(0);
	});

	test("endpoint wait timeout aborts connection setup", async () => {
		let streamAborted = false;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/sse")) {
				init?.signal?.addEventListener(
					"abort",
					() => {
						streamAborted = true;
					},
					{ once: true }
				);
				return createSseResponse();
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as typeof fetch;

		const transport = createTransport("remote", {
			type: "sse",
			url: "http://localhost:9999/sse",
		});
		(transport as unknown as { endpointWaitTimeoutMs: number }).endpointWaitTimeoutMs = 25;

		await expect(transport.start()).rejects.toThrow(/timeout waiting for SSE endpoint event/);
		expect(streamAborted).toBe(true);
		expect(transport.connected).toBe(false);
		transport.stop();
	});

	test("successful request/response flow still works", async () => {
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/sse")) {
				return createSseResponse(["event: endpoint\ndata: /mcp\n\n"]);
			}
			if (url.endsWith("/mcp")) {
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: 42, result: { ok: true } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as typeof fetch;

		const transport = createTransport("remote", {
			type: "sse",
			url: "http://localhost:9999/sse",
		});
		await transport.start();

		const response = await transport.send({ jsonrpc: "2.0", id: 42, method: "tools/list" }, 1_000);
		expect(response.id).toBe(42);
		expect(response.result).toEqual({ ok: true });
		expect(
			(transport as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.size
		).toBe(0);
		transport.stop();
	});
});
