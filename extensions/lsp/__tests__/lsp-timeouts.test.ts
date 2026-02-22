import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import {
	type LspMockRuntime,
	setupLspMockRuntime,
	teardownLspMockRuntime,
} from "./mock-lsp-runtime.js";

let runtime: LspMockRuntime;
let lspExtension: typeof import("../index.js").default;
let resetLspStateForTests: typeof import("../index.js").resetLspStateForTests;
let setLspProtocolBindingsForTests: typeof import("../index.js").setLspProtocolBindingsForTests;
let setLspSpawnForTests: typeof import("../index.js").setLspSpawnForTests;
let setLspTimeoutsForTests: typeof import("../index.js").setLspTimeoutsForTests;

/**
 * Creates a minimal extension context and records working-message transitions.
 *
 * @param cwd - Working directory for tool execution
 * @param messages - Sink for working-message updates
 * @returns Extension context stub
 */
function createToolContext(cwd: string, messages: Array<string | undefined>): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			setWorkingMessage(message?: string) {
				messages.push(message);
			},
		},
	} as unknown as ExtensionContext;
}

/**
 * Writes a fixture file under the temp project.
 *
 * @param rootDir - Temporary project root
 * @param relativePath - Path relative to root
 * @param content - File contents
 * @returns Absolute file path
 */
function writeFixture(rootDir: string, relativePath: string, content: string): string {
	const absolutePath = join(rootDir, relativePath);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, content, "utf-8");
	return absolutePath;
}

/**
 * Writes a JSON fixture file.
 *
 * @param filePath - Absolute path to write
 * @param payload - JSON value to stringify
 * @returns Nothing
 */
function writeJson(filePath: string, payload: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(payload), "utf-8");
}

/**
 * Captures timeout durations used by setTimeout while forcing immediate execution.
 *
 * @param action - Async action to run under the patched timer
 * @returns Captured timeout durations in milliseconds
 */
async function captureTimeoutDelays(action: () => Promise<void>): Promise<number[]> {
	const delays: number[] = [];
	const originalSetTimeout = globalThis.setTimeout;

	globalThis.setTimeout = ((
		callback: Parameters<typeof setTimeout>[0],
		delay?: Parameters<typeof setTimeout>[1],
		...args: unknown[]
	) => {
		delays.push(typeof delay === "number" ? delay : 0);
		return originalSetTimeout(() => {
			if (typeof callback === "function") {
				callback(...args);
			}
		}, 0);
	}) as typeof setTimeout;

	try {
		await action();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}

	return delays;
}

/**
 * Looks up a registered tool and throws when missing.
 *
 * @param harness - Extension harness instance
 * @param name - Tool name
 * @returns Registered tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) {
		throw new Error(`Expected tool ${name}`);
	}
	return tool;
}

/**
 * Extracts the first text content block from a tool result.
 *
 * @param result - Tool result payload
 * @returns First text block content
 */
function getText(result: { content: Array<{ text?: string; type: string }> }): string {
	for (const part of result.content) {
		if (part.type === "text" && typeof part.text === "string") {
			return part.text;
		}
	}
	throw new Error("Expected a text block in tool result");
}

