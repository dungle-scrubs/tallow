/**
 * Tests for context-usage token estimation: estimateTokensFromText,
 * formatTokens, and parsePromptSections.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import type {
	ContextUsage,
	ExtensionCommandContext,
	ExtensionUIContext,
	RegisteredCommand,
} from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import contextUsageExtension, {
	estimateTokensFromText,
	formatTokens,
	parsePromptSections,
} from "../index.js";

// ── estimateTokensFromText ───────────────────────────────────────────────────

describe("estimateTokensFromText", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokensFromText("")).toBe(0);
	});

	it("estimates 1 token for 1 char", () => {
		expect(estimateTokensFromText("a")).toBe(1);
	});

	it("estimates 1 token for 3 chars (ceil(3/4))", () => {
		expect(estimateTokensFromText("abc")).toBe(1);
	});

	it("estimates 1 token for 4 chars", () => {
		expect(estimateTokensFromText("abcd")).toBe(1);
	});

	it("estimates 100 tokens for 400 chars", () => {
		expect(estimateTokensFromText("a".repeat(400))).toBe(100);
	});

	it("rounds up partial tokens", () => {
		expect(estimateTokensFromText("a".repeat(5))).toBe(2);
	});
});

// ── formatTokens ─────────────────────────────────────────────────────────────

describe("formatTokens", () => {
	it("formats small numbers as-is", () => {
		expect(formatTokens(500)).toBe("500");
	});

	it("formats 0", () => {
		expect(formatTokens(0)).toBe("0");
	});

	it("formats thousands with decimal k", () => {
		expect(formatTokens(5000)).toBe("5.0k");
	});

	it("formats 10k+ with rounded k", () => {
		expect(formatTokens(15000)).toBe("15k");
	});

	it("formats millions with M suffix", () => {
		expect(formatTokens(1500000)).toBe("1.5M");
	});

	it("formats 999 without suffix", () => {
		expect(formatTokens(999)).toBe("999");
	});
});

// ── parsePromptSections ──────────────────────────────────────────────────────

describe("parsePromptSections", () => {
	it("handles empty prompt", () => {
		const result = parsePromptSections("");
		expect(result.basePromptTokens).toBe(0);
		expect(result.contextFileTokens).toBe(0);
		expect(result.skillTokens).toBe(0);
	});

	it("assigns all tokens to base for plain prompt", () => {
		const prompt = "You are a helpful assistant. Follow these rules.";
		const result = parsePromptSections(prompt);
		expect(result.basePromptTokens).toBe(estimateTokensFromText(prompt));
		expect(result.contextFileTokens).toBe(0);
		expect(result.skillTokens).toBe(0);
	});

	it("detects available_skills section", () => {
		const prompt = "Base instructions.\n<available_skills>\nskill1\nskill2\n</available_skills>";
		const result = parsePromptSections(prompt);
		expect(result.skillTokens).toBeGreaterThan(0);
		expect(result.basePromptTokens).toBeGreaterThan(0);
	});

	it("detects Additional Project Context section", () => {
		const prompt = "Base.\n# Additional Project Context\nSome project info and context files here.";
		const result = parsePromptSections(prompt);
		expect(result.contextFileTokens).toBeGreaterThan(0);
	});

	it("detects Project Context section as fallback", () => {
		const prompt = "Base.\n# Project Context\nSome context data.";
		const result = parsePromptSections(prompt);
		expect(result.contextFileTokens).toBeGreaterThan(0);
	});

	it("splits tokens across all sections", () => {
		const prompt =
			"Base instructions here.\n# Additional Project Context\nContext data.\n<available_skills>\nskills data\n</available_skills>";
		const result = parsePromptSections(prompt);
		const total = result.basePromptTokens + result.contextFileTokens + result.skillTokens;
		expect(total).toBe(estimateTokensFromText(prompt));
	});
});

// ── /context command unknown usage handling ─────────────────────────────────

/** Shared warning used by the extension when usage data is unavailable. */
const NO_USAGE_WARNING = "No context usage data available yet. Send a message first.";

describe("/context command", () => {
	let harness: ExtensionHarness;

	beforeEach(async () => {
		harness = ExtensionHarness.create();
		await harness.loadExtension(contextUsageExtension);
	});

	it("uses the same warning/no-data path when tokens are unknown", async () => {
		const command = getContextCommand(harness);
		const notifications: Array<{ message: string; level: string }> = [];
		const usage: ContextUsage = { tokens: null, contextWindow: 200_000, percent: null };

		await command.handler("", buildCommandContext(usage, notifications));

		expect(notifications).toEqual([{ message: NO_USAGE_WARNING, level: "warning" }]);
		expect(harness.sentMessages.find((message) => message.customType === "context-usage")).toBe(
			undefined
		);
	});

	it("matches the no-data warning for missing and unknown usage", async () => {
		const command = getContextCommand(harness);
		const missingNotifications: Array<{ message: string; level: string }> = [];
		const unknownNotifications: Array<{ message: string; level: string }> = [];

		await command.handler("", buildCommandContext(undefined, missingNotifications));
		await command.handler(
			"",
			buildCommandContext(
				{ tokens: null, contextWindow: 200_000, percent: null },
				unknownNotifications
			)
		);

		expect(unknownNotifications).toEqual(missingNotifications);
		expect(unknownNotifications).toEqual([{ message: NO_USAGE_WARNING, level: "warning" }]);
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("still renders details when token usage is known", async () => {
		const command = getContextCommand(harness);
		const notifications: Array<{ message: string; level: string }> = [];

		await command.handler(
			"",
			buildCommandContext({ tokens: 4_500, contextWindow: 200_000, percent: 2.25 }, notifications)
		);

		expect(notifications).toEqual([]);
		const usageMessage = harness.sentMessages.find(
			(message) => message.customType === "context-usage"
		);
		expect(usageMessage).toBeDefined();
		const details = usageMessage?.details as { usedTokens: number } | undefined;
		expect(details?.usedTokens).toBe(4_500);
	});
});

// ── Command test helpers ─────────────────────────────────────────────────────

/**
 * Gets the registered `/context` command from the harness.
 *
 * @param harness - Extension harness containing registered commands
 * @returns Registered context command definition
 */
function getContextCommand(harness: ExtensionHarness): Omit<RegisteredCommand, "name"> {
	const command = harness.commands.get("context");
	if (!command) throw new Error('Command "context" not registered');
	return command;
}

/**
 * Creates a UI context that records notifications.
 *
 * @param notifications - Mutable notification log
 * @returns UI context stub for command tests
 */
function createNotifyUi(
	notifications: Array<{ message: string; level: string }>
): ExtensionUIContext {
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
		getEditorText() {
			return "";
		},
		editor: async () => undefined,
		setEditorComponent() {},
		getToolsExpanded() {
			return false;
		},
		setToolsExpanded() {},
	} as unknown as ExtensionUIContext;
}

/**
 * Builds a minimal ExtensionCommandContext for `/context` command tests.
 *
 * @param usage - Context usage payload to return from `getContextUsage()`
 * @param notifications - Mutable notification log
 * @returns Mock command context
 */
function buildCommandContext(
	usage: ContextUsage | undefined,
	notifications: Array<{ message: string; level: string }>
): ExtensionCommandContext {
	return {
		ui: createNotifyUi(notifications),
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: {
			getBranch: () => [],
		} as ExtensionCommandContext["sessionManager"],
		modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
		model: { id: "test-model" } as ExtensionCommandContext["model"],
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => usage,
		compact: () => {},
		getSystemPrompt: () => "You are a test assistant.",
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	};
}
