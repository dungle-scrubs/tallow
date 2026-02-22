/**
 * MCP Adapter Extension
 *
 * Drop-in support for standard MCP servers via STDIO, SSE, or Streamable
 * HTTP transport. Declare servers in settings.json, tallow connects to them,
 * discovers their tools, and registers them as mcp__<server>__<tool>.
 *
 * STDIO servers are spawned as child processes. SSE and Streamable HTTP
 * servers connect to remote endpoints. Network transports support
 * auto-reconnect with exponential backoff.
 *
 * Configuration in .tallow/settings.json or ~/.tallow/settings.json:
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
 *     },
 *     "remote-tools": {
 *       "type": "sse",
 *       "url": "http://localhost:3100/sse",
 *       "headers": { "Authorization": "Bearer xxx" }
 *     },
 *     "api-server": {
 *       "type": "streamable-http",
 *       "url": "http://api.example.com/mcp",
 *       "headers": {}
 *     }
 *   }
 * }
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import { createLazyInitializer, type LazyInitInput } from "../_shared/lazy-init.js";
import {
	getProjectSettingsTrustDecision,
	type ProjectTrustStatus,
} from "../_shared/project-trust.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Converts an unknown thrown value into an Error instance.
 *
 * @param value - Unknown thrown value
 * @returns Error instance with best-effort message
 */
function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

// ── Config Types ─────────────────────────────────────────────────────────────

/** STDIO MCP server config. No `type` field or `type: "stdio"`. */
export interface McpStdioConfig {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

/** SSE MCP server config. Connects via Server-Sent Events. */
export interface McpSseConfig {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** Streamable HTTP MCP server config (2025-03-26 spec). */
export interface McpStreamableHttpConfig {
	type: "streamable-http";
	url: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** MCP server configuration — discriminated by `type`. */
export type McpServerConfig = McpStdioConfig | McpSseConfig | McpStreamableHttpConfig;

// ── JSON-RPC Types ───────────────────────────────────────────────────────────

/** JSON-RPC 2.0 request. */
interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response. */
interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification (no response expected). */
interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

// ── MCP Types ────────────────────────────────────────────────────────────────

/** MCP tool definition from tools/list response. */
interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** MCP tool call result content item (supports structured content types). */
export interface McpContentItem {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	/** Resource link URI (for resource_link content type). */
	uri?: string;
	/** Human-readable description of the resource. */
	description?: string;
	/** Resource reference with URI and optional MIME type. */
	resource?: { uri: string; mimeType?: string; text?: string };
	/** Annotations providing semantic metadata about the content. */
	annotations?: Record<string, unknown>;
}

/** Pending JSON-RPC request tracker. */
interface PendingRequest {
	resolve: (value: JsonRpcResponse) => void;
	reject: (reason: Error) => void;
}

// ── Transport Interface ──────────────────────────────────────────────────────

/**
 * Transport abstraction for MCP server communication.
 * Implementations handle the wire protocol; the server lifecycle layer
 * handles MCP handshake, tool discovery, and reconnect policy.
 */
export interface McpTransport {
	/** Transport type identifier. */
	readonly type: "stdio" | "sse" | "streamable-http";
	/** Whether the transport is currently connected. */
	readonly connected: boolean;
	/** Start the transport (spawn process / open connection). Safe to call again after stop(). */
	start(): Promise<void>;
	/** Stop the transport (kill process / close connection). */
	stop(): void;
	/** Send a JSON-RPC request and return the response. */
	send(request: JsonRpcRequest, timeoutMs?: number): Promise<JsonRpcResponse>;
	/** Send a JSON-RPC notification (no response expected). */
	notify(notification: JsonRpcNotification): void;
	/** Register handler for server-initiated notifications. */
	onNotification(handler: (method: string, params?: unknown) => void): void;
	/** Register handler for unexpected disconnection. */
	onDisconnect(handler: () => void): void;
}

// ── STDIO Transport ──────────────────────────────────────────────────────────

/**
 * STDIO transport — spawns a child process and communicates via stdin/stdout
 * JSON-RPC. Tracks consecutive timeouts and auto-kills the process at 3.
 */
class StdioTransport implements McpTransport {
	readonly type = "stdio" as const;
	private process: ChildProcess | null = null;
	private pendingRequests = new Map<number, PendingRequest>();
	private buffer = "";
	private timeoutCount = 0;
	private _connected = false;
	private disconnectHandler?: () => void;
	private notificationHandler?: (method: string, params?: unknown) => void;

	/**
	 * @param name - Server name (for error messages)
	 * @param config - STDIO server configuration
	 */
	constructor(
		private readonly name: string,
		private readonly config: McpStdioConfig
	) {}

	get connected(): boolean {
		return this._connected;
	}

	/**
	 * Spawns the child process and wires up stdout/stderr handling.
	 * @throws Error if the process fails to start
	 */
	async start(): Promise<void> {
		if (this.process) {
			this.process.kill("SIGTERM");
			this.process = null;
		}
		this.pendingRequests.clear();
		this.buffer = "";
		this.timeoutCount = 0;

		const env = { ...process.env, ...(this.config.env || {}) };
		this.process = spawn(this.config.command, this.config.args || [], {
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});

		this.process.stdout?.setEncoding("utf-8");
		this.process.stdout?.on("data", (chunk: string) => this.handleData(chunk));
		this.process.stderr?.setEncoding("utf-8");
		this.process.stderr?.on("data", () => {}); // Swallow stderr

		this.process.on("close", (code) => {
			for (const [, pending] of this.pendingRequests) {
				pending.reject(new Error(`Server ${this.name} exited with code ${code}`));
			}
			this.pendingRequests.clear();
			this.process = null;
			const wasConnected = this._connected;
			this._connected = false;
			if (wasConnected) this.disconnectHandler?.();
		});

		this._connected = true;
	}

	/** Kills the child process and rejects all pending requests. */
	stop(): void {
		if (this.process) {
			this.process.kill("SIGTERM");
			this.process = null;
		}
		this._connected = false;
		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error("Transport stopped"));
		}
		this.pendingRequests.clear();
	}

