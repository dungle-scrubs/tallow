import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, RegisteredCommand } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import debugExtension from "../index.js";

interface CommandTestContext {
	ctx: ExtensionCommandContext;
	notifications: Array<{ level: "error" | "info" | "warning" | undefined; message: string }>;
	selectCalls: Array<{ options: string[]; title: string }>;
}

interface CommandContextOptions {
	hasUI: boolean;
	selectResult?: string | ((options: string[]) => string | undefined) | undefined;
}

let harness: ExtensionHarness;
let tmpHome: string;
let savedHome: string | undefined;
let savedTallowHome: string | undefined;

beforeEach(async () => {
	tmpHome = mkdtempSync(join(tmpdir(), "tallow-debug-diag-cmd-test-"));
	savedHome = process.env.HOME;
	savedTallowHome = process.env.TALLOW_CODING_AGENT_DIR;
	process.env.HOME = tmpHome;
	process.env.TALLOW_CODING_AGENT_DIR = join(tmpHome, ".tallow");
	(globalThis as Record<string, unknown>).__piDebugLogger = undefined;

	harness = ExtensionHarness.create();
	await harness.loadExtension(debugExtension);
});

afterEach(() => {
	if (savedHome !== undefined) {
		process.env.HOME = savedHome;
	} else {
		delete process.env.HOME;
	}
	if (savedTallowHome !== undefined) {
		process.env.TALLOW_CODING_AGENT_DIR = savedTallowHome;
	} else {
		delete process.env.TALLOW_CODING_AGENT_DIR;
	}
	(globalThis as Record<string, unknown>).__piDebugLogger = undefined;
	rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Get a registered slash command and fail if missing.
 * @param name - Command name to fetch
 * @returns Registered command definition
 */
function getCommand(name: string): Omit<RegisteredCommand, "name"> {
	const command = harness.commands.get(name);
	if (!command) {
		throw new Error(`Expected command "${name}" to be registered`);
	}
	return command;
}

/**
 * Seed ~/.tallow/debug.log under the test HOME directory.
 * @returns Absolute path to the seeded debug log
 */
function seedDebugLog(): string {
	const tallowHome = process.env.TALLOW_CODING_AGENT_DIR ?? join(tmpHome, ".tallow");
	const logPath = join(tallowHome, "debug.log");
	mkdirSync(tallowHome, { recursive: true });
	writeFileSync(
		logPath,
		[
			JSON.stringify({
				cat: "tool",
				data: { name: "bash" },
				evt: "call",
				ts: "2026-02-20T10:00:00.000Z",
			}),
		].join("\n")
	);
	return logPath;
}

/**
 * Add a mock wezterm_pane tool so diagnostics sees pane capability.
 */
function registerWeztermCapability(): void {
	harness.tools.set("wezterm_pane", {
		description: "Mock wezterm pane tool",
		async execute() {
			return {
				content: [{ type: "text", text: "ok" }],
				details: {},
			};
		},
		label: "wezterm_pane",
		name: "wezterm_pane",
		parameters: {},
	} as never);
}

/**
 * Build a minimal command context with selectable UI behavior.
 * @param options - UI availability and select return behavior
 * @returns Command context with captured UI calls
 */
function createCommandContext(options: CommandContextOptions): CommandTestContext {
	const notifications: Array<{ level: "error" | "info" | "warning" | undefined; message: string }> =
		[];
	const selectCalls: Array<{ options: string[]; title: string }> = [];

	const selectResult = options.selectResult;
	const ctx = {
		cwd: process.cwd(),
		hasUI: options.hasUI,
		ui: {
			async select(title: string, selectOptions: string[]) {
				selectCalls.push({ options: [...selectOptions], title });
				if (typeof selectResult === "function") {
					return selectResult(selectOptions);
				}
				return selectResult;
			},
			notify(message: string, level?: "error" | "info" | "warning") {
				notifications.push({ level, message });
			},
		},
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		notifications,
		selectCalls,
	};
}

describe("/diagnostics command registration", () => {
	it("registers the /diagnostics* command family", () => {
		expect(harness.commands.has("diagnostics")).toBe(true);
		expect(harness.commands.has("diagnostics-on")).toBe(true);
		expect(harness.commands.has("diagnostics-off")).toBe(true);
		expect(harness.commands.has("diagnostics-tail")).toBe(true);
		expect(harness.commands.has("diagnostics-clear")).toBe(true);
	});

	it("does not register legacy /diag* commands", () => {
		expect(harness.commands.has("diag")).toBe(false);
		expect(harness.commands.has("diag-on")).toBe(false);
		expect(harness.commands.has("diag-off")).toBe(false);
		expect(harness.commands.has("diag-tail")).toBe(false);
		expect(harness.commands.has("diag-clear")).toBe(false);
	});
});

describe("/diagnostics capability-aware behavior", () => {
	it("falls back to local tail output when wezterm capability is unavailable", async () => {
		seedDebugLog();
		const diagnostics = getCommand("diagnostics");
		const { ctx, selectCalls } = createCommandContext({
			hasUI: true,
			selectResult: undefined,
		});

		await diagnostics.handler("", ctx);

		expect(selectCalls.length).toBe(0);
		expect(harness.sentMessages.length).toBe(1);
		expect(harness.sentMessages[0].customType).toBe("diagnostics");
		expect(harness.sentMessages[0].content).toContain("Last 1 entries:");
	});

	it("uses local tail output when wezterm is available and user selects tail", async () => {
		seedDebugLog();
		registerWeztermCapability();

		let execCallCount = 0;
		(harness.api as { exec: ExtensionHarness["api"]["exec"] }).exec = async () => {
			execCallCount++;
			return { code: 0, killed: false, stderr: "", stdout: "" };
		};

		const diagnostics = getCommand("diagnostics");
		const { ctx, selectCalls } = createCommandContext({
			hasUI: true,
			selectResult: (selectOptions) => selectOptions[0],
		});

		await diagnostics.handler("1", ctx);

		expect(selectCalls.length).toBe(1);
		expect(execCallCount).toBe(0);
		expect(harness.sentMessages.length).toBe(1);
		expect(harness.sentMessages[0].content).toContain("Last 1 entries:");
	});

	it("launches live follow in a new pane when wezterm is available and user selects live", async () => {
		const logPath = seedDebugLog();
		registerWeztermCapability();

		const execCalls: Array<{ args: string[]; command: string }> = [];
		(harness.api as { exec: ExtensionHarness["api"]["exec"] }).exec = async (
			command: string,
			args: string[]
		) => {
			execCalls.push({ args: [...args], command });
			return { code: 0, killed: false, stderr: "", stdout: "" };
		};

		const diagnostics = getCommand("diagnostics");
		const { ctx } = createCommandContext({
			hasUI: true,
			selectResult: (selectOptions) => selectOptions[1],
		});

		await diagnostics.handler("", ctx);

		expect(execCalls.length).toBe(1);
		expect(execCalls[0]?.command).toContain("wezterm");
		expect(execCalls[0]?.args).toContain("tail");
		expect(execCalls[0]?.args).toContain("-f");
		expect(execCalls[0]?.args).toContain(logPath);
		expect(harness.sentMessages.length).toBe(0);
	});

	it("warns and falls back to local tail when live-pane launch fails", async () => {
		seedDebugLog();
		registerWeztermCapability();

		(harness.api as { exec: ExtensionHarness["api"]["exec"] }).exec = async () => {
			return { code: 1, killed: false, stderr: "split failed", stdout: "" };
		};

		const diagnostics = getCommand("diagnostics");
		const { ctx, notifications } = createCommandContext({
			hasUI: true,
			selectResult: (selectOptions) => selectOptions[1],
		});

		await diagnostics.handler("", ctx);

		expect(
			notifications.some(
				(note) => note.level === "warning" && note.message.includes("Showing local tail instead")
			)
		).toBe(true);
		expect(harness.sentMessages.length).toBe(1);
		expect(harness.sentMessages[0].customType).toBe("diagnostics");
		expect(harness.sentMessages[0].content).toContain("Last 1 entries:");
	});
});
