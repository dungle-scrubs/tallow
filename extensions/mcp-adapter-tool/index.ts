/**
 * MCP Adapter Extension
 *
 * Drop-in support for standard MCP servers. Declare servers in
 * settings.json, pi-code spawns them via STDIO, discovers their
 * tools, and registers them as mcp__<server>__<tool>.
 *
 * Servers are spawned eagerly at session start. If a server
 * crashes, one automatic restart is attempted. On session end,
 * all child processes are killed.
 *
 * Configuration in .tallow/settings.json or ~/.tallow/settings.json:
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 *       "env": {}
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

// ── Types ────────────────────────────────────────────────────────────────────

/** MCP server declaration from settings.json. */
interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

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

/** MCP tool definition from tools/list response. */
interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** MCP tool call result content item. */
interface McpContentItem {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** Runtime state for a connected MCP server. */
interface McpServer {
	name: string;
	config: McpServerConfig;
	process: ChildProcess | null;
	tools: McpToolDef[];
	ready: boolean;
	failed: boolean;
	hasRestarted: boolean;
	nextId: number;
	pendingRequests: Map<
		number,
		{
			resolve: (value: JsonRpcResponse) => void;
			reject: (reason: Error) => void;
		}
	>;
	buffer: string;
	/** Consecutive timeout count — auto-kills process at 3 */
	timeoutCount?: number;
}

// ── Config Loading ───────────────────────────────────────────────────────────

/**
 * Loads mcpServers config from project-local or global settings.
 * @param cwd - Current working directory
 * @returns Map of server name to config
 */
function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
	const locations = [
		path.join(cwd, ".tallow", "settings.json"),
		path.join(process.env.HOME || "", ".tallow", "settings.json"),
	];

	for (const loc of locations) {
		try {
			if (fs.existsSync(loc)) {
				const content = JSON.parse(fs.readFileSync(loc, "utf-8"));
				if (content.mcpServers) return content.mcpServers;
			}
		} catch {
			// Ignore parse errors
		}
	}

	return {};
}

// ── JSON-RPC over STDIO ──────────────────────────────────────────────────────

/**
 * Sends a JSON-RPC request to an MCP server and waits for the response.
 * @param server - MCP server instance
 * @param method - JSON-RPC method name
 * @param params - Method parameters
 * @param timeoutMs - Request timeout in milliseconds
 * @returns JSON-RPC response
 * @throws Error on timeout, server crash, or JSON-RPC error
 */
function sendRequest(
	server: McpServer,
	method: string,
	params?: Record<string, unknown>,
	timeoutMs = 30_000
): Promise<JsonRpcResponse> {
	return new Promise((resolve, reject) => {
		if (!server.process || !server.process.stdin) {
			reject(new Error(`Server ${server.name} is not running`));
			return;
		}

		const id = server.nextId++;
		const request: JsonRpcRequest = { jsonrpc: "2.0", id, method };
		if (params) request.params = params;

		const timer = setTimeout(() => {
			server.pendingRequests.delete(id);
			server.timeoutCount = (server.timeoutCount ?? 0) + 1;
			if (server.timeoutCount >= 3 && server.process) {
				console.error(`MCP: ${server.name} hit ${server.timeoutCount} timeouts, killing process`);
				server.process.kill("SIGTERM");
				server.process = null;
				server.ready = false;
			}
			const timeoutSec = Math.round(timeoutMs / 1000);
			const hint =
				server.timeoutCount >= 3
					? " Server killed after repeated failures."
					: ` (${server.timeoutCount}/3 before auto-kill)`;
			reject(
				new Error(
					`MCP server "${server.name}" unresponsive — ${method} timed out after ${timeoutSec}s.${hint}`
				)
			);
		}, timeoutMs);

		server.pendingRequests.set(id, {
			resolve: (res) => {
				clearTimeout(timer);
				server.timeoutCount = 0;
				resolve(res);
			},
			reject: (err) => {
				clearTimeout(timer);
				reject(err);
			},
		});

		const payload = `${JSON.stringify(request)}\n`;
		server.process.stdin.write(payload);
	});
}