	/**
	 * Sends a JSON-RPC request via stdin and waits for the response on stdout.
	 * Auto-kills the process after 3 consecutive timeouts.
	 *
	 * @param request - JSON-RPC request to send
	 * @param timeoutMs - Request timeout in milliseconds (default: 30s)
	 * @returns JSON-RPC response
	 * @throws Error on timeout, process crash, or write failure
	 */
	send(request: JsonRpcRequest, timeoutMs = 30_000): Promise<JsonRpcResponse> {
		return new Promise((resolve, reject) => {
			if (!this._connected || !this.process?.stdin) {
				reject(new Error(`Server ${this.name} is not running`));
				return;
			}

			const timer = setTimeout(() => {
				this.pendingRequests.delete(request.id);
				this.timeoutCount++;
				if (this.timeoutCount >= 3 && this.process) {
					this.process.kill("SIGTERM");
					this.process = null;
					this._connected = false;
				}
				const hint =
					this.timeoutCount >= 3
						? " Server killed after repeated failures."
						: ` (${this.timeoutCount}/3 before auto-kill)`;
				reject(
					new Error(
						`MCP server "${this.name}" unresponsive — ${request.method} timed out after ${Math.round(timeoutMs / 1000)}s.${hint}`
					)
				);
			}, timeoutMs);

			this.pendingRequests.set(request.id, {
				resolve: (res) => {
					clearTimeout(timer);
					this.timeoutCount = 0;
					resolve(res);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});

			try {
				this.process.stdin.write(`${JSON.stringify(request)}\n`);
			} catch {
				this.pendingRequests.delete(request.id);
				clearTimeout(timer);
				reject(
					new Error(`MCP server "${this.name}" stdin write failed — process may have crashed`)
				);
			}
		});
	}

	/**
	 * Sends a JSON-RPC notification via stdin (fire-and-forget).
	 * @param notification - Notification to send
	 */
	notify(notification: JsonRpcNotification): void {
		if (this._connected && this.process?.stdin) {
			try {
				this.process.stdin.write(`${JSON.stringify(notification)}\n`);
			} catch {
				/* Process may have crashed between guard and write — ignore for fire-and-forget */
			}
		}
	}

	/** @param handler - Callback for server-initiated notifications */
	onNotification(handler: (method: string, params?: unknown) => void): void {
		this.notificationHandler = handler;
	}

	/** @param handler - Callback for unexpected disconnection */
	onDisconnect(handler: () => void): void {
		this.disconnectHandler = handler;
	}

	/**
	 * Buffers stdout data and dispatches complete JSON-RPC messages.
	 * @param chunk - Raw data chunk from stdout
	 */
	private handleData(chunk: string): void {
		this.buffer += chunk;
		let idx = this.buffer.indexOf("\n");
		while (idx !== -1) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (line) {
				try {
					const msg = JSON.parse(line) as JsonRpcResponse;
					if (msg.id != null && this.pendingRequests.has(msg.id)) {
						const pending = this.pendingRequests.get(msg.id);
						if (!pending) continue;
						this.pendingRequests.delete(msg.id);
						pending.resolve(msg);
					} else if ((msg as unknown as JsonRpcNotification).method && msg.id == null) {
						const notif = msg as unknown as JsonRpcNotification;
						this.notificationHandler?.(notif.method, notif.params);
					}
				} catch {
					// Ignore non-JSON lines
				}
			}
			idx = this.buffer.indexOf("\n");
		}
	}
}

// ── SSE Transport ────────────────────────────────────────────────────────────

/**
 * SSE transport — connects to an MCP server via Server-Sent Events.
 * Client GETs the SSE endpoint, receives an `endpoint` event with a POST
 * URL, then sends JSON-RPC requests via POST and receives responses as
 * `message` events on the SSE stream.
 */
class SseTransport implements McpTransport {
	readonly type = "sse" as const;
	private postUrl: string | null = null;
	private abortController: AbortController | null = null;
	private pendingRequests = new Map<number, PendingRequest>();
	private pendingRequestControllers = new Map<number, AbortController>();
	private _connected = false;
	private stopping = false;
	private endpointResolver?: (url: string) => void;
	private endpointRejecter?: (reason: Error) => void;
	private endpointWaitTimer: ReturnType<typeof setTimeout> | null = null;
	/** Endpoint wait timeout. Mutable for tests. */
	private endpointWaitTimeoutMs = 10_000;
	private disconnectHandler?: () => void;
	private notificationHandler?: (method: string, params?: unknown) => void;

	/**
	 * @param name - Server name (for error messages)
	 * @param config - SSE server configuration
	 */
	constructor(
		private readonly name: string,
		private readonly config: McpSseConfig
	) {}

	get connected(): boolean {
		return this._connected;
	}

	/**
	 * Clears endpoint-wait timeout and resolver/rejecter handlers.
	 *
	 * @returns void
	 */
	private clearEndpointWaitState(): void {
		if (this.endpointWaitTimer) {
			clearTimeout(this.endpointWaitTimer);
			this.endpointWaitTimer = null;
		}
		this.endpointResolver = undefined;
		this.endpointRejecter = undefined;
	}

	/**
	 * Rejects the pending endpoint wait promise, if one exists.
	 *
	 * @param reason - Rejection reason for the endpoint wait promise
	 * @returns void
	 */
	private rejectEndpointWait(reason: Error): void {
		const rejecter = this.endpointRejecter;
		this.clearEndpointWaitState();
		rejecter?.(reason);
	}

	/**
	 * Resolves a pending request and removes all request bookkeeping.
	 *
	 * @param requestId - JSON-RPC request ID
	 * @param response - JSON-RPC response payload
	 * @returns True if a pending request was resolved
	 */
	private resolvePendingRequest(requestId: number, response: JsonRpcResponse): boolean {
		const pending = this.pendingRequests.get(requestId);
		if (!pending) return false;
		this.pendingRequests.delete(requestId);
		this.pendingRequestControllers.delete(requestId);
		pending.resolve(response);
		return true;
	}

	/**
	 * Rejects a pending request, optionally aborting the underlying network request.
	 *
	 * @param requestId - JSON-RPC request ID
	 * @param reason - Rejection reason
	 * @param abortRequest - Whether to abort the associated fetch request
	 * @returns True if a pending request was rejected
	 */
	private rejectPendingRequest(requestId: number, reason: Error, abortRequest = false): boolean {
		const pending = this.pendingRequests.get(requestId);
		if (!pending) return false;
		this.pendingRequests.delete(requestId);
		const controller = this.pendingRequestControllers.get(requestId);
		this.pendingRequestControllers.delete(requestId);
		if (abortRequest) {
			controller?.abort();
		}
		pending.reject(reason);
		return true;
	}

	/**
	 * Rejects all in-flight requests and clears request bookkeeping.
	 *
	 * @param reason - Shared rejection reason for each pending request
	 * @param abortRequests - Whether to abort all in-flight POST requests
	 * @returns void
	 */
	private rejectAllPendingRequests(reason: Error, abortRequests = false): void {
		for (const requestId of [...this.pendingRequests.keys()]) {
			this.rejectPendingRequest(requestId, reason, abortRequests);
		}
	}

