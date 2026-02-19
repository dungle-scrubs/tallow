import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import { setupLspMockRuntime } from "./mock-lsp-runtime.js";

const runtime = setupLspMockRuntime();
const {
	default: lspExtension,
	resetLspStateForTests,
	setLspTimeoutsForTests,
} = await import("../index.js");

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

	beforeEach(async () => {
		runtime.reset();
		resetLspStateForTests();
		setLspTimeoutsForTests({ requestMs: 40, startupMs: 50 });

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
		try {
			rmSync(projectDir, { force: true, recursive: true });
		} catch {
			// Ignore temp-dir cleanup errors
		}
	});

	test("returns a bounded startup-timeout error and cleans up process", async () => {
		runtime.behavior.initialize = async () => new Promise(() => {});

		const filePath = writeFixture(projectDir, "src/example.ts", "export const value = 1;\n");
		const lspSymbols = getTool(harness, "lsp_symbols");
		const lspStatus = getTool(harness, "lsp_status");
		const messages: Array<string | undefined> = [];
		const ctx = createToolContext(projectDir, messages);
		const signal = new AbortController().signal;

		const start = Date.now();
		const result = await lspSymbols.execute("test-call", { file: filePath }, signal, () => {}, ctx);
		const elapsed = Date.now() - start;

		expect(result.isError).toBe(true);
		expect(getText(result)).toContain("Language server startup timed out");
		expect(elapsed).toBeLessThan(500);
		expect(runtime.spawnedServers).toHaveLength(1);
		expect(runtime.spawnedServers[0]?.killed).toBe(true);
		expect(messages.at(-1)).toBeUndefined();

		const status = await lspStatus.execute("status-call", {}, signal, () => {}, ctx);
		expect(getText(status)).toContain("No language servers running.");
	});

	test("propagates startup abort without waiting for timeout", async () => {
		runtime.behavior.which = async () => new Promise(() => {});

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