describe("lsp timeout guards", () => {
	let harness: ExtensionHarness;
	let projectDir: string;
	let agentDir: string;
	let previousAgentDirEnv: string | undefined;

	beforeAll(async () => {
		runtime = setupLspMockRuntime();
		const mod = await import(`../index.js?t=${Date.now()}`);
		lspExtension = mod.default;
		resetLspStateForTests = mod.resetLspStateForTests;
		setLspProtocolBindingsForTests = mod.setLspProtocolBindingsForTests;
		setLspSpawnForTests = mod.setLspSpawnForTests;
		setLspTimeoutsForTests = mod.setLspTimeoutsForTests;
	});

	afterAll(() => {
		teardownLspMockRuntime();
	});

	beforeEach(async () => {
		runtime.reset();
		resetLspStateForTests();
		setLspProtocolBindingsForTests(runtime.protocol);
		setLspSpawnForTests(runtime.spawn);
		setLspTimeoutsForTests({ requestMs: 40 });

		agentDir = mkdtempSync(join(tmpdir(), "tallow-lsp-agent-"));
		previousAgentDirEnv = process.env.TALLOW_CODING_AGENT_DIR;
		process.env.TALLOW_CODING_AGENT_DIR = agentDir;

		projectDir = mkdtempSync(join(tmpdir(), "tallow-lsp-timeouts-"));
		harness = ExtensionHarness.create();
		await harness.loadExtension(lspExtension);
	});

	afterEach(() => {
		try {
			harness.reset();
		} catch {
			// Ignore harness cleanup errors in tests
		}
		try {
			resetLspStateForTests();
		} catch {
			// Ignore state cleanup errors in tests
		}
		if (previousAgentDirEnv === undefined) {
			delete process.env.TALLOW_CODING_AGENT_DIR;
		} else {
			process.env.TALLOW_CODING_AGENT_DIR = previousAgentDirEnv;
		}
		try {
			rmSync(agentDir, { force: true, recursive: true });
		} catch {
			// Ignore temp-dir cleanup errors
		}
		try {
			rmSync(projectDir, { force: true, recursive: true });
		} catch {
			// Ignore temp-dir cleanup errors
		}
	});

	test("uses the default startup timeout when config is missing", async () => {
		const previousInitialize = runtime.behavior.initialize;
		runtime.behavior.initialize = async () => new Promise(() => {});

		try {
			const filePath = writeFixture(
				projectDir,
				"src/default-timeout.ts",
				"export const value = 1;\n"
			);
			const lspSymbols = getTool(harness, "lsp_symbols");
			const messages: Array<string | undefined> = [];
			const ctx = createToolContext(projectDir, messages);
			const signal = new AbortController().signal;
			let result:
				| { content: Array<{ text?: string; type: string }>; isError?: boolean }
				| undefined;

			const delays = await captureTimeoutDelays(async () => {
				result = await lspSymbols.execute(
					"default-timeout",
					{ file: filePath },
					signal,
					() => {},
					ctx
				);
			});

			expect(result?.isError).toBe(true);
			expect(getText(result as { content: Array<{ text?: string; type: string }> })).toContain(
				"Language server startup timed out"
			);
			expect(delays).toContain(10_000);
			expect(runtime.spawnedServers).toHaveLength(1);
			expect(runtime.spawnedServers[0]?.killed).toBe(true);
			expect(messages.at(-1)).toBeUndefined();
		} finally {
			runtime.behavior.initialize = previousInitialize;
		}
	});

	test("project startup-timeout overrides user settings", async () => {
		const previousInitialize = runtime.behavior.initialize;
		runtime.behavior.initialize = async () => new Promise(() => {});

		writeJson(join(agentDir, "settings.json"), { lsp: { startupTimeoutMs: 150 } });
		writeJson(join(projectDir, ".tallow", "settings.json"), {
			lsp: { startupTimeoutMs: 25 },
		});

		try {
			const filePath = writeFixture(
				projectDir,
				"src/project-timeout.ts",
				"export const value = 2;\n"
			);
			const lspSymbols = getTool(harness, "lsp_symbols");
			const messages: Array<string | undefined> = [];
			const ctx = createToolContext(projectDir, messages);
			const signal = new AbortController().signal;
			let result:
				| { content: Array<{ text?: string; type: string }>; isError?: boolean }
				| undefined;

			const delays = await captureTimeoutDelays(async () => {
				result = await lspSymbols.execute(
					"project-timeout",
					{ file: filePath },
					signal,
					() => {},
					ctx
				);
			});

			expect(result?.isError).toBe(true);
			expect(getText(result as { content: Array<{ text?: string; type: string }> })).toContain(
				"Language server startup timed out"
			);
			expect(delays).toContain(25);
			expect(delays).not.toContain(150);
		} finally {
			runtime.behavior.initialize = previousInitialize;
		}
	});

	test("uses user startup-timeout when project value is invalid", async () => {
		const previousInitialize = runtime.behavior.initialize;
		runtime.behavior.initialize = async () => new Promise(() => {});

		writeJson(join(agentDir, "settings.json"), { lsp: { startupTimeoutMs: 80 } });
		writeJson(join(projectDir, ".tallow", "settings.json"), {
			lsp: { startupTimeoutMs: "fast" },
		});

		try {
			const filePath = writeFixture(
				projectDir,
				"src/user-fallback-timeout.ts",
				"export const value = 3;\n"
			);
			const lspSymbols = getTool(harness, "lsp_symbols");
			const messages: Array<string | undefined> = [];
			const ctx = createToolContext(projectDir, messages);
			const signal = new AbortController().signal;
			let result:
				| { content: Array<{ text?: string; type: string }>; isError?: boolean }
				| undefined;

			const delays = await captureTimeoutDelays(async () => {
				result = await lspSymbols.execute(
					"user-fallback-timeout",
					{ file: filePath },
					signal,
					() => {},
					ctx
				);
			});

			expect(result?.isError).toBe(true);
			expect(getText(result as { content: Array<{ text?: string; type: string }> })).toContain(
				"Language server startup timed out"
			);
			expect(delays).toContain(80);
			expect(delays).not.toContain(10_000);
		} finally {
			runtime.behavior.initialize = previousInitialize;
		}
	});

	test("falls back to default timeout when startup-timeout config is invalid", async () => {
		const previousInitialize = runtime.behavior.initialize;
		runtime.behavior.initialize = async () => new Promise(() => {});

		writeJson(join(projectDir, ".tallow", "settings.json"), {
			lsp: { startupTimeoutMs: "fast" },
		});

		try {
			const filePath = writeFixture(
				projectDir,
				"src/invalid-timeout.ts",
				"export const value = 3;\n"
			);
			const lspSymbols = getTool(harness, "lsp_symbols");
			const messages: Array<string | undefined> = [];
			const ctx = createToolContext(projectDir, messages);
			const signal = new AbortController().signal;
			let result:
				| { content: Array<{ text?: string; type: string }>; isError?: boolean }
				| undefined;

			const delays = await captureTimeoutDelays(async () => {
				result = await lspSymbols.execute(
					"invalid-timeout",
					{ file: filePath },
					signal,
					() => {},
					ctx
				);
			});

			expect(result?.isError).toBe(true);
			expect(getText(result as { content: Array<{ text?: string; type: string }> })).toContain(
				"Language server startup timed out"
			);
			expect(delays).toContain(10_000);
		} finally {
			runtime.behavior.initialize = previousInitialize;
		}
	});

	test("startup-timeout failure kills server process and clears active state", async () => {
		const previousInitialize = runtime.behavior.initialize;
		runtime.behavior.initialize = async () => new Promise(() => {});
		writeJson(join(projectDir, ".tallow", "settings.json"), {
			lsp: { startupTimeoutMs: 50 },
		});

		try {
			const filePath = writeFixture(projectDir, "src/example.ts", "export const value = 1;\n");
			const lspSymbols = getTool(harness, "lsp_symbols");
			const lspStatus = getTool(harness, "lsp_status");
			const messages: Array<string | undefined> = [];
			const ctx = createToolContext(projectDir, messages);
			const signal = new AbortController().signal;

			const start = Date.now();
			const result = await lspSymbols.execute(
				"test-call",
				{ file: filePath },
				signal,
				() => {},
				ctx
			);
			const elapsed = Date.now() - start;

			expect(result.isError).toBe(true);
			expect(getText(result)).toContain("Language server startup timed out");
			expect(elapsed).toBeLessThan(500);
			expect(runtime.spawnedServers).toHaveLength(1);
			expect(runtime.spawnedServers[0]?.killed).toBe(true);
			expect(messages.at(-1)).toBeUndefined();

			const status = await lspStatus.execute("status-call", {}, signal, () => {}, ctx);
			expect(getText(status)).toContain("No language servers running.");
		} finally {
			runtime.behavior.initialize = previousInitialize;
		}
	});

	test("propagates startup abort without waiting for timeout", async () => {
		const previousWhich = runtime.behavior.which;
		runtime.behavior.which = async () => new Promise(() => {});

		try {
			const filePath = writeFixture(projectDir, "src/abort-startup.ts", "export const x = 1;\n");
			const lspSymbols = getTool(harness, "lsp_symbols");
			const messages: Array<string | undefined> = [];
			const ctx = createToolContext(projectDir, messages);
			const controller = new AbortController();
			controller.abort();

			let thrown: unknown;
			try {
				await lspSymbols.execute(
					"startup-abort",
					{ file: filePath },
					controller.signal,
					() => {},
					ctx
				);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeTruthy();
			expect((thrown as { name?: string }).name).toBe("AbortError");
			expect(runtime.spawnedServers).toHaveLength(0);
			expect(messages.at(-1)).toBeUndefined();
		} finally {
			runtime.behavior.which = previousWhich;
		}
	});

	test("times out stuck requests, evicts the connection, and allows retry", async () => {
		const filePath = writeFixture(
			projectDir,
			"src/retry.ts",
			"export function greet() { return 1; }\n"
		);
		const lspSymbols = getTool(harness, "lsp_symbols");
		const lspStatus = getTool(harness, "lsp_status");
		const messages: Array<string | undefined> = [];
		const ctx = createToolContext(projectDir, messages);
		const signal = new AbortController().signal;

		runtime.behavior.documentSymbol = async () => new Promise(() => {});

		const timeoutResult = await lspSymbols.execute(
			"timeout-call",
			{ file: filePath },
			signal,
			() => {},
			ctx
		);

		expect(timeoutResult.isError).toBe(true);
		expect(getText(timeoutResult)).toContain("Document symbols request timed out");
		expect(runtime.spawnedServers).toHaveLength(1);
		expect(runtime.spawnedServers[0]?.killed).toBe(true);

		const statusAfterTimeout = await lspStatus.execute("status-1", {}, signal, () => {}, ctx);
		expect(getText(statusAfterTimeout)).toContain("No language servers running.");

		runtime.behavior.documentSymbol = async () => [
			{
				kind: 12,
				name: "greet",
				range: {
					end: { character: 5, line: 0 },
					start: { character: 0, line: 0 },
				},
			},
		];

		const successResult = await lspSymbols.execute(
			"retry-call",
			{ file: filePath },
			signal,
			() => {},
			ctx
		);
		expect(successResult.isError).toBeUndefined();
		expect(getText(successResult)).toContain("greet (Function) - line 1");
		expect(runtime.spawnedServers).toHaveLength(2);
		expect(runtime.spawnedServers[1]?.killed).toBe(false);
	});
});