	/**
	 * Opens the SSE connection and waits for the `endpoint` event.
	 * Starts background stream reading for JSON-RPC responses.
	 * @throws Error if connection fails or endpoint event not received within 10s
	 */
	async start(): Promise<void> {
		this.stopping = false;
		this.postUrl = null;
		this._connected = false;
		this.abortController?.abort();
		this.clearEndpointWaitState();
		this.rejectAllPendingRequests(new Error("SSE transport reset"), true);
		this.pendingRequestControllers.clear();

		this.abortController = new AbortController();
		const response = await fetch(this.config.url, {
			headers: { Accept: "text/event-stream", ...(this.config.headers || {}) },
			signal: this.abortController.signal,
		});

		if (!response.ok) {
			throw new Error(`SSE connection to ${this.name} failed: ${response.status}`);
		}
		if (!response.body) {
			throw new Error(`SSE response from ${this.name} has no body`);
		}

		// Wait for endpoint event with timeout, and abort stream fetch if it never arrives.
		const endpointReceived = new Promise<void>((resolve, reject) => {
			this.endpointRejecter = reject;
			this.endpointWaitTimer = setTimeout(() => {
				this.clearEndpointWaitState();
				this.abortController?.abort();
				reject(new Error(`${this.name}: timeout waiting for SSE endpoint event`));
			}, this.endpointWaitTimeoutMs);

			this.endpointResolver = (url: string) => {
				this.clearEndpointWaitState();
				this.postUrl = url;
				this._connected = true;
				resolve();
			};
		});

		// Read stream in background
		const reader = response.body.getReader();
		this.readStream(reader).catch(() => {});

		try {
			await endpointReceived;
		} catch (error) {
			this._connected = false;
			this.postUrl = null;
			throw toError(error);
		}
	}

	/** Aborts the SSE connection and rejects all pending requests. */
	stop(): void {
		this.stopping = true;
		this.abortController?.abort();
		this.rejectEndpointWait(
			new Error(`SSE transport to ${this.name} stopped before endpoint setup`)
		);
		this._connected = false;
		this.postUrl = null;
		this.rejectAllPendingRequests(new Error("Transport stopped"), true);
		this.pendingRequestControllers.clear();
	}

	/**
	 * POSTs a JSON-RPC request to the endpoint URL. Response arrives via SSE.
	 *
	 * @param request - JSON-RPC request to send
	 * @param timeoutMs - Request timeout in milliseconds (default: 30s)
	 * @returns JSON-RPC response
	 * @throws Error on timeout, connection loss, or POST failure
	 */
	send(request: JsonRpcRequest, timeoutMs = 30_000): Promise<JsonRpcResponse> {
		return new Promise((resolve, reject) => {
			if (!this._connected || !this.postUrl) {
				reject(new Error(`SSE transport to ${this.name} not connected`));
				return;
			}

			const requestController = new AbortController();
			const timeoutError = new Error(
				`MCP server "${this.name}" — ${request.method} timed out after ${Math.round(timeoutMs / 1000)}s`
			);
			const timer = setTimeout(() => {
				this.rejectPendingRequest(request.id, timeoutError, true);
			}, timeoutMs);

			this.pendingRequestControllers.set(request.id, requestController);
			this.pendingRequests.set(request.id, {
				resolve: (res) => {
					clearTimeout(timer);
					resolve(res);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});

			fetch(this.postUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.config.headers || {}),
				},
				body: JSON.stringify(request),
				signal: requestController.signal,
			})
				.then(async (resp) => {
					if (!resp.ok) {
						this.rejectPendingRequest(
							request.id,
							new Error(`SSE POST to ${this.name} failed: ${resp.status}`),
							false
						);
						return;
					}
					// Some servers return JSON-RPC response directly.
					// If we successfully parse and resolve here, the SSE stream
					// handler will no-op (pendingRequests entry already removed).
					const ct = resp.headers.get("content-type") || "";
					if (ct.includes("application/json")) {
						try {
							const body = (await resp.json()) as JsonRpcResponse;
							if (body.id === request.id) {
								this.resolvePendingRequest(request.id, body);
							}
						} catch {
							// JSON parse failed — fall through to SSE stream delivery.
							// Timer and pendingRequests entry remain intact so the
							// SSE handler or timeout can still resolve/reject.
						}
					}
				})
				.catch((error) => {
					if (!this.pendingRequests.has(request.id)) {
						return;
					}

					if (requestController.signal.aborted) {
						// Timer/stop/disconnect path already rejected this request.
						return;
					}

					this.rejectPendingRequest(request.id, toError(error), false);
				});
		});
	}

	/**
	 * POSTs a JSON-RPC notification to the endpoint URL (fire-and-forget).
	 * @param notification - Notification to send
	 */
	notify(notification: JsonRpcNotification): void {
		if (!this._connected || !this.postUrl) return;
		fetch(this.postUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(this.config.headers || {}),
			},
			body: JSON.stringify(notification),
		}).catch(() => {});
	}

	/** @param handler - Callback for server-initiated notifications */
	onNotification(handler: (method: string, params?: unknown) => void): void {
		this.notificationHandler = handler;
	}

	/** @param handler - Callback for unexpected disconnection */
	onDisconnect(handler: () => void): void {
		this.disconnectHandler = handler;
	}

	/**
	 * Reads the SSE stream and dispatches events. Runs until stream ends
	 * or is aborted. On unexpected disconnect, fires the disconnect handler.
	 *
	 * @param reader - ReadableStream reader from the fetch response
	 */
	private async readStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		let eventType = "message";
		let dataLines: string[] = [];

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const raw of lines) {
					const line = raw.replace(/\r$/, "");

					if (line === "") {
						// Dispatch event
						if (dataLines.length > 0) {
							this.handleSseEvent(eventType, dataLines.join("\n"));
							dataLines = [];
							eventType = "message";
						}
					} else if (line.startsWith("event:")) {
						eventType = line.slice(6).trim();
					} else if (line.startsWith("data:")) {
						const val = line.slice(5);
						dataLines.push(val.startsWith(" ") ? val.slice(1) : val);
					}
					// Ignore comments (":") and other fields (id:, retry:)
				}
			}
		} finally {
			reader.releaseLock();
			if (!this.stopping) {
				this._connected = false;
				this.postUrl = null;
				this.rejectEndpointWait(
					new Error(`${this.name}: SSE connection closed before endpoint event`)
				);
				this.rejectAllPendingRequests(new Error(`SSE connection to ${this.name} lost`), true);
				this.disconnectHandler?.();
			}
		}
	}

	/**
	 * Handles a parsed SSE event.
	 * @param type - SSE event type ("endpoint" | "message")
	 * @param data - Event data payload
	 */
	private handleSseEvent(type: string, data: string): void {
		if (type === "endpoint") {
			const url = new URL(data.trim(), this.config.url).toString();
			this.endpointResolver?.(url);
			return;
		}
		if (type === "message") {
			try {
				const msg = JSON.parse(data) as JsonRpcResponse | JsonRpcNotification;
				if ("id" in msg && msg.id != null) {
					this.resolvePendingRequest(msg.id, msg as JsonRpcResponse);
				} else if ("method" in msg) {
					this.notificationHandler?.(msg.method, msg.params);
				}
			} catch {
				/* Ignore malformed JSON */
			}
		}
	}
}

