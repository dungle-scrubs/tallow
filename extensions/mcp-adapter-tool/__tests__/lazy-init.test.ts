import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, RegisteredCommand } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import mcpAdapter from "../index.js";

interface NotificationRecord {
	readonly level: string;
	readonly message: string;
}

let cwd: string;
let homeDir: string;
let harness: ExtensionHarness;
let originalHome: string | undefined;
let originalFetch: typeof fetch;
let originalTrustStatus: string | undefined;
let originalMcpServersFilter: string | undefined;
let notifications: NotificationRecord[];

/**
 * Write JSON content to disk, creating parent directories as needed.
 *
 * @param filePath - Target JSON file path
 * @param value - JSON-serializable payload
 * @returns void
 */
function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Create a minimal extension context for firing events and commands.
 *
 * @returns Extension context with notification tracking
 */
function createContext(): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		ui: {
			notify(message: string, level: string): void {
				notifications.push({ level, message });
			},
			async select() {
				return undefined;
			},
			async confirm() {
				return false;
			},
			async input() {
				return undefined;
			},
			setStatus() {},
			setWorkingMessage() {},
			setWidget() {},
			setFooter() {},
			setHeader() {},
			setTitle() {},
			async custom() {
				return undefined as never;
			},
			pasteToEditor() {},
			setEditorText() {},
			getEditorText() {
				return "";
			},
			async editor() {
				return undefined;
			},
			setEditorComponent() {},
			getToolsExpanded() {
				return false;
			},
			setToolsExpanded() {},
		} as never,
	} as unknown as ExtensionContext;
}

/**
 * Retrieve the registered /mcp command from the harness.
 *
 * @returns /mcp command definition
 */
function getMcpCommand(): Omit<RegisteredCommand, "name"> {
	const command = harness.commands.get("mcp");
	if (!command) {
		throw new Error('Command "mcp" not registered');
	}
	return command;
}

/**
 * Parse a JSON-RPC request body from a mocked fetch call.
 *
 * @param init - Fetch init options containing the JSON body
 * @returns Parsed JSON-RPC request with id and method
 */
function parseJsonRpcRequest(init?: RequestInit): { id: number; method: string } {
	if (typeof init?.body !== "string") {
		throw new Error("Expected JSON string body in mocked fetch request");
	}

	const request = JSON.parse(init.body) as { id?: unknown; method?: unknown };
	if (typeof request.id !== "number" || typeof request.method !== "string") {
		throw new Error("Invalid JSON-RPC request payload");
	}

	return { id: request.id, method: request.method };
}

/**
 * Build an application/json JSON-RPC success response.
 *
 * @param id - Request identifier
 * @param result - JSON-RPC result payload
 * @returns HTTP response carrying a JSON-RPC result
 */
function createJsonRpcResponse(id: number, result: unknown): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(async () => {
	cwd = mkdtempSync(join(tmpdir(), "tallow-mcp-lazy-cwd-"));
	homeDir = mkdtempSync(join(tmpdir(), "tallow-mcp-lazy-home-"));
	notifications = [];

	originalHome = process.env.HOME;
	originalFetch = globalThis.fetch;
	originalTrustStatus = process.env.TALLOW_PROJECT_TRUST_STATUS;
	originalMcpServersFilter = process.env.PI_MCP_SERVERS;

	process.env.HOME = homeDir;
	process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
	delete process.env.PI_MCP_SERVERS;

	harness = ExtensionHarness.create();
	await harness.loadExtension(mcpAdapter);
});

afterEach(() => {
	if (originalHome !== undefined) process.env.HOME = originalHome;
	else delete process.env.HOME;

	if (originalTrustStatus !== undefined) {
		process.env.TALLOW_PROJECT_TRUST_STATUS = originalTrustStatus;
	} else {
		delete process.env.TALLOW_PROJECT_TRUST_STATUS;
	}

	if (originalMcpServersFilter !== undefined) {
		process.env.PI_MCP_SERVERS = originalMcpServersFilter;
	} else {
		delete process.env.PI_MCP_SERVERS;
	}

	globalThis.fetch = originalFetch;

	rmSync(cwd, { force: true, recursive: true });
	rmSync(homeDir, { force: true, recursive: true });
});