/**
 * Handles incoming data from a server's stdout.
 * Buffers partial lines and dispatches complete JSON-RPC responses.
 * @param server - MCP server instance
 * @param chunk - Raw data chunk from stdout
 */
function handleServerData(server: McpServer, chunk: string): void {
	server.buffer += chunk;

	let newlineIdx: number = server.buffer.indexOf("\n");
	while (newlineIdx !== -1) {
		const line = server.buffer.slice(0, newlineIdx).trim();
		server.buffer = server.buffer.slice(newlineIdx + 1);

		if (!line) continue;

		let msg: JsonRpcResponse;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}

		if (msg.id != null && server.pendingRequests.has(msg.id)) {
			const pending = server.pendingRequests.get(msg.id);
			if (!pending) continue;
			server.pendingRequests.delete(msg.id);
			pending.resolve(msg);
		}

		newlineIdx = server.buffer.indexOf("\n");
	}
}

// ── Server Lifecycle ─────────────────────────────────────────────────────────

/**
 * Spawns an MCP server process and wires up stdout/stderr handling.
 * @param server - MCP server instance to spawn
 */
function spawnServer(server: McpServer): void {
	const env = { ...process.env, ...(server.config.env || {}) };

	server.process = spawn(server.config.command, server.config.args || [], {
		stdio: ["pipe", "pipe", "pipe"],
		env,
	});

	server.buffer = "";
	server.process.stdout?.setEncoding("utf-8");
	server.process.stdout?.on("data", (chunk: string) => handleServerData(server, chunk));

	server.process.stderr?.setEncoding("utf-8");
	server.process.stderr?.on("data", () => {
		// Swallow stderr
	});

	server.process.on("close", (code) => {
		for (const [id, pending] of server.pendingRequests) {
			pending.reject(new Error(`Server ${server.name} exited with code ${code}`));
			server.pendingRequests.delete(id);
		}
		server.process = null;
		server.ready = false;
	});
}

/**
 * Initializes an MCP server: spawns the process, sends the initialize
 * handshake, and discovers available tools via tools/list.
 * @param server - MCP server instance to initialize
 * @throws Error if initialization or tool discovery fails
 */
