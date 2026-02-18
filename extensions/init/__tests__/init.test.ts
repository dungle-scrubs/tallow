/**
 * Tests for /init command behavior in the init extension.
 *
 * Covers .claude/ → .tallow/ migration (root and nested), CLAUDE.md
 * migration and optional removal, and .tallow/rules/ scaffolding.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredCommand } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import initExtension from "../index.js";

let harness: ExtensionHarness;
let tmpDir: string;
let projectDir: string;

/**
 * Create a UI mock with controllable confirm responses.
 *
 * @param confirmResponses - Sequence of boolean values returned by successive confirm calls
 * @returns UI context mock with notification and confirm call tracking
 */
function createUiMock(confirmResponses: boolean[] = []) {
	let confirmIndex = 0;
	const notifications: Array<{ message: string; level: string }> = [];
	const confirmCalls: Array<{ message: string; detail?: string }> = [];

	return {
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			async confirm(message: string, detail?: string) {
				confirmCalls.push({ message, detail });
				const response = confirmResponses[confirmIndex++];
				return response ?? false;
			},
			select: async () => undefined,
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
		},
		notifications,
		confirmCalls,
	};
}

/**
 * Retrieve the registered /init command from the harness.
 *
 * @returns The /init command definition
 */
function getInitCommand(): Omit<RegisteredCommand, "name"> {
	const cmd = harness.commands.get("init");
	if (!cmd) throw new Error('Command "init" not registered');
	return cmd;
}

