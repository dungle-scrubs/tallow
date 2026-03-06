/**
 * Tests for path-scoped rules frontmatter compatibility and activation lifecycle.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import contextFilesExtension from "../index.js";

let harness: ExtensionHarness;
let tmpDir: string;
let cwdDir: string;
let homeDir: string;
let originalHome: string | undefined;

/** Notification log shared across tests. */
let notifications: Array<{ message: string; level: string }> = [];

/**
 * Create a stub UI context that records notifications.
 *
 * @returns UI context with notify tracking
 */
function createNotifyTracker() {
	return {
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		setStatus() {},
		setWorkingMessage() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		custom: async () => undefined as never,
		pasteToEditor() {},
		setEditorText() {},
		getEditorText: () => "",
		editor: async () => undefined,
		setEditorComponent() {},
		getToolsExpanded: () => false,
		setToolsExpanded() {},
	};
}

/**
 * Build a mock ExtensionContext for event dispatch.
 *
 * @returns Context with cwd set to test project directory
 */
function buildCtx() {
	return { ui: createNotifyTracker(), hasUI: false, cwd: cwdDir } as never;
}

/**
 * Fire session_start for a clean extension state.
 *
 * @returns Nothing
 */
async function startSession(): Promise<void> {
	await harness.fireEvent("session_start", { type: "session_start" }, buildCtx());
}

/**
 * Fire before_agent_start and return injected system prompt content.
 *
 * @returns Injected system prompt when available
 */
async function getPrompt(): Promise<string | undefined> {
	const [result] = await harness.fireEvent(
		"before_agent_start",
		{ type: "before_agent_start", prompt: "hi", systemPrompt: "SYSTEM" },
		buildCtx()
	);
	return (result as { systemPrompt: string } | undefined)?.systemPrompt;
}

/**
 * Fire a successful tool_result event with a file path.
 *
 * @param toolName - Tool that produced the result
 * @param filePath - File path from tool input
 * @returns Nothing
 */
async function fireFileToolResult(
	toolName: "read" | "edit" | "write",
	filePath: string
): Promise<void> {
	await harness.fireEvent(
		"tool_result",
		{
			type: "tool_result",
			toolName,
			input: { path: filePath },
			isError: false,
		},
		buildCtx()
	);
}

/**
 * Count exact substring occurrences.
 *
 * @param value - String to scan
 * @param needle - Substring to count
 * @returns Number of exact matches
 */
function countOccurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

