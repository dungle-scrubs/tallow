/**
 * Minimal MCP server for integration testing.
 *
 * Supports two transport modes:
 * - **SSE**: GET /sse → endpoint event, POST /messages → response via SSE stream
 * - **Streamable HTTP**: POST /mcp → direct JSON response (with Mcp-Session-Id tracking)
 *
 * @example
 * ```ts
 * const server = new MockMcpServer({
 *   tools: [{ name: "echo", description: "Echo input" }],
 *   toolHandler: (_name, args) => [{ type: "text", text: JSON.stringify(args) }],
 * });
 * const port = await server.start();
 * // SSE: connect to http://localhost:${port}/sse
 * // Streamable HTTP: POST to http://localhost:${port}/mcp
 * server.stop();
 * ```
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** MCP tool definition for the mock server. */
interface MockTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** Content item returned by tool handlers. */
interface MockContentItem {
	type: string;
	text?: string;
	[key: string]: unknown;
}

/** Configuration for the mock MCP server. */
export interface MockMcpServerOptions {
	/** Tools to advertise via tools/list. */
	tools?: MockTool[];
	/** Handler for tools/call. Returns content items. */
	toolHandler?: (toolName: string, args: Record<string, unknown>) => MockContentItem[];
	/** Server instructions to return in initialize response. */
	instructions?: string;
	/**
	 * Force a specific HTTP status for the next N POST responses.
	 * Used to test retry/error handling. Cleared after use.
	 */
	forceStatus?: { code: number; count: number };
}

/**
 * Minimal HTTP server implementing MCP SSE and Streamable HTTP transports.
 * Designed for integration testing — not production use.
 */
export class MockMcpServer {
	private server: Server | null = null;
	private sseClients: Set<ServerResponse> = new Set();
	private tools: MockTool[];
	private toolHandler: (name: string, args: Record<string, unknown>) => MockContentItem[];
	private instructions?: string;
	private sessionId = "mock-session-001";
	/** Force HTTP status codes for testing error/retry behavior. */
	forceStatus: { code: number; count: number } | null = null;
	/**
	 * Methods in this set will be accepted (POST returns 202) but never
	 * responded to via SSE. The request stays pending indefinitely.
	 * Useful for testing disconnect-while-pending behavior.
	 */
	blockedMethods: Set<string> = new Set();

	/** @param options - Server configuration */
	constructor(options: MockMcpServerOptions = {}) {
		this.tools = options.tools ?? [];
		this.toolHandler = options.toolHandler ?? (() => [{ type: "text", text: "ok" }]);
		this.instructions = options.instructions;
		if (options.forceStatus) this.forceStatus = options.forceStatus;
	}

	/**
	 * Starts the server on a random available port.
	 * @returns The port number the server is listening on
	 */
	start(): Promise<number> {
		return new Promise((resolve) => {
			this.server = createServer((req, res) => this.handleRequest(req, res));
			this.server.listen(0, () => {
				const addr = this.server?.address();
				const port = typeof addr === "object" && addr ? addr.port : 0;
				resolve(port);
			});
		});
	}

	/** Stops the server and closes all SSE connections. */
	stop(): void {
		for (const client of this.sseClients) {
			client.end();
		}
		this.sseClients.clear();
		this.server?.close();
		this.server = null;
	}

	/**
	 * Routes incoming HTTP requests to SSE or JSON-RPC handlers.
	 * @param req - Incoming HTTP request
	 * @param res - Server response
	 */
	private handleRequest(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url || "/", `http://localhost`);