beforeEach(async () => {
	tmpDir = join(tmpdir(), `init-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	projectDir = join(tmpDir, "project");
	mkdirSync(projectDir, { recursive: true });

	harness = ExtensionHarness.create();
	await harness.loadExtension(initExtension);
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("/init .claude/ directory handling", () => {
	test("renames root .claude/ directory to .tallow/ when confirmed", async () => {
		const claudeDir = join(projectDir, ".claude");
		mkdirSync(claudeDir, { recursive: true });

		const { ui, notifications } = createUiMock([true]);
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		const tallowDir = join(projectDir, ".tallow");
		expect(existsSync(claudeDir)).toBe(false);
		expect(existsSync(tallowDir)).toBe(true);
		expect(
			notifications.some(
				(n) => n.level === "info" && n.message.includes("Renamed .claude/ → .tallow/")
			)
		).toBe(true);
	});

	test("offers nested .claude/ renames when discovered", async () => {
		const nestedDir = join(projectDir, "packages", "app");
		const nestedClaude = join(nestedDir, ".claude");
		mkdirSync(nestedClaude, { recursive: true });

		const { ui, confirmCalls } = createUiMock();
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		const nestedConfirm = confirmCalls.find(
			(call) =>
				call.message.startsWith("Rename") && call.message.includes("nested .claude/ directories")
		);
		expect(nestedConfirm).toBeDefined();
		expect(nestedConfirm?.detail ?? "").toContain("packages/app/.claude/");
	});

	test("renames multiple nested .claude/ directories when confirmed", async () => {
		const apiDir = join(projectDir, "packages", "api");
		const webDir = join(projectDir, "packages", "web");
		mkdirSync(join(apiDir, ".claude"), { recursive: true });
		mkdirSync(join(webDir, ".claude"), { recursive: true });

		const { ui, notifications } = createUiMock([true]);
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		expect(existsSync(join(apiDir, ".claude"))).toBe(false);
		expect(existsSync(join(apiDir, ".tallow"))).toBe(true);
		expect(existsSync(join(webDir, ".claude"))).toBe(false);
		expect(existsSync(join(webDir, ".tallow"))).toBe(true);
		expect(
			notifications.some(
				(n) => n.level === "info" && n.message.includes("Renamed 2 nested .claude/ → .tallow/")
			)
		).toBe(true);
	});

	test("declining nested rename preserves nested .claude/ directories", async () => {
		const nestedDir = join(projectDir, "packages", "app");
		const nestedClaude = join(nestedDir, ".claude");
		mkdirSync(nestedClaude, { recursive: true });

		const { ui } = createUiMock([false]);
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		expect(existsSync(nestedClaude)).toBe(true);
		expect(existsSync(join(nestedDir, ".tallow"))).toBe(false);
	});
});

describe("/init CLAUDE.md migration and removal", () => {
	test("prompts to remove CLAUDE.md when present without AGENTS.md", async () => {
		const claudeMdPath = join(projectDir, "CLAUDE.md");
		writeFileSync(claudeMdPath, "# Root rules\n");

		const { ui, confirmCalls } = createUiMock();
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		const removalConfirm = confirmCalls.find(
			(call) => call.message === "Remove CLAUDE.md files after migration to AGENTS.md?"
		);
		expect(removalConfirm).toBeDefined();
	});

	test("CLAUDE.md removal prompt lists nested CLAUDE.md files", async () => {
		const rootClaude = join(projectDir, "CLAUDE.md");
		const appDir = join(projectDir, "packages", "app");
		const libDir = join(projectDir, "packages", "lib");
		mkdirSync(appDir, { recursive: true });
		mkdirSync(libDir, { recursive: true });
		writeFileSync(rootClaude, "# Root rules\n");
		writeFileSync(join(appDir, "CLAUDE.md"), "# App rules\n");
		writeFileSync(join(libDir, "CLAUDE.md"), "# Lib rules\n");

		const { ui, confirmCalls } = createUiMock();
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		const removalConfirm = confirmCalls.find(
			(call) => call.message === "Remove CLAUDE.md files after migration to AGENTS.md?"
		);
		expect(removalConfirm).toBeDefined();
		const detail = removalConfirm?.detail ?? "";
		expect(detail).toContain("CLAUDE.md");
		expect(detail).toContain(join("packages", "app", "CLAUDE.md"));
		expect(detail).toContain(join("packages", "lib", "CLAUDE.md"));
	});

	test("migration prompt includes removal instructions when removal confirmed", async () => {
		const claudeMdPath = join(projectDir, "CLAUDE.md");
		writeFileSync(claudeMdPath, "# Root rules\n");

		// First confirm is CLAUDE.md removal, second (rules scaffolding) is declined
		const { ui } = createUiMock([true, false]);
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		expect(harness.sentUserMessages.length).toBe(1);
		const msg = harness.sentUserMessages[0];
		expect(typeof msg.content).toBe("string");
		const prompt = msg.content as string;
		expect(prompt).toContain("delete the following");
		expect(prompt).toContain("- CLAUDE.md");
	});

	test("declining removal keeps base migration prompt without deletion instructions", async () => {
		const claudeMdPath = join(projectDir, "CLAUDE.md");
		writeFileSync(claudeMdPath, "# Root rules\n");

		// Decline removal, decline rules scaffolding
		const { ui } = createUiMock([false, false]);
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		expect(harness.sentUserMessages.length).toBe(1);
		const msg = harness.sentUserMessages[0];
		expect(typeof msg.content).toBe("string");
		const prompt = msg.content as string;
		expect(prompt.startsWith("There is an existing CLAUDE.md in this project")).toBe(true);
		expect(prompt).not.toContain("delete the following obsolete CLAUDE.md files");
	});
});

describe("/init .tallow/rules/ scaffolding", () => {
	test("creates .tallow/rules/ and README when missing and confirmed", async () => {
		const { ui } = createUiMock([true]);
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		const rulesDir = join(projectDir, ".tallow", "rules");
		const readmePath = join(rulesDir, "README.md");
		expect(existsSync(rulesDir)).toBe(true);
		expect(existsSync(readmePath)).toBe(true);
		const content = readFileSync(readmePath, "utf-8");
		expect(content).toContain("# Rules");
		expect(content).toContain("01-style.md");
	});

	test("does not scaffold .tallow/rules/ when directory already exists", async () => {
		const rulesDir = join(projectDir, ".tallow", "rules");
		mkdirSync(rulesDir, { recursive: true });
		const readmePath = join(rulesDir, "README.md");
		writeFileSync(readmePath, "# Custom rules\n");

		const { ui } = createUiMock();
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		const content = readFileSync(readmePath, "utf-8");
		expect(content).toContain("# Custom rules");
	});
});

describe("/init prompt selection", () => {
	test("uses INIT_PROMPT variant when AGENTS.md already exists", async () => {
		const agentsPath = join(projectDir, "AGENTS.md");
		writeFileSync(agentsPath, "# Existing agents\n");

		const { ui } = createUiMock([false]);
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		expect(harness.sentUserMessages.length).toBe(1);
		const msg = harness.sentUserMessages[0];
		expect(typeof msg.content).toBe("string");
		const prompt = msg.content as string;
		expect(prompt.startsWith("Please analyze this codebase and create an AGENTS.md file")).toBe(
			true
		);
	});

	test("uses migration prompt variant when only CLAUDE.md exists", async () => {
		const claudeMdPath = join(projectDir, "CLAUDE.md");
		writeFileSync(claudeMdPath, "# Root rules\n");

		const { ui } = createUiMock([false, false]);
		const ctx = { ui, hasUI: true, cwd: projectDir } as never;

		await getInitCommand().handler("", ctx);

		expect(harness.sentUserMessages.length).toBe(1);
		const msg = harness.sentUserMessages[0];
		expect(typeof msg.content).toBe("string");
		const prompt = msg.content as string;
		expect(prompt.startsWith("There is an existing CLAUDE.md in this project")).toBe(true);
	});
});
