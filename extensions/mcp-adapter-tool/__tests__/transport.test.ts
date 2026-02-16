import { afterEach, describe, expect, test } from "bun:test";
import { createTransport, type McpTransport } from "../index.js";

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
});