// ── Streamable HTTP Transport ────────────────────────────────────────────────

/**
 * Streamable HTTP transport (MCP 2025-03-26 spec). Each request is a
 * standalone POST. The server responds with either `application/json`
 * or `text/event-stream`. Session tracked via `Mcp-Session-Id` header.
 * Retries 5xx errors up to 2 times with 1s backoff.
 */
class StreamableHttpTransport implements McpTransport {
	readonly type = "streamable-http" as const;
	private sessionId: string | null = null;
	private _connected = false;
	private consecutiveFailures = 0;
	private disconnectHandler?: () => void;
	private notificationHandler?: (method: string, params?: unknown) => void;

	/**
	 * @param name - Server name (for error messages)
	 * @param config - Streamable HTTP server configuration
	 */
	constructor(
		private readonly name: string,
		private readonly config: McpStreamableHttpConfig
	) {}

	get connected(): boolean {
		return this._connected;
	}

	/** Marks the transport as ready. Streamable HTTP is stateless — no persistent connection. */
	async start(): Promise<void> {
		this.sessionId = null;
		this.consecutiveFailures = 0;
		this._connected = true;
	}

	/** Marks the transport as disconnected and clears the session. */
	stop(): void {
		this._connected = false;
		this.sessionId = null;
	}

	/**
	 * POSTs a JSON-RPC request. Handles both JSON and SSE response types.
	 * Retries 5xx errors up to 2 times with 1s backoff.
	 *
	 * @param request - JSON-RPC request to send
	 * @param timeoutMs - Request timeout in milliseconds (default: 30s)
	 * @returns JSON-RPC response
	 * @throws Error on timeout, repeated failures, or non-retryable errors
	 */
	async send(request: JsonRpcRequest, timeoutMs = 30_000): Promise<JsonRpcResponse> {
		if (!this._connected) {
			throw new Error(`Streamable HTTP transport to ${this.name} not connected`);
		}

		const maxRetries = 2;
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);

			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...(this.config.headers || {}),
				};
				if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

				const resp = await fetch(this.config.url, {
					method: "POST",
					headers,
					body: JSON.stringify(request),
					signal: controller.signal,
				});

				// Track session ID
				const sid = resp.headers.get("mcp-session-id");
				if (sid) this.sessionId = sid;

				if (!resp.ok) {
					if (resp.status >= 500 && attempt < maxRetries) {
						lastError = new Error(`HTTP ${resp.status} from ${this.name}`);
						await sleep(1000);
						continue;
					}
					throw new Error(`HTTP ${resp.status} from ${this.name}: ${resp.statusText}`);
				}

				const ct = resp.headers.get("content-type") || "";
				let result: JsonRpcResponse;

				if (ct.includes("text/event-stream")) {
					result = await this.parseSseResponse(resp, request.id);
				} else {
					result = (await resp.json()) as JsonRpcResponse;
				}

				this.consecutiveFailures = 0;
				return result;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (controller.signal.aborted) {
					throw new Error(
						`MCP server "${this.name}" — ${request.method} timed out after ${Math.round(timeoutMs / 1000)}s`
					);
				}
				if (attempt === maxRetries) {
					this.consecutiveFailures++;
					if (this.consecutiveFailures >= 3) {
						this._connected = false;
						this.disconnectHandler?.();
					}
					throw lastError;
				}
				await sleep(1000);
			} finally {
				clearTimeout(timer);
			}
		}

		throw lastError ?? new Error(`Request to ${this.name} failed`);
	}

	/**
	 * POSTs a JSON-RPC notification (fire-and-forget).
	 * @param notification - Notification to send
	 */
	notify(notification: JsonRpcNotification): void {
		if (!this._connected) return;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...(this.config.headers || {}),
		};
		if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

		fetch(this.config.url, {
			method: "POST",
			headers,
			body: JSON.stringify(notification),
		}).catch(() => {});
	}

	/** @param handler - Callback for server-initiated notifications */
	onNotification(handler: (method: string, params?: unknown) => void): void {
		this.notificationHandler = handler;
	}

	/** @param handler - Callback for unexpected disconnection */
	onDisconnect(handler: () => void): void {
		this.disconnectHandler = handler;
	}

	/**
	 * Parses an SSE response body for a JSON-RPC response.
	 * Handles server notifications embedded in the stream.
	 *
	 * @param resp - Fetch response with SSE body
	 * @param expectedId - JSON-RPC request ID to match against
	 * @returns The JSON-RPC response found in the stream
	 * @throws Error if no response found
	 */
	private async parseSseResponse(
		resp: Response,
		expectedId?: string | number
	): Promise<JsonRpcResponse> {
		if (!resp.body) throw new Error(`No response body from ${this.name}`);
		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let eventType = "message";
		let dataLines: string[] = [];
		let result: JsonRpcResponse | null = null;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const raw of lines) {
					const line = raw.replace(/\r$/, "");
					if (line === "") {
						if (dataLines.length > 0) {
							const data = dataLines.join("\n");
							if (eventType === "message") {
								try {
									const msg = JSON.parse(data);
									if (msg.id != null && (expectedId == null || msg.id === expectedId)) {
										result = msg;
									} else if (msg.method) {
										this.notificationHandler?.(msg.method, msg.params);
									}
								} catch {
									/* Ignore */
								}
							}
							dataLines = [];
							eventType = "message";
						}
					} else if (line.startsWith("event:")) {
						eventType = line.slice(6).trim();
					} else if (line.startsWith("data:")) {
						const val = line.slice(5);
						dataLines.push(val.startsWith(" ") ? val.slice(1) : val);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		if (!result) throw new Error(`No JSON-RPC response in SSE stream from ${this.name}`);
		return result;
	}
}

// ── Transport Factory ────────────────────────────────────────────────────────

/**
 * Creates the appropriate transport for an MCP server configuration.
 *
 * @param name - Server name
 * @param config - Server configuration
 * @returns Transport instance (not yet started)
 */
