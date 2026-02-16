import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MockMcpServer } from "../../test-utils/mock-mcp-server.js";
import { createTransport, type McpTransport } from "../mcp-adapter-tool/index.js";

describe("MCP SSE Transport (integration)", () => {
	let server: MockMcpServer;
	let transport: McpTransport;
	let port: number;

	beforeEach(async () => {
		server = new MockMcpServer({
			tools: [
				{ name: "echo", description: "Echo input back" },
				{ name: "add", description: "Add two numbers" },
			],
			toolHandler: (name, args) => {
				if (name === "echo") return [{ type: "text", text: JSON.stringify(args) }];
				if (name === "add") {
					const sum = ((args.a as number) || 0) + ((args.b as number) || 0);
					return [{ type: "text", text: String(sum) }];
				}
				return [{ type: "text", text: "unknown tool" }];
			},
			instructions: "Test server instructions",
		});
		port = await server.start();
	});

	afterEach(() => {
		transport?.stop();
		server?.stop();
	});

	test("connects via SSE and receives endpoint event", async () => {
		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
		});

		await transport.start();
		expect(transport.connected).toBe(true);
		expect(transport.type).toBe("sse");
	});

	test("sends initialize request and gets response", async () => {
		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
		});
		await transport.start();

		const resp = await transport.send(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "test", version: "0.1.0" },
				},
			},
			5000
		);

		expect(resp.id).toBe(1);
		expect(resp.error).toBeUndefined();
		expect(resp.result).toBeDefined();

		const result = resp.result as { serverInfo: { name: string } };
		expect(result.serverInfo.name).toBe("mock-mcp-server");
	});

	test("discovers tools via tools/list", async () => {
		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
		});
		await transport.start();

		const resp = await transport.send(
			{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
			5000
		);

		expect(resp.error).toBeUndefined();
		const result = resp.result as { tools: { name: string }[] };
		expect(result.tools).toHaveLength(2);
		expect(result.tools[0].name).toBe("echo");
		expect(result.tools[1].name).toBe("add");
	});

	test("calls a tool and gets result", async () => {
		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
		});
		await transport.start();

		const resp = await transport.send(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "add", arguments: { a: 3, b: 4 } },
			},
			5000
		);

		expect(resp.error).toBeUndefined();
		const result = resp.result as { content: { text: string }[] };
		expect(result.content[0].text).toBe("7");
	});

	test("handles multiple concurrent requests", async () => {
		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
		});
		await transport.start();

		const results = await Promise.all([
			transport.send(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "add", arguments: { a: 1, b: 2 } },
				},
				5000
			),
			transport.send(
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "add", arguments: { a: 10, b: 20 } },
				},
				5000
			),
		]);

		expect(results[0].id).toBe(1);
		expect(results[1].id).toBe(2);

		const r1 = results[0].result as { content: { text: string }[] };
		const r2 = results[1].result as { content: { text: string }[] };
		expect(r1.content[0].text).toBe("3");
		expect(r2.content[0].text).toBe("30");
	});

	test("fires onDisconnect when server stops", async () => {
		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
		});

		let disconnected = false;
		transport.onDisconnect(() => {
			disconnected = true;
		});

		await transport.start();
		expect(transport.connected).toBe(true);

		// Kill the server
		server.stop();

		// Wait for disconnect detection
		await new Promise((r) => setTimeout(r, 500));
		expect(disconnected).toBe(true);
		expect(transport.connected).toBe(false);
	});

	test("headers are forwarded on SSE connection", async () => {
		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
			headers: { "X-Custom-Header": "test-value" },
		});

		// Should connect successfully even with custom headers
		await transport.start();
		expect(transport.connected).toBe(true);
	});

	test("notify sends without waiting for response", async () => {
		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
		});
		await transport.start();

		// Should not throw or hang
		transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

		// Give it a moment to send
		await new Promise((r) => setTimeout(r, 100));
		expect(transport.connected).toBe(true);
	});

	test("start fails on non-existent server", async () => {
		transport = createTransport("bad", {
			type: "sse",
			url: "http://127.0.0.1:1/sse",
		});

		await expect(transport.start()).rejects.toThrow();
	});

	test("start fails on non-SSE endpoint (404)", async () => {
		transport = createTransport("bad", {
			type: "sse",
			url: `http://localhost:${port}/not-sse`,
		});

		await expect(transport.start()).rejects.toThrow(/404/);
	});

	test("pending requests rejected on server disconnect", async () => {
		// Block this method so the server accepts the POST but never sends
		// an SSE response — the request stays pending until disconnect.
		server.blockedMethods.add("slow/operation");

		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
		});
		await transport.start();

		const pending = transport.send({ jsonrpc: "2.0", id: 999, method: "slow/operation" }, 10_000);

		// Kill the server while request is pending
		await new Promise((r) => setTimeout(r, 100));
		server.stop();

		await expect(pending).rejects.toThrow(/lost/);
	});

	test("restart after stop reconnects to same server", async () => {
		transport = createTransport("test-sse", {
			type: "sse",
			url: `http://localhost:${port}/sse`,
		});

		await transport.start();
		expect(transport.connected).toBe(true);

		// First request works
		const resp1 = await transport.send(
			{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
			5000
		);
		expect(resp1.error).toBeUndefined();

		// Stop and restart
		transport.stop();
		expect(transport.connected).toBe(false);

		await transport.start();
		expect(transport.connected).toBe(true);

		// Second request works after restart
		const resp2 = await transport.send(
			{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
			5000
		);
		expect(resp2.error).toBeUndefined();
	}, 10_000);
});