describe("mcp lazy initialization", () => {
	test("session_start keeps trust warning but defers MCP connection work", async () => {
		writeJson(join(homeDir, ".tallow", "settings.json"), {
			mcpServers: {
				global: { type: "streamable-http", url: "http://localhost:3110/mcp" },
			},
		});
		writeJson(join(cwd, ".tallow", "settings.json"), {
			mcpServers: {
				project: { command: "project-cmd" },
			},
		});
		process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";

		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("fetch should not run during session_start");
		}) as typeof fetch;

		await harness.fireEvent("session_start", { type: "session_start" }, createContext());

		expect(fetchCalls).toBe(0);
		expect(harness.tools.size).toBe(0);
		expect(
			notifications.some(
				(n) => n.level === "warning" && n.message.includes("skipped project mcpServers")
			)
		).toBe(true);
	});

	test("before_agent_start initializes MCP once and registers discovered tools", async () => {
		writeJson(join(homeDir, ".tallow", "settings.json"), {
			mcpServers: {
				mock: { type: "streamable-http", url: "http://localhost:3111/mcp" },
			},
		});

		const rpcMethods: string[] = [];
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const request = parseJsonRpcRequest(init);
			rpcMethods.push(request.method);

			if (request.method === "initialize") {
				return createJsonRpcResponse(request.id, {});
			}
			if (request.method === "tools/list") {
				return createJsonRpcResponse(request.id, {
					tools: [
						{
							name: "ping",
							description: "Ping mock MCP server",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				});
			}

			throw new Error(`Unexpected JSON-RPC method: ${request.method}`);
		}) as typeof fetch;

		const context = createContext();
		await harness.fireEvent("session_start", { type: "session_start" }, context);
		expect(rpcMethods).toEqual([]);

		const [firstResult] = await harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "base\n" },
			context
		);

		expect(rpcMethods).toEqual(["initialize", "tools/list"]);
		expect(harness.tools.has("mcp__mock__ping")).toBe(true);
		expect(
			((firstResult as { systemPrompt?: string } | undefined)?.systemPrompt ?? "").includes(
				"mcp__mock__ping"
			)
		).toBe(true);

		await harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "base\n" },
			context
		);
		expect(rpcMethods).toEqual(["initialize", "tools/list"]);
	});

	test("/mcp initializes MCP when run before the first model turn", async () => {
		writeJson(join(homeDir, ".tallow", "settings.json"), {
			mcpServers: {
				mock: { type: "streamable-http", url: "http://localhost:3112/mcp" },
			},
		});

		const rpcMethods: string[] = [];
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const request = parseJsonRpcRequest(init);
			rpcMethods.push(request.method);

			if (request.method === "initialize") {
				return createJsonRpcResponse(request.id, {});
			}
			if (request.method === "tools/list") {
				return createJsonRpcResponse(request.id, {
					tools: [
						{
							name: "ping",
							description: "Ping mock MCP server",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				});
			}

			throw new Error(`Unexpected JSON-RPC method: ${request.method}`);
		}) as typeof fetch;

		const context = createContext();
		await harness.fireEvent("session_start", { type: "session_start" }, context);
		await getMcpCommand().handler("", context as never);

		expect(rpcMethods).toEqual(["initialize", "tools/list"]);
		expect(harness.tools.has("mcp__mock__ping")).toBe(true);
		expect(notifications.some((n) => n.message.includes("mcp__mock__ping"))).toBe(true);
	});

	test("dedupes concurrent initialization triggers", async () => {
		writeJson(join(homeDir, ".tallow", "settings.json"), {
			mcpServers: {
				mock: { type: "streamable-http", url: "http://localhost:3113/mcp" },
			},
		});

		const rpcMethods: string[] = [];
		let releaseInitialize: (() => void) | null = null;
		const initializeGate = new Promise<void>((resolve) => {
			releaseInitialize = resolve;
		});

		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const request = parseJsonRpcRequest(init);
			rpcMethods.push(request.method);

			if (request.method === "initialize") {
				await initializeGate;
				return createJsonRpcResponse(request.id, {});
			}
			if (request.method === "tools/list") {
				return createJsonRpcResponse(request.id, {
					tools: [
						{
							name: "ping",
							description: "Ping mock MCP server",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				});
			}

			throw new Error(`Unexpected JSON-RPC method: ${request.method}`);
		}) as typeof fetch;

		const context = createContext();
		await harness.fireEvent("session_start", { type: "session_start" }, context);

		const beforeAgentPromise = harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "base\n" },
			context
		);
		const commandPromise = getMcpCommand().handler("", context as never);

		await Promise.resolve();
		releaseInitialize?.();

		await Promise.all([beforeAgentPromise, commandPromise]);
		expect(rpcMethods.filter((method) => method === "initialize")).toHaveLength(1);
		expect(rpcMethods.filter((method) => method === "tools/list")).toHaveLength(1);
		expect(harness.tools.has("mcp__mock__ping")).toBe(true);
	});
});