export function createTransport(name: string, config: McpServerConfig): McpTransport {
	if (config.type === "sse") return new SseTransport(name, config);
	if (config.type === "streamable-http") return new StreamableHttpTransport(name, config);
	return new StdioTransport(name, config as McpStdioConfig);
}

// ── Config Loading ───────────────────────────────────────────────────────────

/**
 * Validates a raw MCP server config object from settings.json.
 *
 * @param name - Server name (for error messages)
 * @param raw - Raw config object
 * @returns Validated config or null if invalid
 */
export function validateMcpConfig(
	name: string,
	raw: Record<string, unknown>
): McpServerConfig | null {
	const type = raw.type as string | undefined;

	if (type === "sse") {
		if (!raw.url || typeof raw.url !== "string") {
			console.error(`MCP: "${name}" — sse config requires a "url" field`);
			return null;
		}
		return {
			type: "sse",
			url: raw.url,
			headers: (raw.headers as Record<string, string>) || undefined,
			env: (raw.env as Record<string, string>) || undefined,
		};
	}

	if (type === "streamable-http") {
		if (!raw.url || typeof raw.url !== "string") {
			console.error(`MCP: "${name}" — streamable-http config requires a "url" field`);
			return null;
		}
		return {
			type: "streamable-http",
			url: raw.url,
			headers: (raw.headers as Record<string, string>) || undefined,
			env: (raw.env as Record<string, string>) || undefined,
		};
	}

	// STDIO (default)
	if (!raw.command || typeof raw.command !== "string") {
		console.error(`MCP: "${name}" — stdio config requires a "command" field`);
		return null;
	}
	return {
		type: type === "stdio" ? "stdio" : undefined,
		command: raw.command,
		args: (raw.args as string[]) || undefined,
		env: (raw.env as Record<string, string>) || undefined,
	};
}

/** Metadata describing why project MCP config was skipped. */
export interface SkippedProjectMcpConfig {
	readonly path: string;
	readonly trustStatus: ProjectTrustStatus;
}

/** Result payload for MCP config loading with diagnostics. */
export interface McpConfigLoadResult {
	readonly config: Record<string, McpServerConfig>;
	readonly skippedProjectConfig: SkippedProjectMcpConfig | null;
}

/**
 * Read and validate `mcpServers` from a settings file.
 *
 * @param settingsPath - Absolute settings.json path
 * @returns Map of server name to validated config
 */
function readMcpConfigFromSettings(settingsPath: string): Record<string, McpServerConfig> {
	if (!fs.existsSync(settingsPath)) return {};

	try {
		const content = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
			mcpServers?: Record<string, unknown>;
		};
		if (
			!content.mcpServers ||
			typeof content.mcpServers !== "object" ||
			Array.isArray(content.mcpServers)
		) {
			return {};
		}

		const result: Record<string, McpServerConfig> = {};
		for (const [name, raw] of Object.entries(content.mcpServers)) {
			if (typeof raw !== "object" || raw === null) continue;
			const validated = validateMcpConfig(name, raw as Record<string, unknown>);
			if (validated) result[name] = validated;
		}
		return result;
	} catch {
		// Invalid settings should not block startup.
		return {};
	}
}

/**
 * Check whether a settings file contains at least one project MCP server.
 *
 * @param settingsPath - Absolute settings.json path
 * @returns True when `mcpServers` has one or more entries
 */
function hasConfiguredMcpServers(settingsPath: string): boolean {
	if (!fs.existsSync(settingsPath)) return false;

	try {
		const content = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
			mcpServers?: Record<string, unknown>;
		};
		if (
			!content.mcpServers ||
			typeof content.mcpServers !== "object" ||
			Array.isArray(content.mcpServers)
		) {
			return false;
		}
		return Object.keys(content.mcpServers).length > 0;
	} catch {
		return false;
	}
}

/**
 * Build a user-visible startup notice when project MCP config is skipped.
 *
 * @param projectSettingsPath - Project settings path that was blocked
 * @param trustStatus - Current trust status used for gating
 * @returns Warning text suitable for UI notifications
 */
function formatSkippedProjectMcpNotice(
	projectSettingsPath: string,
	trustStatus: ProjectTrustStatus
): string {
	const reason =
		trustStatus === "stale_fingerprint" ? "project trust is stale" : "project is untrusted";
	return (
		`MCP: skipped project mcpServers in ${projectSettingsPath} (${reason}). ` +
		"Run /trust-project to enable project MCP servers."
	);
}

/**
 * Loads mcpServers config from global settings and, when trusted, project
 * settings. Validates each server config and skips invalid entries.
 *
 * Global `~/.tallow/settings.json` is always loaded. Project
 * `.tallow/settings.json` is merged only when the trust status is `trusted`.
 * If both sources define the same server name, project config wins.
 *
 * @param cwd - Current working directory
 * @returns MCP config plus trust-gate diagnostics
 */
export function loadMcpConfigWithMetadata(cwd: string): McpConfigLoadResult {
	const homeDir = process.env.HOME || "";
	const globalSettingsPath = path.join(homeDir, ".tallow", "settings.json");
	const projectSettingsPath = path.join(cwd, ".tallow", "settings.json");
	const trustDecision = getProjectSettingsTrustDecision();

	const globalConfig = readMcpConfigFromSettings(globalSettingsPath);
	const projectConfig = trustDecision.allowProjectSettings
		? readMcpConfigFromSettings(projectSettingsPath)
		: {};

	const skippedProjectConfig =
		trustDecision.allowProjectSettings || !hasConfiguredMcpServers(projectSettingsPath)
			? null
			: {
					path: projectSettingsPath,
					trustStatus: trustDecision.trustStatus,
				};

	return {
		config: {
			...globalConfig,
			...projectConfig,
		},
		skippedProjectConfig,
	};
}

/**
 * Loads merged MCP server config for runtime connection setup.
 *
 * @param cwd - Current working directory
 * @returns Map of server name to validated config
 */
export function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
	return loadMcpConfigWithMetadata(cwd).config;
}

// ── Server Types ─────────────────────────────────────────────────────────────

/** Runtime state for a connected MCP server. */
interface McpServer {
	name: string;
	config: McpServerConfig;
	transport: McpTransport | null;
	tools: McpToolDef[];
	/** Server-provided usage instructions, injected into the system prompt. */
	instructions?: string;
	ready: boolean;
	failed: boolean;
	/** STDIO only: one restart attempt allowed. */
	hasRestarted: boolean;
	nextId: number;
	/** Active reconnect promise — concurrent callers queue behind it. */
	reconnectPromise: Promise<void> | null;
	/** Notification callback for user-visible messages. */
	uiNotify?: (message: string, level: "info" | "error") => void;
}

