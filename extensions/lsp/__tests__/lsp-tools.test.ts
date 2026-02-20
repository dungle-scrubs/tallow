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
let setLspSpawnForTests: typeof import("../index.js").setLspSpawnForTests;
let setLspTimeoutsForTests: typeof import("../index.js").setLspTimeoutsForTests;

/**
 * Creates a minimal context for tool execution.
 *
 * @param cwd - Working directory for the tool call
 * @returns Stub ExtensionContext
 */
function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			setWorkingMessage() {},
		},
	} as unknown as ExtensionContext;
}

/**
 * Writes a source fixture file.
 *
 * @param rootDir - Temporary project root
 * @param relativePath - File path relative to root
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
 * Gets a tool from the harness and fails loudly when missing.
 *
 * @param harness - Extension harness instance
 * @param name - Tool name
 * @returns Tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) {
		throw new Error(`Expected tool ${name}`);
	}
	return tool;
}

/**
 * Reads the first text content block from a tool result.
 *
 * @param result - Tool result object
 * @returns Text content
 */
function firstText(result: { content: Array<{ text?: string; type: string }> }): string {
	for (const part of result.content) {
		if (part.type === "text" && typeof part.text === "string") {
			return part.text;
		}
	}
	throw new Error("Expected text content in tool result");
}

describe("lsp tool behavior with timeout guards", () => {
	let harness: ExtensionHarness;
	let projectDir: string;

	beforeAll(async () => {
		runtime = setupLspMockRuntime();
		const mod = await import(`../index.js?t=${Date.now()}`);
		lspExtension = mod.default;
		resetLspStateForTests = mod.resetLspStateForTests;
		setLspSpawnForTests = mod.setLspSpawnForTests;
		setLspTimeoutsForTests = mod.setLspTimeoutsForTests;
	});

	afterAll(() => {
		teardownLspMockRuntime();
	});

	beforeEach(async () => {
		runtime.reset();
		resetLspStateForTests();
		setLspSpawnForTests(runtime.spawn);
		setLspTimeoutsForTests({ requestMs: 40, startupMs: 50 });

		projectDir = mkdtempSync(join(tmpdir(), "tallow-lsp-tools-"));
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

	test("formats successful definition responses", async () => {
		const filePath = writeFixture(projectDir, "src/alpha.ts", "export const alpha = 1;\n");
		runtime.behavior.definition = async () => ({
			range: {
				end: { character: 5, line: 1 },
				start: { character: 2, line: 1 },
			},
			uri: `file://${filePath}`,
		});

		const tool = getTool(harness, "lsp_definition");
		const result = await tool.execute(
			"definition-call",
			{ character: 1, file: filePath, line: 1 },
			new AbortController().signal,
			() => {},
			createContext(projectDir)
		);

		expect(result.isError).toBeUndefined();
		expect(firstText(result)).toContain(`${filePath}:2:3`);
	});

	test("aborts in-flight requests and evicts the affected connection", async () => {
		const filePath = writeFixture(projectDir, "src/beta.ts", "export const beta = 2;\n");
		runtime.behavior.definition = async () => new Promise(() => {});

		const tool = getTool(harness, "lsp_definition");
		const controller = new AbortController();
		const pending = tool.execute(
			"abort-call",
			{ character: 1, file: filePath, line: 1 },
			controller.signal,
			() => {},
			createContext(projectDir)
		);

		setTimeout(() => controller.abort(), 5);

		let thrown: unknown;
		try {
			await pending;
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeTruthy();
		expect((thrown as { name?: string }).name).toBe("AbortError");
		expect(runtime.spawnedServers).toHaveLength(1);
		expect(runtime.spawnedServers[0]?.killed).toBe(true);

		const statusTool = getTool(harness, "lsp_status");
		const statusResult = await statusTool.execute(
			"status-after-abort",
			{},
			new AbortController().signal,
			() => {},
			createContext(projectDir)
		);
		expect(firstText(statusResult)).toContain("No language servers running.");
	});

	test("workspace symbol timeout returns bounded error and clears active connection", async () => {
		const filePath = writeFixture(projectDir, "src/gamma.ts", "export const gamma = 3;\n");
		const symbolsTool = getTool(harness, "lsp_symbols");
		const workspaceTool = getTool(harness, "lsp_workspace_symbols");
		const signal = new AbortController().signal;
		const ctx = createContext(projectDir);

		runtime.behavior.documentSymbol = async () => [];
		const warmup = await symbolsTool.execute("warmup", { file: filePath }, signal, () => {}, ctx);
		expect(warmup.isError).toBeUndefined();

		runtime.behavior.workspaceSymbol = async () => new Promise(() => {});

		const timeoutResult = await workspaceTool.execute(
			"workspace-timeout",
			{ query: "gamma" },
			signal,
			() => {},
			ctx
		);

		expect(timeoutResult.isError).toBe(true);
		expect(firstText(timeoutResult)).toContain("Workspace symbols request timed out");
		expect(runtime.spawnedServers).toHaveLength(1);
		expect(runtime.spawnedServers[0]?.killed).toBe(true);

		const afterEviction = await workspaceTool.execute(
			"workspace-after-eviction",
			{ query: "gamma" },
			signal,
			() => {},
			ctx
		);
		expect(firstText(afterEviction)).toContain("No active typescript language server");
	});
});