		if (req.method === "GET" && url.pathname === "/sse") {
			this.handleSse(res);
		} else if (req.method === "POST" && url.pathname === "/messages") {
			this.handlePost(req, res);
		} else if (req.method === "POST" && url.pathname === "/mcp") {
			this.handleStreamableHttp(req, res);
		} else {
			res.writeHead(404);
			res.end("Not Found");
		}
	}

	/**
	 * Handles SSE connection: sends endpoint event and keeps stream open.
	 * @param res - Server response (SSE stream)
	 */
	private handleSse(res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		// Send endpoint event with the POST URL
		const addr = this.server?.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		res.write(`event: endpoint\ndata: http://localhost:${port}/messages\n\n`);

		this.sseClients.add(res);
		res.on("close", () => this.sseClients.delete(res));
	}

	/**
	 * Handles POST JSON-RPC requests and sends responses via SSE.
	 * @param req - Incoming HTTP request
	 * @param res - Server response
	 */
	private handlePost(req: IncomingMessage, res: ServerResponse): void {
		let body = "";
		req.on("data", (chunk: string) => {
			body += chunk;
		});
		req.on("end", () => {
			try {
				const rpc = JSON.parse(body);
				const response = this.handleRpc(rpc);

				// Send response via SSE unless method is blocked
				if (!this.blockedMethods.has(rpc.method)) {
					const sseData = JSON.stringify(response);
					for (const client of this.sseClients) {
						client.write(`event: message\ndata: ${sseData}\n\n`);
					}
				}

				res.writeHead(202);
				res.end();
			} catch {
				res.writeHead(400);
				res.end("Bad Request");
			}
		});
	}

	/**
	 * Handles Streamable HTTP requests: responds with direct JSON and
	 * Mcp-Session-Id header. Supports forceStatus for error testing.
	 *
	 * @param req - Incoming HTTP request
	 * @param res - Server response
	 */
	private handleStreamableHttp(req: IncomingMessage, res: ServerResponse): void {
		// Check forceStatus first
		if (this.forceStatus && this.forceStatus.count > 0) {
			this.forceStatus.count--;
			res.writeHead(this.forceStatus.code);
			res.end(`Forced ${this.forceStatus.code}`);
			if (this.forceStatus.count === 0) this.forceStatus = null;
			return;
		}

		let body = "";
		req.on("data", (chunk: string) => {
			body += chunk;
		});
		req.on("end", () => {
			try {
				const rpc = JSON.parse(body);
				const response = this.handleRpc(rpc);

				res.writeHead(200, {
					"Content-Type": "application/json",
					"Mcp-Session-Id": this.sessionId,
				});
				res.end(JSON.stringify(response));
			} catch {
				res.writeHead(400);
				res.end("Bad Request");
			}
		});
	}

	/**
	 * Dispatches a JSON-RPC request to the appropriate handler.
	 * @param rpc - Parsed JSON-RPC request
	 * @returns JSON-RPC response
	 */
	private handleRpc(rpc: { id: number; method: string; params?: Record<string, unknown> }): {
		jsonrpc: "2.0";
		id: number;
		result?: unknown;
		error?: unknown;
	} {
		switch (rpc.method) {
			case "initialize":
				return {
					jsonrpc: "2.0",
					id: rpc.id,
					result: {
						protocolVersion: "2024-11-05",
						capabilities: {},
						serverInfo: { name: "mock-mcp-server", version: "0.1.0" },
						...(this.instructions ? { instructions: this.instructions } : {}),
					},
				};

			case "tools/list":
				return {
					jsonrpc: "2.0",
					id: rpc.id,
					result: { tools: this.tools },
				};

			case "tools/call": {
				const params = rpc.params ?? {};
				const name = params.name as string;
				const args = (params.arguments ?? {}) as Record<string, unknown>;
				try {
					const content = this.toolHandler(name, args);
					return {
						jsonrpc: "2.0",
						id: rpc.id,
						result: { content, isError: false },
					};
				} catch (err) {
					return {
						jsonrpc: "2.0",
						id: rpc.id,
						result: {
							content: [{ type: "text", text: String(err) }],
							isError: true,
						},
					};
				}
			}

			default:
				return {
					jsonrpc: "2.0",
					id: rpc.id,
					error: { code: -32601, message: `Method not found: ${rpc.method}` },
				};
		}
	}
}
