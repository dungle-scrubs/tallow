import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import lspExtension from "../index.js";
import {
	applyTextEdits,
	setTypeScriptModuleForRefactorTests,
	stageWorkspaceEdit,
} from "../refactor.js";

/**
 * Creates a minimal context for refactor tool execution.
 *
 * @param cwd - Tool working directory
 * @returns Extension context stub
 */
function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		ui: { setWorkingMessage() {} },
	} as unknown as ExtensionContext;
}

/**
 * Writes a fixture file under a project root.
 *
 * @param root - Fixture project root
 * @param relativePath - File path relative to root
 * @param content - File contents
 * @returns Absolute file path
 */
function writeFixture(root: string, relativePath: string, content: string): string {
	const filePath = join(root, relativePath);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

/**
 * Reads a fixture file as UTF-8.
 *
 * @param root - Fixture project root
 * @param relativePath - File path relative to root
 * @returns File contents
 */
function readFixture(root: string, relativePath: string): string {
	return readFileSync(join(root, relativePath), "utf-8");
}

/**
 * Looks up a registered tool and throws when missing.
 *
 * @param harness - Extension harness
 * @param name - Tool name
 * @returns Registered tool
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Expected tool ${name}`);
	return tool;
}

/**
 * Extracts the first text response from a tool result.
 *
 * @param result - Tool result
 * @returns Text response
 */
function textOf(result: { content: Array<{ text?: string; type: string }> }): string {
	const text = result.content.find((part) => part.type === "text")?.text;
	if (!text) throw new Error("Expected text result");
	return text;
}

/**
 * Executes a registered tool with a default signal and noop update callback.
 *
 * @param tool - Tool to execute
 * @param params - Tool parameters
 * @param cwd - Working directory
 * @returns Tool result
 */
async function executeTool(tool: ToolDefinition, params: object, cwd: string) {
	return tool.execute(
		"test-call",
		params,
		new AbortController().signal,
		() => {},
		createContext(cwd)
	);
}

describe("refactor workspace edit helpers", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "tallow-refactor-helpers-"));
	});

	afterEach(() => {
		rmSync(projectDir, { force: true, recursive: true });
	});

	test("applies multiple edits in reverse order", () => {
		expect(
			applyTextEdits("alpha beta gamma", [
				{ end: 16, newText: "delta", start: 11 },
				{ end: 5, newText: "omega", start: 0 },
			])
		).toBe("omega beta delta");
	});

	test("rejects overlapping edits", () => {
		writeFixture(projectDir, "src/example.ts", "abcdef\n");
		expect(() =>
			stageWorkspaceEdit(projectDir, [
				{
					fileName: join(projectDir, "src/example.ts"),
					textChanges: [
						{ newText: "X", span: { length: 3, start: 1 } },
						{ newText: "Y", span: { length: 3, start: 2 } },
					],
				},
			])
		).toThrow("Overlapping edits");
	});

	test("rejects edits outside the project root", () => {
		expect(() =>
			stageWorkspaceEdit(projectDir, [
				{
					fileName: join(projectDir, "..", "outside.ts"),
					textChanges: [{ newText: "x", span: { length: 0, start: 0 } }],
				},
			])
		).toThrow("outside project root");
	});
});