async function initServer(server: McpServer): Promise<void> {
	spawnServer(server);

	// Shorter timeout for initialization — if the server can't respond to
	// the handshake in 10s it's likely broken or misconfigured.
	const initResp = await sendRequest(
		server,
		"initialize",
		{
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "pi-code", version: "0.1.0" },
		},
		10_000
	);

	if (initResp.error) {
		throw new Error(`Failed to initialize ${server.name}: ${initResp.error.message}`);
	}

	if (server.process?.stdin) {
		const notification = `${JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		})}\n`;
		server.process.stdin.write(notification);
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
 * Ensures a server is running. Attempts one restart if crashed.
 * @param server - MCP server instance
 * @throws Error if server cannot be started
 */
async function ensureServer(server: McpServer): Promise<void> {
	if (server.ready && server.process) return;
	if (server.failed) throw new Error(`Server ${server.name} failed and cannot be restarted`);

	if (!server.process && server.hasRestarted) {
		server.failed = true;
		throw new Error(`Server ${server.name} crashed and restart already attempted`);
	}

	if (!server.process && server.tools.length > 0) {
		server.hasRestarted = true;
	}

	await initServer(server);
}

/**
 * Calls an MCP tool on a server and returns the result.
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
		{
			name: toolName,
			arguments: args,
		},
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

/**
 * Maps MCP content items to pi-code tool result content.
 * @param items - MCP content items
 * @returns pi-code content array
 */
function mapContent(
	items: McpContentItem[]
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	return items.map((item) => {
		if (item.type === "image" && item.data && item.mimeType) {
			return {
				type: "image" as const,
				data: item.data,
				mimeType: item.mimeType,
			};
		}
		return { type: "text" as const, text: item.text ?? JSON.stringify(item) };
	});
}

// ── Extension Entry Point ────────────────────────────────────────────────────

/**
 * MCP Adapter extension. Reads mcpServers config from settings.json,
 * spawns servers at session start, registers discovered tools, and
 * provides a /mcp command for listing connected servers.
 * @param pi - Extension API
 */
export default function mcpAdapter(pi: ExtensionAPI) {
	const servers = new Map<string, McpServer>();

	/**
	 * Initializes a server and registers its discovered tools with pi-code.
	 * @param server - MCP server to connect and register tools for
	 * @param ctx - Extension context for logging
	 */
	async function connectAndRegisterTools(server: McpServer, ctx?: ExtensionContext): Promise<void> {
		try {
			await initServer(server);

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

							// Race MCP call against abort signal
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

	// ── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const mcpConfig = loadMcpConfig(ctx.cwd);
		let serverNames = Object.keys(mcpConfig);
		if (serverNames.length === 0) return;

		// Filter servers if PI_MCP_SERVERS env var is set (agent-scoped MCP)
		const allowedServers = process.env.PI_MCP_SERVERS;
		if (allowedServers !== undefined && allowedServers !== "") {
			const allowed = new Set(
				allowedServers
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			);
			serverNames = serverNames.filter((name) => allowed.has(name));
			if (serverNames.length === 0) return;
		}

		// Create server instances (only for allowed servers)
		for (const name of serverNames) {
			const config = mcpConfig[name];
			servers.set(name, {
				name,
				config,
				process: null,
				tools: [],
				ready: false,
				failed: false,
				hasRestarted: false,
				nextId: 1,
				pendingRequests: new Map(),
				buffer: "",
			});
		}

		// Connect all servers
		const serverCount = servers.size;
		ctx.ui.setWorkingMessage(
			`Connecting to ${serverCount} MCP server${serverCount > 1 ? "s" : ""}`
		);
		const connectPromises: Promise<void>[] = [];
		for (const server of servers.values()) {
			connectPromises.push(connectAndRegisterTools(server, ctx));
		}
		await Promise.allSettled(connectPromises);
		ctx.ui.setWorkingMessage();
	});

	// Inject MCP context and usage instructions into system prompt
	pi.on("before_agent_start", async (event) => {
		const connectedServers = [...servers.values()].filter((s) => s.ready);
		if (connectedServers.length === 0) return;

		const lines = [
			"\n# MCP Servers (connected via mcp-adapter extension)\n",
			"The following MCP servers are connected. Their tools are available as mcp__<server>__<tool>.\n",
		];

		for (const server of connectedServers) {
			lines.push(`## ${server.name} (${server.tools.length} tools)`);
			for (const tool of server.tools) {
				const desc = tool.description ? ` - ${tool.description.split(".")[0]}` : "";
				lines.push(`- mcp__${server.name}__${tool.name}${desc}`);
			}
			lines.push("");
		}

		// Documentation lookup instructions (only relevant when tool-proxy docs tools are available)
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
				"4. **NEVER use `web-fetch` for documentation.** The docs tool scrapes, caches, and auto-refreshes. `web-fetch` wastes tokens on raw HTML and the content is lost after the session.\n",
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
		for (const server of servers.values()) {
			if (server.process) {
				server.process.kill("SIGTERM");
				server.process = null;
			}
			server.pendingRequests.clear();
		}
		servers.clear();
	});

	// ── /mcp Command ─────────────────────────────────────────────────────────

	pi.registerCommand("mcp", {
		description: "List connected MCP servers and their tools",
		handler: async (_args, ctx) => {
			if (servers.size === 0) {
				ctx.ui.notify(
					"No MCP servers configured. Add mcpServers to .tallow/settings.json or ~/.tallow/settings.json.",
					"info"
				);
				return;
			}

			const lines: string[] = [];
			for (const server of servers.values()) {
				const status = server.failed
					? `${getIcon("error")} failed`
					: server.ready
						? `${getIcon("in_progress")} connected (${server.tools.length} tools)`
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
