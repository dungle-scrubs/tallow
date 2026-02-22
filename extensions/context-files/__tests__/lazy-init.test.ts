/**
 * Tests for lazy initialization behavior in context-files.
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
 * Build a mock ExtensionContext for event and command invocation.
 *
 * @returns Context with notification tracking UI
 */
function buildCtx() {
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

/**
 * Build a before_agent_start payload.
 *
 * @param systemPrompt - Base system prompt
 * @returns before_agent_start event payload
 */
function buildBeforeAgentStartEvent(systemPrompt: string) {
	return {
		type: "before_agent_start",
		prompt: "hello",
		systemPrompt,
	} as const;
}

beforeEach(async () => {
	tmpDir = join(tmpdir(), `ctx-lazy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cwdDir = join(tmpDir, "project");
	additionalDir = join(tmpDir, "additional");
	mkdirSync(cwdDir, { recursive: true });
	mkdirSync(additionalDir, { recursive: true });
	notifications = [];

	harness = ExtensionHarness.create();
	await harness.loadExtension(contextFilesExtension);
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("lazy context discovery", () => {
	test("defers discovery until first before_agent_start", async () => {
		await harness.fireEvent("session_start", { type: "session_start" }, buildCtx());
		expect(notifications.length).toBe(0);

		const subDir = join(cwdDir, "packages", "api");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(join(subDir, "CLAUDE.md"), "Deferred context file");

		const [result] = await harness.fireEvent(
			"before_agent_start",
			buildBeforeAgentStartEvent("SYSTEM"),
			buildCtx()
		);

		expect(result).toBeDefined();
		const { systemPrompt } = result as { systemPrompt: string };
		expect(systemPrompt).toContain("Deferred context file");
		expect(
			notifications.some(
				(notification) =>
					notification.level === "info" && notification.message.startsWith("context-files: +1")
			)
		).toBe(true);
	});

	test("initializes once and does not rescan until reset", async () => {
		const firstDir = join(cwdDir, "packages", "first");
		mkdirSync(firstDir, { recursive: true });
		writeFileSync(join(firstDir, "CLAUDE.md"), "First context file");

		await harness.fireEvent("session_start", { type: "session_start" }, buildCtx());
		const [firstResult] = await harness.fireEvent(
			"before_agent_start",
			buildBeforeAgentStartEvent("SYSTEM"),
			buildCtx()
		);
		expect((firstResult as { systemPrompt: string }).systemPrompt).toContain("First context file");

		const secondDir = join(cwdDir, "packages", "second");
		mkdirSync(secondDir, { recursive: true });
		writeFileSync(join(secondDir, "CLAUDE.md"), "Second context file");

		notifications = [];
		const [secondResult] = await harness.fireEvent(
			"before_agent_start",
			buildBeforeAgentStartEvent("SYSTEM"),
			buildCtx()
		);
		const { systemPrompt } = secondResult as { systemPrompt: string };
		expect(systemPrompt).toContain("First context file");
		expect(systemPrompt).not.toContain("Second context file");
		expect(notifications.length).toBe(0);
	});

	test("session_start reset triggers a fresh scan on next use", async () => {
		const firstDir = join(cwdDir, "services", "one");
		mkdirSync(firstDir, { recursive: true });
		writeFileSync(join(firstDir, "CLAUDE.md"), "One");

		await harness.fireEvent("session_start", { type: "session_start" }, buildCtx());
		await harness.fireEvent("before_agent_start", buildBeforeAgentStartEvent("SYSTEM"), buildCtx());

		const secondDir = join(cwdDir, "services", "two");
		mkdirSync(secondDir, { recursive: true });
		writeFileSync(join(secondDir, "CLAUDE.md"), "Two");

		notifications = [];
		await harness.fireEvent("session_start", { type: "session_start" }, buildCtx());
		expect(notifications.length).toBe(0);

		const [result] = await harness.fireEvent(
			"before_agent_start",
			buildBeforeAgentStartEvent("SYSTEM"),
			buildCtx()
		);
		expect(result).toBeDefined();
		expect((result as { systemPrompt: string }).systemPrompt).toContain("Two");
	});

	test("dedupes concurrent first-use initialization", async () => {
		const subDir = join(cwdDir, "apps", "web");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(join(subDir, "CLAUDE.md"), "Concurrent context file");

		await harness.fireEvent("session_start", { type: "session_start" }, buildCtx());

		const handlers = harness.handlers.get("before_agent_start") ?? [];
		const handler = handlers[0];
		if (!handler) {
			throw new Error("before_agent_start handler missing");
		}

		notifications = [];
		const event = buildBeforeAgentStartEvent("SYSTEM");
		const ctx = buildCtx();
		const [first, second] = await Promise.all([handler(event, ctx), handler(event, ctx)]);

		expect((first as { systemPrompt: string }).systemPrompt).toContain("Concurrent context file");
		expect((second as { systemPrompt: string }).systemPrompt).toContain("Concurrent context file");

		const startupNotices = notifications.filter((notification) =>
			notification.message.startsWith("context-files: +")
		);
		expect(startupNotices.length).toBe(1);
	});
});

describe("command determinism with lazy discovery", () => {
	test("/add-dir before first scan is reflected on first before_agent_start", async () => {
		writeFileSync(join(additionalDir, "CLAUDE.md"), "Additional directory context");

		await harness.fireEvent("session_start", { type: "session_start" }, buildCtx());
		await getCmd("add-dir").handler(additionalDir, buildCtx());

		const [result] = await harness.fireEvent(
			"before_agent_start",
			buildBeforeAgentStartEvent("SYSTEM"),
			buildCtx()
		);
		expect(result).toBeDefined();
		expect((result as { systemPrompt: string }).systemPrompt).toContain(
			"Additional directory context"
		);
	});

	test("/clear-dirs before first scan removes pending additional dirs", async () => {
		writeFileSync(join(additionalDir, "CLAUDE.md"), "Should be cleared");

		await harness.fireEvent("session_start", { type: "session_start" }, buildCtx());
		const ctx = buildCtx();
		await getCmd("add-dir").handler(additionalDir, ctx);
		await getCmd("clear-dirs").handler("", ctx);

		const [result] = await harness.fireEvent(
			"before_agent_start",
			buildBeforeAgentStartEvent("SYSTEM"),
			buildCtx()
		);
		expect(result).toBeUndefined();
	});
});