describe("refactor TypeScript tools", () => {
	let harness: ExtensionHarness;
	let projectDir: string;

	beforeEach(async () => {
		projectDir = mkdtempSync(join(tmpdir(), "tallow-refactor-tools-"));
		writeFixture(
			projectDir,
			"tsconfig.json",
			JSON.stringify({
				compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022" },
				include: ["src"],
			})
		);
		harness = ExtensionHarness.create();
		await harness.loadExtension(lspExtension);
	});

	afterEach(() => {
		setTypeScriptModuleForRefactorTests();
		harness.reset();
		rmSync(projectDir, { force: true, recursive: true });
	});

	test("renames a symbol across declarations, references, and imports", async () => {
		writeFixture(projectDir, "src/lib.ts", "export function useBffChat() {\n\treturn 'ok';\n}\n");
		writeFixture(
			projectDir,
			"src/app.ts",
			"import { useBffChat } from './lib';\n\nexport const result = useBffChat();\n"
		);
		const tool = getTool(harness, "refactor_rename_symbol");

		const dryRun = await executeTool(
			tool,
			{ character: 17, file: "src/lib.ts", line: 1, newName: "useChat" },
			projectDir
		);
		expect(dryRun.isError).toBeUndefined();
		expect(textOf(dryRun)).toContain("Preview: 2 file(s)");
		expect(readFixture(projectDir, "src/lib.ts")).toContain("useBffChat");

		const applied = await executeTool(
			tool,
			{ character: 17, dryRun: false, file: "src/lib.ts", line: 1, newName: "useChat" },
			projectDir
		);
		expect(applied.isError).toBeUndefined();
		expect(readFixture(projectDir, "src/lib.ts")).toContain("useChat");
		expect(readFixture(projectDir, "src/app.ts")).toContain("import { useChat } from './lib';");
		expect(readFixture(projectDir, "src/app.ts")).toContain("useChat()");
	});

	test("moves a file and updates relative imports", async () => {
		writeFixture(projectDir, "src/utils/constants.ts", "export const one = 1;\n");
		writeFixture(
			projectDir,
			"src/utils/math.ts",
			"import { one } from './constants';\n\nexport const add = (a: number, b: number) => a + b + one;\n"
		);
		writeFixture(
			projectDir,
			"src/app.ts",
			"import { add } from './utils/math';\n\nexport const value = add(1, 2);\n"
		);
		const tool = getTool(harness, "refactor_move_file");

		const dryRun = await executeTool(
			tool,
			{ from: "src/utils/math.ts", to: "src/lib/math.ts" },
			projectDir
		);
		expect(dryRun.isError).toBeUndefined();
		expect(textOf(dryRun)).toContain("src/lib/math.ts");
		expect(readFixture(projectDir, "src/app.ts")).toContain("./utils/math");

		const applied = await executeTool(
			tool,
			{ dryRun: false, from: "src/utils/math.ts", to: "src/lib/math.ts" },
			projectDir
		);
		expect(applied.isError).toBeUndefined();
		expect(readFixture(projectDir, "src/app.ts")).toContain("./lib/math");
		expect(readFixture(projectDir, "src/lib/math.ts")).toContain("export const add");
		expect(readFixture(projectDir, "src/lib/math.ts")).toContain("../utils/constants");
		expect(() => readFixture(projectDir, "src/utils/math.ts")).toThrow();
	});

	test("organizes imports with dry-run preview and apply", async () => {
		writeFixture(projectDir, "src/a.ts", "export const a = 1;\n");
		writeFixture(projectDir, "src/b.ts", "export const b = 2;\n");
		writeFixture(
			projectDir,
			"src/app.ts",
			"import { b } from './b';\nimport { a } from './a';\nimport { missing } from './missing';\n\nconsole.log(a);\n"
		);
		const tool = getTool(harness, "refactor_organize_imports");

		const dryRun = await executeTool(tool, { files: ["src/app.ts"] }, projectDir);
		expect(dryRun.isError).toBeUndefined();
		expect(textOf(dryRun)).toContain("Preview: 1 file(s)");
		expect(readFixture(projectDir, "src/app.ts")).toContain("missing");

		const applied = await executeTool(tool, { dryRun: false, files: ["src/app.ts"] }, projectDir);
		expect(applied.isError).toBeUndefined();
		expect(readFixture(projectDir, "src/app.ts")).not.toContain("missing");
		expect(readFixture(projectDir, "src/app.ts")).not.toContain("./b");
	});

	test("requires force for excessive apply edits", async () => {
		writeFixture(projectDir, "src/lib.ts", "export function useBffChat() {\n\treturn 'ok';\n}\n");
		writeFixture(
			projectDir,
			"src/app.ts",
			`import { useBffChat } from './lib';\n\n${Array.from({ length: 251 }, (_, index) => `export const result${index} = useBffChat();`).join("\n")}\n`
		);
		const tool = getTool(harness, "refactor_rename_symbol");

		const blocked = await executeTool(
			tool,
			{ character: 17, dryRun: false, file: "src/lib.ts", line: 1, newName: "useChat" },
			projectDir
		);
		expect(blocked.isError).toBe(true);
		expect(textOf(blocked)).toContain("force:true");
		expect(readFixture(projectDir, "src/app.ts")).toContain("useBffChat");
	});

	test("reports missing TypeScript clearly", async () => {
		writeFixture(projectDir, "src/lib.ts", "export const value = 1;\n");
		setTypeScriptModuleForRefactorTests(new Error("TypeScript is required for refactor tools"));
		const tool = getTool(harness, "refactor_rename_symbol");

		const result = await executeTool(
			tool,
			{ character: 14, file: "src/lib.ts", line: 1, newName: "renamed" },
			projectDir
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("TypeScript is required");
	});

	test("fails safely for invalid rename inputs and outside paths", async () => {
		writeFixture(projectDir, "src/lib.ts", "export const value = 1;\n");
		const renameTool = getTool(harness, "refactor_rename_symbol");
		const moveTool = getTool(harness, "refactor_move_file");

		const invalidName = await executeTool(
			renameTool,
			{ character: 14, dryRun: false, file: "src/lib.ts", line: 1, newName: "bad-name" },
			projectDir
		);
		expect(invalidName.isError).toBe(true);
		expect(readFixture(projectDir, "src/lib.ts")).toContain("value");

		const outside = await executeTool(
			moveTool,
			{ dryRun: false, from: "src/lib.ts", to: "../lib.ts" },
			projectDir
		);
		expect(outside.isError).toBe(true);
		expect(textOf(outside)).toContain("outside project root");
	});
});
