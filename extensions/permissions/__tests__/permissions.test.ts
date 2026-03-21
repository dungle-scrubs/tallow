/**
 * Tests for the permissions extension registration and wiring.
 *
 * Uses the ExtensionHarness to avoid mock.module() — which contaminates
 * other test files in the same Bun worker. Tests cover command/handler
 * registration and event handler presence without mocking the _shared modules.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import registerPermissions from "../index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type EventName = "session_start" | "tool_call";
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
type CommandHandler = (args: string | undefined, ctx: unknown) => Promise<void>;

interface CapturedPi {
	handlers: Partial<Record<EventName, EventHandler>>;
	commands: Record<string, { description: string; handler: CommandHandler }>;
}

/**
 * Run the extension against a spy pi to capture what it registers.
 *
 * @returns Captured event handlers and commands
 */
function captureRegistrations(): CapturedPi {
	const handlers: Partial<Record<EventName, EventHandler>> = {};
	const commands: Record<string, { description: string; handler: CommandHandler }> = {};
	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers[event as EventName] = handler;
		},
		registerCommand: (name: string, opts: { description: string; handler: CommandHandler }) => {
			commands[name] = opts;
		},
	} as unknown as ExtensionAPI;

	registerPermissions(pi);
	return { handlers, commands };
}

// ════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════

describe("permissions extension registration", () => {
	test("registers session_start handler", () => {
		const { handlers } = captureRegistrations();
		expect(handlers.session_start).toBeDefined();
	});

	test("registers tool_call handler", () => {
		const { handlers } = captureRegistrations();
		expect(handlers.tool_call).toBeDefined();
	});

	test("registers /permissions command", () => {
		const { commands } = captureRegistrations();
		expect(commands.permissions).toBeDefined();
		expect(commands.permissions.description).toBeTruthy();
	});
});

// ════════════════════════════════════════════════════════════════
// tool_call handler wiring
// ════════════════════════════════════════════════════════════════

describe("tool_call handler", () => {
	test("skips bash tool (handled by shell-policy)", async () => {
		const { handlers } = captureRegistrations();
		const result = await handlers.tool_call!(
			{ type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "ls" } },
			{ cwd: "/tmp", hasUI: false, ui: {} } as unknown as ExtensionContext
		);
		// No block/error — should be undefined (pass-through)
		expect(result).toBeUndefined();
	});

	test("skips bg_bash tool (handled by shell-policy)", async () => {
		const { handlers } = captureRegistrations();
		const result = await handlers.tool_call!(
			{ type: "tool_call", toolName: "bg_bash", toolCallId: "t2", input: { command: "ls" } },
			{ cwd: "/tmp", hasUI: false, ui: {} } as unknown as ExtensionContext
		);
		expect(result).toBeUndefined();
	});

	test("skips when no rules configured", async () => {
		const { handlers } = captureRegistrations();
		// Session-start hasn't been called yet, so currentCwd is "", and
		// getPermissions("") returns empty rules → skip
		const result = await handlers.tool_call!(
			{
				type: "tool_call",
				toolName: "read",
				toolCallId: "t3",
				input: { path: "/etc/passwd" },
			},
			{ cwd: "/tmp", hasUI: false, ui: {} } as unknown as ExtensionContext
		);
		expect(result).toBeUndefined();
	});
});

// ════════════════════════════════════════════════════════════════
// /permissions command wiring
// ════════════════════════════════════════════════════════════════

describe("/permissions command", () => {
	test("reload subcommand calls reloadPermissions", async () => {
		const { commands } = captureRegistrations();
		const notifications: Array<{ msg: string; type: string }> = [];
		const ctx = {
			cwd: "/tmp",
			ui: {
				notify: (msg: string, type: string) => {
					notifications.push({ msg, type });
				},
			},
		};

		await commands.permissions.handler("reload", ctx);
		// Should have notified about reload
		expect(notifications.length).toBeGreaterThan(0);
		expect(notifications[0].msg).toContain("Reloaded");
	});

	test("no args shows rules (or 'no rules' when none configured)", async () => {
		const { commands } = captureRegistrations();
		const notifications: Array<{ msg: string; type: string }> = [];
		const ctx = {
			cwd: "/tmp",
			ui: {
				notify: (msg: string, type: string) => {
					notifications.push({ msg, type });
				},
			},
		};

		await commands.permissions.handler("", ctx);
		expect(notifications.length).toBeGreaterThan(0);
		// Should show either "No permission rules" or "Active Permission Rules"
		const msg = notifications[0].msg;
		expect(msg.includes("No permission rules") || msg.includes("Permission Rules")).toBe(true);
	});

	test("test subcommand evaluates Tool(specifier) format", async () => {
		const { commands } = captureRegistrations();
		const notifications: Array<{ msg: string; type: string }> = [];
		const ctx = {
			cwd: "/tmp",
			ui: {
				notify: (msg: string, type: string) => {
					notifications.push({ msg, type });
				},
			},
		};

		await commands.permissions.handler("test Bash(ls)", ctx);
		expect(notifications.length).toBeGreaterThan(0);
		// Should contain action verdict info
		expect(notifications[0].msg).toContain("Action:");
	});

	test("test subcommand handles bare tool name", async () => {
		const { commands } = captureRegistrations();
		const notifications: Array<{ msg: string; type: string }> = [];
		const ctx = {
			cwd: "/tmp",
			ui: {
				notify: (msg: string, type: string) => {
					notifications.push({ msg, type });
				},
			},
		};

		await commands.permissions.handler("test read", ctx);
		expect(notifications.length).toBeGreaterThan(0);
		expect(notifications[0].msg).toContain("Action:");
	});
});

// ════════════════════════════════════════════════════════════════
// ExtensionHarness integration
// ════════════════════════════════════════════════════════════════

describe("permissions via ExtensionHarness", () => {
	test("tool_call event handler is registered", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(registerPermissions);
		// Verify the extension registered a tool_call handler by firing one
		const results = await harness.fireEvent("tool_call", {
			type: "tool_call",
			toolName: "read",
			toolCallId: "h-1",
			input: { path: "foo.txt" },
		});
		// No rules configured → should not block
		const blocked = results.some(
			(r) => r && typeof r === "object" && (r as { block?: boolean }).block
		);
		expect(blocked).toBe(false);
	});

	test("/permissions command is registered", async () => {
		const harness = ExtensionHarness.create();
		await harness.loadExtension(registerPermissions);
		expect(harness.commands.has("permissions")).toBe(true);
	});
});
