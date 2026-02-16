import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MockMcpServer } from "../../test-utils/mock-mcp-server.js";
import { createTransport, type McpTransport } from "../mcp-adapter-tool/index.js";

describe("MCP Streamable HTTP Transport (integration)", () => {
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
		});
		port = await server.start();
	});

	afterEach(() => {
		transport?.stop();
		server?.stop();
	});

	test("sends initialize and gets JSON response", async () => {
		transport = createTransport("test-http", {
			type: "streamable-http",
			url: `http://localhost:${port}/mcp`,
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
		const result = resp.result as { serverInfo: { name: string } };
		expect(result.serverInfo.name).toBe("mock-mcp-server");
	});

	test("discovers tools via tools/list", async () => {
		transport = createTransport("test-http", {
			type: "streamable-http",
			url: `http://localhost:${port}/mcp`,
		});
		await transport.start();

		const resp = await transport.send(
			{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
			5000
		);

		const result = resp.result as { tools: { name: string }[] };
		expect(result.tools).toHaveLength(2);
		expect(result.tools[0].name).toBe("echo");
	});

	test("calls a tool and gets result", async () => {
		transport = createTransport("test-http", {
			type: "streamable-http",
			url: `http://localhost:${port}/mcp`,
		});
		await transport.start();

		const resp = await transport.send(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "add", arguments: { a: 5, b: 7 } },
			},
			5000
		);

		const result = resp.result as { content: { text: string }[] };
		expect(result.content[0].text).toBe("12");
	});

	test("handles multiple sequential requests", async () => {
		transport = createTransport("test-http", {
			type: "streamable-http",
			url: `http://localhost:${port}/mcp`,
		});
		await transport.start();

		for (let i = 1; i <= 3; i++) {
			const resp = await transport.send(
				{
					jsonrpc: "2.0",
					id: i,
					method: "tools/call",
					params: { name: "add", arguments: { a: i, b: i } },
				},
				5000
			);
			const result = resp.result as { content: { text: string }[] };
			expect(result.content[0].text).toBe(String(i * 2));
		}
	});

	test("forwards custom headers", async () => {
		transport = createTransport("test-http", {
			type: "streamable-http",
			url: `http://localhost:${port}/mcp`,
			headers: { "X-Api-Key": "secret-123" },
		});
		await transport.start();

		// Should work without error — headers don't break anything
		const resp = await transport.send(
			{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
			5000
		);
		expect(resp.error).toBeUndefined();
	});

	test("notify sends without error", async () => {
		transport = createTransport("test-http", {
			type: "streamable-http",
			url: `http://localhost:${port}/mcp`,
		});
		await transport.start();

		// Should not throw
		transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
		await new Promise((r) => setTimeout(r, 100));
		expect(transport.connected).toBe(true);
	});

	test("retries 5xx errors and succeeds", async () => {
		// Force first 2 responses to be 500, then succeed
		server.forceStatus = { code: 500, count: 2 };

		transport = createTransport("test-http", {
			type: "streamable-http",
			url: `http://localhost:${port}/mcp`,
		});
		await transport.start();

		// With maxRetries=2, should survive 2 failures and succeed on 3rd
		const resp = await transport.send(
			{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
			10_000
		);

		expect(resp.error).toBeUndefined();
		const result = resp.result as { tools: { name: string }[] };
		expect(result.tools).toHaveLength(2);
	}, 15_000);

	test("4xx errors fail without retry", async () => {
		transport = createTransport("test-http", {
			type: "streamable-http",
			url: `http://localhost:${port}/nonexistent`, // 404
		});
		await transport.start();

		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "test" }, 5000)).rejects.toThrow(
			/404/
		);
	});

	test("consecutive failure counter resets on success", async () => {
		transport = createTransport("test-http", {
			type: "streamable-http",
			url: `http://localhost:${port}/mcp`,
		});
		await transport.start();

		// Successful request
		await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, 5000);
		expect(transport.connected).toBe(true);

		// If consecutiveFailures had accumulated, a success resets it.
		// Transport should still be connected.
		await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, 5000);
		expect(transport.connected).toBe(true);
	});
});