beforeEach(async () => {
	originalHome = process.env.HOME;
	homeDir = join(tmpdir(), `ctx-scoped-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(homeDir, { recursive: true });
	process.env.HOME = homeDir;

	tmpDir = join(tmpdir(), `ctx-scoped-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cwdDir = join(tmpDir, "project");
	mkdirSync(cwdDir, { recursive: true });
	notifications = [];

	harness = ExtensionHarness.create();
	await harness.loadExtension(contextFilesExtension);
});

afterEach(() => {
	process.env.HOME = originalHome;
	rmSync(tmpDir, { recursive: true, force: true });
	if (homeDir && homeDir !== originalHome) {
		rmSync(homeDir, { recursive: true, force: true });
	}
});

describe("scoped rules frontmatter", () => {
	test("supports paths string and activates on read", async () => {
		const rulesDir = join(cwdDir, ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(
			join(rulesDir, "api.md"),
			["---", 'paths: "src/api/**/*.ts"', "---", "# API scoped rule", "- Validate input"].join("\n")
		);

		await startSession();
		expect(await getPrompt()).toBeUndefined();

		await fireFileToolResult("read", "src/api/users.ts");
		const prompt = await getPrompt();
		expect(prompt).toContain("API scoped rule");
	});

	test("supports paths array and activates on write", async () => {
		const rulesDir = join(cwdDir, ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(
			join(rulesDir, "web.md"),
			[
				"---",
				"paths:",
				'  - "apps/web/**/*.tsx"',
				'  - "apps/web/**/*.ts"',
				"---",
				"# Web scoped rule",
				"- Prefer server components",
			].join("\n")
		);

		await startSession();
		expect(await getPrompt()).toBeUndefined();

		await fireFileToolResult("write", "apps/web/page.tsx");
		const prompt = await getPrompt();
		expect(prompt).toContain("Web scoped rule");
	});

	test("supports path alias and activates on edit", async () => {
		const rulesDir = join(cwdDir, ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(
			join(rulesDir, "core.md"),
			[
				"---",
				'path: "packages/core/**/*.ts"',
				"---",
				"# Core scoped rule",
				"- Use Result types",
			].join("\n")
		);

		await startSession();
		expect(await getPrompt()).toBeUndefined();

		await fireFileToolResult("edit", "packages/core/index.ts");
		const prompt = await getPrompt();
		expect(prompt).toContain("Core scoped rule");
	});

	test("does not activate on non-matching paths", async () => {
		const rulesDir = join(cwdDir, ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(
			join(rulesDir, "api.md"),
			["---", 'paths: "src/api/**/*.ts"', "---", "# API scoped rule"].join("\n")
		);

		await startSession();
		await fireFileToolResult("read", "src/web/page.tsx");
		expect(await getPrompt()).toBeUndefined();
	});

	test("deduplicates repeated activations", async () => {
		const rulesDir = join(cwdDir, ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(
			join(rulesDir, "shared.md"),
			["---", 'paths: "src/**/*.ts"', "---", "# Shared rule", "- Keep imports type-safe"].join("\n")
		);

		await startSession();
		await fireFileToolResult("read", "src/a.ts");
		await fireFileToolResult("edit", "src/b.ts");
		await fireFileToolResult("write", "src/c.ts");

		const prompt = await getPrompt();
		expect(prompt).toContain("Shared rule");
		expect(countOccurrences(prompt ?? "", "Shared rule")).toBe(1);
	});

	test("supports nested .claude/rules parity with .tallow/rules", async () => {
		const rulesDir = join(cwdDir, "apps", "web", ".claude", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(
			join(rulesDir, "frontend.md"),
			[
				"---",
				'path: "apps/web/**/*.tsx"',
				"---",
				"# Frontend scoped rule",
				"- Keep components composable",
			].join("\n")
		);

		await startSession();
		expect(await getPrompt()).toBeUndefined();

		await fireFileToolResult("edit", "apps/web/page.tsx");
		const prompt = await getPrompt();
		expect(prompt).toContain("Frontend scoped rule");
	});

	test("invalid path frontmatter warns and falls back to unconditional", async () => {
		const rulesDir = join(cwdDir, ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(
			join(rulesDir, "invalid.md"),
			["---", "paths: 42", "---", "# Fallback unconditional rule"].join("\n")
		);

		notifications = [];
		await startSession();
		const prompt = await getPrompt();

		expect(prompt).toContain("Fallback unconditional rule");
		expect(
			notifications.some(
				(notification) =>
					notification.level === "warning" &&
					notification.message.includes("invalid path frontmatter")
			)
		).toBe(true);
	});
});

describe("scoped activation reset semantics", () => {
	test("resets scoped activation on session_start and session switches", async () => {
		const rulesDir = join(cwdDir, ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(
			join(rulesDir, "api.md"),
			["---", 'path: "src/api/**/*.ts"', "---", "# API scoped rule"].join("\n")
		);

		await startSession();
		await fireFileToolResult("read", "src/api/users.ts");
		expect(await getPrompt()).toContain("API scoped rule");

		await harness.fireEvent("session_start", { type: "session_start" }, buildCtx());
		expect(await getPrompt()).toBeUndefined();

		await fireFileToolResult("read", "src/api/users.ts");
		expect(await getPrompt()).toContain("API scoped rule");

		await harness.fireEvent("session_before_switch", { type: "session_before_switch" }, buildCtx());
		await harness.fireEvent("session_switch", { type: "session_switch" }, buildCtx());
		expect(await getPrompt()).toBeUndefined();
	});
});
