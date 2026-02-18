/**
 * Tests for nested .tallow/rules and .claude/rules discovery.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredCommand } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import contextFilesExtension from "../index.js";

let harness: ExtensionHarness;
let tmpDir: string;
let cwdDir: string;
let additionalDir: string;
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
 * @returns Context with cwd set to the temporary project directory
 */
function buildEventCtx() {
	return { ui: createNotifyTracker(), hasUI: false, cwd: cwdDir } as never;
}

/**
 * Build a mock ExtensionContext for command handler invocation.
 *
 * @returns Context with notification tracking UI
 */
function buildCommandCtx() {
	notifications = [];
	return { ui: createNotifyTracker(), hasUI: false, cwd: cwdDir } as never;
}

/**
 * Retrieve a command handler from the harness, failing the test if not found.
 *
 * @param name - Command name
 * @returns Command definition (handler + description)
 */
function getCmd(name: string): Omit<RegisteredCommand, "name"> {
	const cmd = harness.commands.get(name);
	if (!cmd) throw new Error(`Command "${name}" not registered`);
	return cmd;
}

beforeEach(async () => {
	originalHome = process.env.HOME;
	homeDir = join(tmpdir(), `ctx-nested-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(homeDir, { recursive: true });
	process.env.HOME = homeDir;

	tmpDir = join(tmpdir(), `ctx-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cwdDir = join(tmpDir, "project");
	additionalDir = join(tmpDir, "additional-project");
	mkdirSync(cwdDir, { recursive: true });
	mkdirSync(additionalDir, { recursive: true });

	harness = ExtensionHarness.create();
	await harness.loadExtension(contextFilesExtension);
});

afterEach(() => {
	process.env.HOME = originalHome;
	if (homeDir && homeDir !== originalHome) {
		rmSync(homeDir, { recursive: true, force: true });
	}
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("nested rules discovery", () => {
	test("discovers .tallow/rules/*.md in a subdirectory", async () => {
		const rulesDir = join(cwdDir, "packages", "api", ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		const rulePath = join(rulesDir, "api-rules.md");
		writeFileSync(rulePath, "Subdir tallow rule");

		const ctx = buildEventCtx();
		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		const [result] = await harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "SYSTEM" },
			ctx
		);

		expect(result).toBeDefined();
		const { systemPrompt } = result as { systemPrompt: string };
		expect(systemPrompt).toContain("Additional Project Context");
		expect(systemPrompt).toContain("Subdir tallow rule");
		expect(systemPrompt).toContain("api-rules.md");
	});

	test("discovers .claude/rules/*.md in a subdirectory", async () => {
		const rulesDir = join(cwdDir, "apps", "web", ".claude", "rules");
		mkdirSync(rulesDir, { recursive: true });
		const rulePath = join(rulesDir, "web-rules.md");
		writeFileSync(rulePath, "Subdir claude rule");

		const ctx = buildEventCtx();
		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		const [result] = await harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "SYSTEM" },
			ctx
		);

		expect(result).toBeDefined();
		const { systemPrompt } = result as { systemPrompt: string };
		expect(systemPrompt).toContain("Subdir claude rule");
		expect(systemPrompt).toContain("web-rules.md");
	});

	test("discovers rules at multiple nesting levels", async () => {
		const level1Rules = join(cwdDir, "packages", "api", ".tallow", "rules");
		const level2Rules = join(cwdDir, "packages", "api", "subpkg", ".tallow", "rules");
		mkdirSync(level1Rules, { recursive: true });
		mkdirSync(level2Rules, { recursive: true });

		writeFileSync(join(level1Rules, "level1.md"), "Level 1 rules");
		writeFileSync(join(level2Rules, "level2.md"), "Level 2 rules");

		const ctx = buildEventCtx();
		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		const [result] = await harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "SYSTEM" },
			ctx
		);

		expect(result).toBeDefined();
		const { systemPrompt } = result as { systemPrompt: string };
		expect(systemPrompt).toContain("Level 1 rules");
		expect(systemPrompt).toContain("Level 2 rules");
	});

	test("skips node_modules/.tallow/rules/ (SKIP_DIRS)", async () => {
		const rulesDir = join(cwdDir, "node_modules", "lib", ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(join(rulesDir, "lib-rules.md"), "Should be skipped");

		const ctx = buildEventCtx();
		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		const [result] = await harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "SYSTEM" },
			ctx
		);

		expect(result).toBeUndefined();
	});

	test("skips .hidden-dir/.tallow/rules/ (dot-prefix filter)", async () => {
		const rulesDir = join(cwdDir, ".hidden-dir", ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(join(rulesDir, "hidden-rules.md"), "Hidden rules");

		const ctx = buildEventCtx();
		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		const [result] = await harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "SYSTEM" },
			ctx
		);

		expect(result).toBeUndefined();
	});

	test("empty rules dirs don't produce entries", async () => {
		const rulesDir = join(cwdDir, "pkg", ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });

		const ctx = buildEventCtx();
		await harness.fireEvent("session_start", { type: "session_start" }, ctx);
		const [result] = await harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "SYSTEM" },
			ctx
		);

		expect(result).toBeUndefined();
	});

	test("works with /add-dir for additional directories", async () => {
		const rulesDir = join(additionalDir, "services", "user", ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(join(rulesDir, "user-rules.md"), "Additional dir nested rule");

		// Initialize session with cwd set to the main project directory
		const eventCtx = buildEventCtx();
		await harness.fireEvent("session_start", { type: "session_start" }, eventCtx);

		// Add the additional directory and ensure nested rules are discovered
		const cmdCtx = buildCommandCtx();
		await getCmd("add-dir").handler(additionalDir, cmdCtx);
		expect(
			notifications.some(
				(n) => n.message.includes("+1 file") && n.message.includes("user-rules.md")
			)
		).toBe(true);

		const [result] = await harness.fireEvent(
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "SYSTEM" },
			eventCtx
		);

		expect(result).toBeDefined();
		const { systemPrompt } = result as { systemPrompt: string };
		expect(systemPrompt).toContain("Additional dir nested rule");
	});
});
