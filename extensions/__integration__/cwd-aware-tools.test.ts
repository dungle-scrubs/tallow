import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../test-utils/extension-harness.js";
import bashToolEnhanced from "../bash-tool-enhanced/index.js";
import editToolEnhanced from "../edit-tool-enhanced/index.js";
import fileReference from "../file-reference/index.js";
import readToolEnhanced from "../read-tool-enhanced/index.js";
import writeToolEnhanced from "../write-tool-enhanced/index.js";

let originalCwd = "";
let processDir = "";
let sessionDir = "";

/**
 * Build the minimal extension context shape needed by the enhanced tools.
 *
 * @param cwd - Effective session working directory
 * @returns Minimal extension context
 */
function createContext(cwd: string): ExtensionContext {
	return {
		abort() {},
		compact() {},
		cwd,
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		hasPendingMessages: () => false,
		hasUI: true,
		isIdle: () => true,
		model: undefined,
		modelRegistry: {} as never,
		sessionManager: {} as never,
		shutdown() {},
		ui: {
			getToolsExpanded: () => false,
			notify() {},
			setToolsExpanded() {},
			setWorkingMessage() {},
		} as never,
	} as ExtensionContext;
}

beforeEach(() => {
	originalCwd = process.cwd();
	processDir = mkdtempSync(join(tmpdir(), "tallow-cwd-process-"));
	sessionDir = mkdtempSync(join(tmpdir(), "tallow-cwd-session-"));
	process.chdir(processDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(processDir, { force: true, recursive: true });
	rmSync(sessionDir, { force: true, recursive: true });
});

describe("cwd-aware enhanced tools", () => {
	test("write uses ctx.cwd instead of process.cwd", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(writeToolEnhanced);
		const tool = harness.tools.get("write");
		if (!tool) throw new Error("write tool missing");

		await tool.execute(
			"tc-write",
			{ content: "session", path: "note.txt" },
			undefined,
			() => {},
			createContext(sessionDir)
		);

		expect(readFileSync(join(sessionDir, "note.txt"), "utf-8")).toBe("session");
		expect(() => readFileSync(join(processDir, "note.txt"), "utf-8")).toThrow();
	});

	test("edit uses ctx.cwd instead of process.cwd", async () => {
		writeFileSync(join(processDir, "file.txt"), "process", "utf-8");
		writeFileSync(join(sessionDir, "file.txt"), "session", "utf-8");
		const harness = ExtensionHarness.create();
		await harness.loadExtension(editToolEnhanced);
		const tool = harness.tools.get("edit");
		if (!tool) throw new Error("edit tool missing");

		await tool.execute(
			"tc-edit",
			{ newText: "updated", oldText: "session", path: "file.txt" },
			undefined,
			() => {},
			createContext(sessionDir)
		);

		expect(readFileSync(join(sessionDir, "file.txt"), "utf-8")).toBe("updated");
		expect(readFileSync(join(processDir, "file.txt"), "utf-8")).toBe("process");
	});

	test("read uses ctx.cwd instead of process.cwd", async () => {
		writeFileSync(join(processDir, "file.txt"), "process", "utf-8");
		writeFileSync(join(sessionDir, "file.txt"), "session", "utf-8");
		const harness = ExtensionHarness.create();
		await harness.loadExtension(readToolEnhanced);
		const tool = harness.tools.get("read");
		if (!tool) throw new Error("read tool missing");

		const result = await tool.execute(
			"tc-read",
			{ path: "file.txt" },
			undefined,
			() => {},
			createContext(sessionDir)
		);
		const text = result.content.find((entry) => entry.type === "text");
		if (!text || text.type !== "text") throw new Error("text result missing");

		expect(text.text).toContain("session");
		expect(text.text).not.toContain("process");
	});

	test("bash uses ctx.cwd instead of process.cwd", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(bashToolEnhanced);
		const tool = harness.tools.get("bash");
		if (!tool) throw new Error("bash tool missing");

		const result = await tool.execute(
			"tc-bash",
			{ command: "pwd" },
			undefined,
			() => {},
			createContext(sessionDir)
		);
		const text = result.content.find((entry) => entry.type === "text");
		if (!text || text.type !== "text") throw new Error("text result missing");

		expect(text.text.trim()).toBe(realpathSync(sessionDir));
	});

	test("file references expand from ctx.cwd instead of process.cwd", async () => {
		writeFileSync(join(processDir, "snippet.ts"), 'export const value = "process";\n', "utf-8");
		writeFileSync(join(sessionDir, "snippet.ts"), 'export const value = "session";\n', "utf-8");
		const harness = ExtensionHarness.create();
		await harness.loadExtension(fileReference);

		const [result] = await harness.fireEvent(
			"input",
			{ text: "Inspect @snippet.ts" },
			createContext(sessionDir)
		);
		const transformed = result as { action: string; text?: string };

		expect(transformed.action).toBe("transform");
		expect(transformed.text).toContain("session");
		expect(transformed.text).not.toContain("process");
	});
});
