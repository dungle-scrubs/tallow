/**
 * Tests for /add-dir and /clear-dirs commands.
 *
 * Exercises directory validation, duplicate handling, context file discovery
 * from additional directories, and the clear-dirs reset flow.
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
 * Build a mock ExtensionContext for command handler invocation.
 *
 * @returns Context with notification tracking UI
 */
function buildCtx() {
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
	tmpDir = join(tmpdir(), `ctx-adddir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cwdDir = join(tmpDir, "project");
	additionalDir = join(tmpDir, "other-project");
	mkdirSync(cwdDir, { recursive: true });
	mkdirSync(additionalDir, { recursive: true });

	harness = ExtensionHarness.create();
	await harness.loadExtension(contextFilesExtension);

	// Fire session_start so the extension initializes its state
	await harness.fireEvent("session_start", { type: "session_start" }, {
		ui: createNotifyTracker(),
		hasUI: false,
		cwd: cwdDir,
	} as never);
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("/add-dir command", () => {
	test("registers add-dir and clear-dirs commands", () => {
		expect(harness.commands.has("add-dir")).toBe(true);
		expect(harness.commands.has("clear-dirs")).toBe(true);
	});

	test("lists empty when no additional dirs registered", async () => {
		await getCmd("add-dir").handler("", buildCtx());
		expect(notifications.some((n) => n.message.includes("No additional directories"))).toBe(true);
	});

	test("rejects nonexistent directory", async () => {
		await getCmd("add-dir").handler("/nonexistent/path/that/does/not/exist", buildCtx());
		expect(notifications.some((n) => n.level === "error" && n.message.includes("not found"))).toBe(
			true
		);
	});

	test("rejects file path (not a directory)", async () => {
		const filePath = join(tmpDir, "some-file.txt");
		writeFileSync(filePath, "content");

		await getCmd("add-dir").handler(filePath, buildCtx());
		expect(
			notifications.some((n) => n.level === "error" && n.message.includes("Not a directory"))
		).toBe(true);
	});

	test("adds directory and discovers context files", async () => {
		writeFileSync(join(additionalDir, "CLAUDE.md"), "# Additional Project\nRules here.");

		await getCmd("add-dir").handler(additionalDir, buildCtx());
		expect(
			notifications.some((n) => n.message.includes("+1 file") && n.message.includes("CLAUDE.md"))
		).toBe(true);
	});

	test("reports when directory has no context files", async () => {
		await getCmd("add-dir").handler(additionalDir, buildCtx());
		expect(notifications.some((n) => n.message.includes("no context files found"))).toBe(true);
	});

	test("deduplicates same directory added twice", async () => {
		writeFileSync(join(additionalDir, "AGENTS.md"), "# Agents");

		const ctx = buildCtx();
		await getCmd("add-dir").handler(additionalDir, ctx);
		notifications = [];
		await getCmd("add-dir").handler(additionalDir, ctx);
		expect(
			notifications.some((n) => n.level === "warning" && n.message.includes("Already added"))
		).toBe(true);
	});

	test("lists registered directories with file counts", async () => {
		writeFileSync(join(additionalDir, "CLAUDE.md"), "# Proj");
		const subDir = join(additionalDir, "sub");
		mkdirSync(subDir);
		writeFileSync(join(subDir, "AGENTS.md"), "# Sub agents");

		const ctx = buildCtx();
		await getCmd("add-dir").handler(additionalDir, ctx);
		notifications = [];
		await getCmd("add-dir").handler("", ctx);
		expect(notifications.some((n) => n.message.includes("Additional directories"))).toBe(true);
	});

	test("discovers subdirectory context files in additional dirs", async () => {
		const subDir = join(additionalDir, "packages", "core");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(join(subDir, "CLAUDE.md"), "# Core package rules");

		await getCmd("add-dir").handler(additionalDir, buildCtx());
		expect(notifications.some((n) => n.message.includes("+1 file"))).toBe(true);
	});
});

describe("/clear-dirs command", () => {
	test("no-ops when no directories to clear", async () => {
		await getCmd("clear-dirs").handler("", buildCtx());
		expect(
			notifications.some((n) => n.message.includes("No additional directories to clear"))
		).toBe(true);
	});

	test("clears all additional directories", async () => {
		writeFileSync(join(additionalDir, "CLAUDE.md"), "# Rules");

		const ctx = buildCtx();
		await getCmd("add-dir").handler(additionalDir, ctx);
		notifications = [];
		await getCmd("clear-dirs").handler("", ctx);
		expect(notifications.some((n) => n.message.includes("Cleared 1 additional directory"))).toBe(
			true
		);

		// Verify list is now empty
		notifications = [];
		await getCmd("add-dir").handler("", ctx);
		expect(notifications.some((n) => n.message.includes("No additional directories"))).toBe(true);
	});
});