// ── Server Lifecycle ─────────────────────────────────────────────────────────

/**
 * Sends a JSON-RPC request through the server's transport.
 *
 * @param server - MCP server instance
 * @param method - JSON-RPC method name
 * @param params - Method parameters
 * @param timeoutMs - Request timeout in milliseconds
 * @returns JSON-RPC response
 */
function sendRequest(
	server: McpServer,
	method: string,
	params?: Record<string, unknown>,
	timeoutMs = 30_000
): Promise<JsonRpcResponse> {
	if (!server.transport?.connected) {
		return Promise.reject(new Error(`Server ${server.name} is not running`));
	}
	const id = server.nextId++;
	const request: JsonRpcRequest = { jsonrpc: "2.0", id, method };
	if (params) request.params = params;
	return server.transport.send(request, timeoutMs);
}

/**
 * Initializes an MCP server: starts the transport, performs the MCP
 * handshake, and discovers available tools via tools/list.
 *
 * @param server - MCP server instance to initialize
 * @throws Error if transport start, handshake, or tool discovery fails
 */
async function initServer(server: McpServer): Promise<void> {
	if (!server.transport) throw new Error(`No transport for ${server.name}`);

	if (!server.transport.connected) {
		await server.transport.start();
	}

	const initResp = await sendRequest(
		server,
		"initialize",
		{
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "tallow", version: "0.1.0" },
		},
		10_000
	);

	if (initResp.error) {
		throw new Error(`Failed to initialize ${server.name}: ${initResp.error.message}`);
	}

	server.transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

	// Capture server-provided instructions
	const initResult = initResp.result as
		| { instructions?: string; serverInfo?: { instructions?: string } }
		| undefined;
	const instructions = initResult?.instructions ?? initResult?.serverInfo?.instructions;
	if (instructions?.trim()) {
		server.instructions = instructions.trim();
	}

	const toolsResp = await sendRequest(server, "tools/list", {}, 10_000);
	if (toolsResp.error) {
		throw new Error(`Failed to list tools for ${server.name}: ${toolsResp.error.message}`);
	}

	const result = toolsResp.result as { tools?: McpToolDef[] } | undefined;
	server.tools = result?.tools ?? [];
	server.ready = true;
}

/**
 * Attempts to reconnect a network transport with exponential backoff.
 * Delays: 1s → 2s → 4s, max 3 attempts. Sets server.failed on exhaustion.
 *
 * @param server - MCP server to reconnect
 * @throws Error if all reconnect attempts fail
 */
async function attemptNetworkReconnect(server: McpServer): Promise<void> {
	const delays = [1000, 2000, 4000];

	for (let attempt = 1; attempt <= 3; attempt++) {
		server.uiNotify?.(`MCP: ${server.name} reconnecting (attempt ${attempt}/3)`, "info");
		try {
			server.ready = false;
			server.transport?.stop();
			await initServer(server);
			server.uiNotify?.(`MCP: ${server.name} reconnected (${server.tools.length} tools)`, "info");
			return;
		} catch {
			if (attempt < 3) await sleep(delays[attempt - 1]);
		}
	}

	server.failed = true;
	server.uiNotify?.(`MCP: ${server.name} failed to reconnect after 3 attempts`, "error");
	throw new Error(`Server ${server.name} reconnect failed after 3 attempts`);
}

/**
 * Ensures a server is running. For STDIO, allows one restart attempt.
 * For network transports, attempts reconnect with exponential backoff.
 *
 * @param server - MCP server instance
 * @throws Error if server cannot be started or reconnected
 */
async function ensureServer(server: McpServer): Promise<void> {
	if (server.ready && server.transport?.connected) return;
	if (server.failed) throw new Error(`Server ${server.name} failed and cannot be restarted`);

	// Queue behind existing reconnect attempt
	if (server.reconnectPromise) {
		await server.reconnectPromise;
		if (server.ready && server.transport?.connected) return;
		throw new Error(`Server ${server.name} reconnect failed`);
	}

	const isNetwork =
		server.transport?.type === "sse" || server.transport?.type === "streamable-http";

	if (isNetwork) {
		server.reconnectPromise = attemptNetworkReconnect(server);
		try {
			await server.reconnectPromise;
		} finally {
			server.reconnectPromise = null;
		}
	} else {
		// STDIO: one restart attempt
		if (!server.transport?.connected && server.hasRestarted) {
			server.failed = true;
			throw new Error(`Server ${server.name} crashed and restart already attempted`);
		}
		if (!server.transport?.connected && server.tools.length > 0) {
			server.hasRestarted = true;
		}
		await initServer(server);
	}
}

/**
 * Calls an MCP tool on a server and returns the result.
 *
 * @param server - MCP server instance
 * @param toolName - Name of the tool to call
 * @param args - Tool arguments
 * @returns Array of content items from the tool result
 * @throws Error if the tool call fails
 */
async function callTool(
	server: McpServer,
	toolName: string,
	args: Record<string, unknown>
): Promise<McpContentItem[]> {
	await ensureServer(server);

	const resp = await sendRequest(
		server,
		"tools/call",
		{ name: toolName, arguments: args },
		120_000
	);

	if (resp.error) {
		throw new Error(`Tool ${toolName} on ${server.name} failed: ${resp.error.message}`);
	}

	const result = resp.result as { content?: McpContentItem[]; isError?: boolean } | undefined;
	if (result?.isError) {
		const errorText = result.content?.map((c) => c.text || "").join("\n") || "Unknown error";
		throw new Error(errorText);
	}

	return result?.content ?? [];
}

// ── Content Mapping ──────────────────────────────────────────────────────────

/** Pi-code content item union. */
type PiContentItem =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/**
 * Safely stringify a value, handling circular references.
 *
 * @param value - Value to serialize
 * @returns JSON string, or String(value) fallback
 */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * Maps MCP content items to pi-code tool result content.
 *
 * Supports:
 * - `text` → pass-through as text
 * - `image` → pass-through with data + mimeType
 * - `resource` → formatted text with URI, optional MIME type, and inline text
 * - `resource_link` → formatted text with URI and description
 * - Unknown types → serialized as JSON with type annotation
 *
 * Annotations are appended to text items when present.
 *
 * @param items - MCP content items from server response
 * @returns pi-code content array
 */
export function mapContent(items: McpContentItem[]): PiContentItem[] {
	return items.map((item) => {
		if (item.type === "image" && item.data && item.mimeType) {
			return { type: "image" as const, data: item.data, mimeType: item.mimeType };
		}

		if (item.type === "resource" && item.resource) {
			const r = item.resource;
			let text = `[Resource: ${r.uri}]`;
			if (r.mimeType) text += ` (${r.mimeType})`;
			if (r.text) text += `\n${r.text}`;
			return { type: "text" as const, text };
		}

		if (item.type === "resource_link") {
			const uri = item.uri ?? "unknown";
			let text = item.mimeType ? `[Resource (${item.mimeType}): ${uri}]` : `[Resource: ${uri}]`;
			if (item.description) text += ` — ${item.description}`;
			return { type: "text" as const, text };
		}

		if (item.type === "text" && item.text != null) {
			let text = item.text;
			if (item.annotations && Object.keys(item.annotations).length > 0) {
				text += `\n[Annotations: ${safeStringify(item.annotations)}]`;
			}
			return { type: "text" as const, text };
		}

		const { type, ...rest } = item;
		const body = Object.keys(rest).length > 0 ? safeStringify(rest) : "";
		return { type: "text" as const, text: body ? `[${type}]\n${body}` : `[${type}]` };
	});
}

// ── Extension Entry Point ────────────────────────────────────────────────────

/**
 * MCP Adapter extension. Reads mcpServers config from settings.json,
 * lazily connects to servers on first use (STDIO, SSE, or Streamable HTTP),
 * registers discovered tools, and provides a /mcp command for status.
 *
 * @param pi - Extension API
 */
export default function mcpAdapter(pi: ExtensionAPI) {
	const servers = new Map<string, McpServer>();
	let cachedConfigCwd: string | null = null;
	let cachedConfig: Record<string, McpServerConfig> | null = null;
	let cachedSkippedProjectConfig: SkippedProjectMcpConfig | null = null;

	/**
	 * Initializes a server and registers its discovered tools with pi-code.
	 * For network transports, also wires up the proactive reconnect handler.
	 *
	 * @param server - MCP server to connect and register tools for
	 * @param ctx - Extension context for logging
	 */
	async function connectAndRegisterTools(server: McpServer, ctx?: ExtensionContext): Promise<void> {
		try {
			await initServer(server);

			// Store UI notify for reconnect messages
			server.uiNotify = (msg, level) => ctx?.ui.notify(msg, level);

			// Proactive reconnect for network transports
			const isNetwork =
				server.transport?.type === "sse" || server.transport?.type === "streamable-http";
			if (isNetwork && server.transport) {
				server.transport.onDisconnect(() => {
					server.ready = false;
					if (!server.failed && !server.reconnectPromise) {
						server.reconnectPromise = attemptNetworkReconnect(server)
							.catch(() => {})
							.finally(() => {
								server.reconnectPromise = null;
							});
					}
				});
			}

			for (const tool of server.tools) {
				const piToolName = `mcp__${server.name}__${tool.name}`;

				pi.registerTool({
					name: piToolName,
					label: `${server.name}: ${tool.name}`,
					description: tool.description || `MCP tool ${tool.name} from ${server.name}`,
					parameters: (tool.inputSchema as ReturnType<typeof Type.Object>) ?? Type.Object({}),

					async execute(_toolCallId, params, signal, _onUpdate, ctx) {
						try {
							if (signal?.aborted) throw new Error("Aborted");
							ctx.ui.setWorkingMessage(`Calling MCP tool: ${tool.name}`);

							const callPromise = callTool(server, tool.name, params);
							const abortPromise = signal
								? new Promise<never>((_resolve, reject) => {
										signal.addEventListener("abort", () => reject(new Error("Aborted")), {
											once: true,
										});
									})
								: null;

							const content = abortPromise
								? await Promise.race([callPromise, abortPromise])
								: await callPromise;

							return {
								content: mapContent(content),
								details: { server: server.name, tool: tool.name },
							};
						} catch (err) {
							if (signal?.aborted) throw err;
							return {
								content: [{ type: "text" as const, text: `MCP error: ${err}` }],
								details: { server: server.name, tool: tool.name, error: String(err) },
							};
						} finally {
							ctx.ui.setWorkingMessage();
						}
					},
				});
			}

			ctx?.ui.notify(`MCP: ${server.name} connected (${server.tools.length} tools)`, "info");
		} catch (err) {
			server.failed = true;
			ctx?.ui.notify(`MCP: ${server.name} failed to connect: ${err}`, "error");
		}
	}

	/**
	 * Filters configured server names using the optional agent-scoped allowlist.
	 *
	 * @param serverNames - Configured MCP server names
	 * @returns Server names allowed by PI_MCP_SERVERS (or all names when unset)
	 */
	function filterServerNames(serverNames: string[]): string[] {
		const allowedServers = process.env.PI_MCP_SERVERS;
		if (allowedServers === undefined || allowedServers === "") {
			return serverNames;
		}

		const allowed = new Set(
			allowedServers
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean)
		);
		return serverNames.filter((name) => allowed.has(name));
	}

	/**
	 * Loads MCP config once per session cwd and memoizes trust-gate metadata.
	 *
	 * @param cwd - Session working directory
	 * @returns Cached or newly loaded config result
	 */
	function getCachedConfigResult(cwd: string): McpConfigLoadResult {
		if (cachedConfig && cachedConfigCwd === cwd) {
			return {
				config: cachedConfig,
				skippedProjectConfig: cachedSkippedProjectConfig,
			};
		}

		const result = loadMcpConfigWithMetadata(cwd);
		cachedConfigCwd = cwd;
		cachedConfig = result.config;
		cachedSkippedProjectConfig = result.skippedProjectConfig;
		return result;
	}

	/**
	 * Creates in-memory server instances from config without connecting.
	 *
	 * @param cwd - Session working directory
	 * @returns Nothing
	 */
	function ensureServerDefinitions(cwd: string): void {
		if (servers.size > 0) {
			return;
		}

		const configResult = getCachedConfigResult(cwd);
		const serverNames = filterServerNames(Object.keys(configResult.config));
		for (const name of serverNames) {
			const config = configResult.config[name];
			servers.set(name, {
				name,
				config,
				transport: createTransport(name, config),
				tools: [],
				ready: false,
				failed: false,
				hasRestarted: false,
				nextId: 1,
				reconnectPromise: null,
			});
		}
	}

	/**
	 * Performs one-time MCP setup: connect all configured servers and register tools.
	 *
	 * @param input - Lazy initialization trigger and extension context
	 * @returns Nothing
	 */
	async function initializeMcpServers(input: LazyInitInput<ExtensionContext>): Promise<void> {
		const { context } = input;
		ensureServerDefinitions(context.cwd);
		if (servers.size === 0) {
			return;
		}

		const serverCount = servers.size;
		context.ui.setWorkingMessage(
			`Connecting to ${serverCount} MCP server${serverCount > 1 ? "s" : ""}`
		);
		try {
			const connectPromises: Promise<void>[] = [];
			for (const server of servers.values()) {
				connectPromises.push(connectAndRegisterTools(server, context));
			}
			await Promise.allSettled(connectPromises);
		} finally {
			context.ui.setWorkingMessage();
		}
	}

	/**
	 * Ensures lazy MCP initialization has completed before a feature uses MCP.
	 *
	 * @param trigger - Caller identifier for telemetry and debugging
	 * @param ctx - Extension context for initialization
	 * @returns Nothing
	 */
	async function ensureMcpInitialized(trigger: string, ctx: ExtensionContext): Promise<void> {
		await lazyInitializer.ensureInitialized({ trigger, context: ctx });
	}

	const lazyInitializer = createLazyInitializer<ExtensionContext>({
		name: "mcp-adapter-tool",
		initialize: initializeMcpServers,
	});

	/**
	 * Reset runtime state so the next lazy initialization uses fresh config.
	 *
	 * @returns Nothing
	 */
	function resetRuntimeState(): void {
		for (const server of servers.values()) {
			if (server.transport) {
				server.transport.stop();
			}
		}
		servers.clear();
		lazyInitializer.reset();
		cachedConfig = null;
		cachedConfigCwd = null;
		cachedSkippedProjectConfig = null;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		resetRuntimeState();

		const configResult = getCachedConfigResult(ctx.cwd);
		if (configResult.skippedProjectConfig) {
			ctx.ui.notify(
				formatSkippedProjectMcpNotice(
					configResult.skippedProjectConfig.path,
					configResult.skippedProjectConfig.trustStatus
				),
				"warning"
			);
		}
	});

	// Inject MCP context and usage instructions into system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		await ensureMcpInitialized("before_agent_start", ctx);
		const connectedServers = [...servers.values()].filter((s) => s.ready);
		if (connectedServers.length === 0) return;

		const lines = [
			"\n# MCP Servers (connected via mcp-adapter extension)\n",
			"The following MCP servers are connected. Their tools are available as mcp__<server>__<tool>.\n",
		];

		for (const server of connectedServers) {
			lines.push(`## ${server.name} (${server.tools.length} tools)`);

			if (server.instructions) {
				lines.push("");
				lines.push(server.instructions);
				lines.push("");
			}

			for (const tool of server.tools) {
				const desc = tool.description ? ` - ${tool.description.split(".")[0]}` : "";
				lines.push(`- mcp__${server.name}__${tool.name}${desc}`);
			}
			lines.push("");
		}

		// Documentation lookup instructions
		const hasDocsTools = connectedServers.some((s) =>
			s.tools.some((t) => t.name === "search_docs" || t.name === "get_doc")
		);
		if (hasDocsTools) {
			lines.push("## Documentation Lookup (MANDATORY)\n");
			lines.push(
				"When you need documentation for any software tool, library, framework, API, SDK, CLI, or service:\n",
				'1. **ALWAYS check local docs first** with `execute_tool(app: "docs", tool: "search_docs", args: { query: "..." })`',
				'2. **If found locally**, read it with `execute_tool(app: "docs", tool: "get_doc", args: { name: "..." })`',
				'3. **If NOT found locally**, add it with `execute_tool(app: "docs", tool: "add_doc", args: { name: "<Name>", url: "<official docs URL>" })`, then read with `get_doc`',
				"4. **NEVER use `web_fetch` for documentation.** The docs tool scrapes, caches, and auto-refreshes. `web_fetch` wastes tokens on raw HTML and the content is lost after the session.\n",
				"This applies to ALL documentation: official docs, API references, SDK guides, configuration docs, CLI references, getting started guides, changelogs, migration guides.",
				"This does NOT apply to: search engine results, blog posts, news articles, Stack Overflow, GitHub issues/PRs, social media, Wikipedia, general web content.\n"
			);
		}

		// MCP Server Policy
		lines.push("## MCP Server Policy\n");
		lines.push(
			"- NEVER add MCP servers directly to Claude Code configuration (~/.claude/.claude.json)",
			"- Add MCP servers to the tool-proxy system at ~/dev/ai/mcp/apps/",
			"- Run the indexer after adding new apps: `cd ~/dev/ai/services/tool-proxy && pnpm index`\n"
		);

		// Tool Proxy Modes
		lines.push("## Tool Proxy Modes\n");
		lines.push(
			"| Mode | Transport | Secrets | Use case |",
			"|------|-----------|---------|----------|",
			"| `start.sh` | STDIO | Varlock/1Password | Local Claude Code with Touch ID |",
			"| `start-local.sh` | STDIO | env files | Local dev, simpler |",
			"| Docker | HTTP/SSE | `OP_SERVICE_ACCOUNT_TOKEN` | Remote access, orchestrator |\n",
			"Docker mode (`docker compose up tool-proxy`):",
			"- `TOOL_PROXY_HTTP=1` enables HTTP/SSE on port 3100",
			"- `TOOL_PROXY_MODE`: `local` (all) / `api` (locality=api only) / `remote-cc` (whitelist)",
			"- Don't run Docker alongside local STDIO - they share Neo4j and will conflict\n"
		);

		return { systemPrompt: event.systemPrompt + lines.join("\n") };
	});

	pi.on("session_shutdown" as never, async () => {
		resetRuntimeState();
	});

	// ── /mcp Command ─────────────────────────────────────────────────────────

	pi.registerCommand("mcp", {
		description: "List connected MCP servers and their tools",
		handler: async (_args, ctx) => {
			await ensureMcpInitialized("command:mcp", ctx);

			if (servers.size === 0) {
				ctx.ui.notify(
					"No MCP servers configured. Add mcpServers to .tallow/settings.json or ~/.tallow/settings.json.",
					"info"
				);
				return;
			}

			const lines: string[] = [];
			for (const server of servers.values()) {
				const transportType = server.transport?.type ?? "unknown";
				const status = server.failed
					? `${getIcon("error")} failed`
					: server.ready
						? `${getIcon("in_progress")} connected (${transportType}, ${server.tools.length} tools)`
						: `${getIcon("idle")} not started`;

				lines.push(`${server.name}: ${status}`);

				if (server.ready) {
					for (const tool of server.tools) {
						lines.push(`  mcp__${server.name}__${tool.name}`);
						if (tool.description) {
							const desc =
								tool.description.length > 60
									? `${tool.description.slice(0, 57)}...`
									: tool.description;
							lines.push(`    ${desc}`);
						}
					}
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
