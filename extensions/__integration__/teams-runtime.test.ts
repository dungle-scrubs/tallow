import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../test-utils/extension-harness.js";
import type { Teammate } from "../teams-tool/state/types.js";
import {
	addTaskToBoard,
	archiveTeam,
	createTeamStore,
	getArchivedTeams,
	getTeam,
	getTeams,
	type Team,
} from "../teams-tool/store.js";
import { registerTeamsToolExtension } from "../teams-tool/tools/register-extension.js";

/**
 * Read a required tool from harness registration.
 *
 * @param harness - Extension harness instance
 * @param name - Tool name
 * @returns Registered tool definition
 */
function getTool(harness: ExtensionHarness, name: string): ToolDefinition {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Expected tool "${name}" to be registered`);
	return tool;
}

/**
 * Extract first text content block from a tool result.
 *
 * @param result - Tool result payload
 * @returns Text value
 */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const text = result.content.find((block) => block.type === "text");
	if (!text?.text) throw new Error("Expected text tool result");
	return text.text;
}

/**
 * Execute a tool with optional abort signal.
 *
 * @param tool - Tool definition
 * @param params - Tool params
 * @param signal - Optional abort signal
 * @returns Tool result
 */
async function execTool(
	tool: ToolDefinition,
	params: Record<string, unknown>,
	signal?: AbortSignal
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
	return (await tool.execute(
		"test-tool-call",
		params as never,
		signal,
		undefined,
		{} as ExtensionContext
	)) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
}

/**
 * Build a minimal command context with captured notifications.
 *
 * @param hasUI - Whether UI is available
 * @returns Context + notifications collector
 */
function createCommandContext(hasUI: boolean): {
	ctx: ExtensionContext;
	notifications: string[];
} {
	const notifications: string[] = [];
	const ctx = {
		hasUI,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			setEditorComponent() {},
			setWorkingMessage() {},
			setStatus() {},
			get theme(): never {
				throw new Error("theme not available in tests");
			},
		} as unknown as ExtensionContext["ui"],
		cwd: process.cwd(),
	} as ExtensionContext;
	return { ctx, notifications };
}

/**
 * Create a mock teammate with observable abort/dispose calls.
 *
 * @param name - Teammate name
 * @param status - Runtime status
 * @returns Teammate plus call log
 */
function mockTeammate(
	name: string,
	status: Teammate["status"]
): { teammate: Teammate; calls: string[] } {
	const calls: string[] = [];
	const teammate: Teammate = {
		name,
		role: "test-role",
		model: "test-model",
		status,
		session: {
			isStreaming: false,
			prompt: async () => {},
			followUp: async () => {},
			abort: async () => {
				calls.push("abort");
			},
			dispose: () => {
				calls.push("dispose");
			},
			messages: [],
		} as unknown as Teammate["session"],
	};
	return { teammate, calls };
}

beforeEach(() => {
	getTeams().clear();
	getArchivedTeams().clear();
});

afterEach(() => {
	getTeams().clear();
	getArchivedTeams().clear();
});

describe("Teams runtime wiring", () => {
	it("registers command + core tools and supports create/add/status flows", async () => {
		const harness = ExtensionHarness.create();
		registerTeamsToolExtension(harness.api);

		expect(harness.commands.has("team-dashboard")).toBe(true);
		for (const toolName of [
			"team_create",
			"team_add_tasks",
			"team_spawn",
			"team_send",
			"team_status",
			"team_shutdown",
			"team_resume",
		]) {
			expect(harness.tools.has(toolName)).toBe(true);
		}

		const create = getTool(harness, "team_create");
		const addTasks = getTool(harness, "team_add_tasks");
		const status = getTool(harness, "team_status");

		const missingTeam = await execTool(addTasks, {
			team: "alpha",
			tasks: [{ title: "Should fail" }],
		});
		expect(missingTeam.isError).toBe(true);
		expect(firstText(missingTeam)).toContain('Team "alpha" not found.');

		const created = await execTool(create, { name: "alpha" });
		expect(firstText(created)).toContain('Team "alpha" created');

		const duplicate = await execTool(create, { name: "alpha" });
		expect(duplicate.isError).toBe(true);
		expect(firstText(duplicate)).toContain("already exists");

		const added = await execTool(addTasks, {
			team: "alpha",
			tasks: [{ title: "Collect logs" }, { title: "Draft fix", blockedBy: ["1"] }],
		});
		expect(firstText(added)).toContain("Added 2 task(s)");

		const snapshot = await execTool(status, { team: "alpha" });
		expect(firstText(snapshot)).toContain("#1 Collect logs [pending]");
		expect(firstText(snapshot)).toContain("#2 Draft fix [pending]");
	});

	it("team_spawn surfaces model resolution failures without crashing runtime", async () => {
		const harness = ExtensionHarness.create();
		registerTeamsToolExtension(harness.api);

		await execTool(getTool(harness, "team_create"), { name: "alpha" });
		const spawn = getTool(harness, "team_spawn");
		const result = await execTool(spawn, {
			team: "alpha",
			name: "alice",
			role: "Researcher",
			model: "zzz-nonexistent-qqq-xyzzy",
		});

		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain('Failed to spawn "alice"');
		expect(firstText(result)).toContain("Model not found");
	});

	it("team_resume lists archives and restores claimed tasks as pending", async () => {
		const harness = ExtensionHarness.create();
		registerTeamsToolExtension(harness.api);

		const team = createTeamStore("restore-me") as Team<Teammate>;
		const task = addTaskToBoard(team, "Resume me", "desc", []);
		task.status = "claimed";
		task.assignee = "alice";
		archiveTeam(team.name);

		const resume = getTool(harness, "team_resume");

		const list = await execTool(resume, {});
		expect(firstText(list)).toContain("Archived Teams");
		expect(firstText(list)).toContain("restore-me");

		const restored = await execTool(resume, { team: "restore-me" });
		expect(restored.isError).toBeUndefined();
		expect(firstText(restored)).toContain('Team "restore-me" restored');

		const active = getTeam("restore-me") as Team<Teammate>;
		expect(active.tasks[0]?.status).toBe("pending");
		expect(active.tasks[0]?.assignee).toBeNull();
	});

	it("session lifecycle handlers archive idle teams and preserve active work until shutdown", async () => {
		const harness = ExtensionHarness.create();
		registerTeamsToolExtension(harness.api);

		const idleTeam = createTeamStore("idle-team") as Team<Teammate>;
		const busyTeam = createTeamStore("busy-team") as Team<Teammate>;
		const idle = mockTeammate("idle", "idle");
		const working = mockTeammate("worker", "working");
		idleTeam.teammates.set(idle.teammate.name, idle.teammate);
		busyTeam.teammates.set(working.teammate.name, working.teammate);

		await harness.fireEvent("agent_end", {});

		expect(getTeam("idle-team")).toBeUndefined();
		expect(getArchivedTeams().has("idle-team")).toBe(true);
		expect(getTeam("busy-team")).toBeDefined();

		await harness.fireEvent("session_shutdown", {});

		expect(getTeam("busy-team")).toBeUndefined();
		expect(getArchivedTeams().has("busy-team")).toBe(true);
		expect(idle.calls).toContain("dispose");
		expect(working.calls).toContain("dispose");
		expect(working.teammate.status).toBe("shutdown");
	});

	it("team_send handles already-aborted signals and missing teammates", async () => {
		const harness = ExtensionHarness.create();
		registerTeamsToolExtension(harness.api);

		const send = getTool(harness, "team_send");
		const aborted = new AbortController();
		aborted.abort();
		const cancelled = await execTool(
			send,
			{ team: "alpha", to: "alice", message: "hello", wait: true },
			aborted.signal
		);
		expect(cancelled.isError).toBe(true);
		expect(firstText(cancelled)).toContain("cancelled before execution");

		await execTool(getTool(harness, "team_create"), { name: "alpha" });
		const missing = await execTool(send, {
			team: "alpha",
			to: "ghost",
			message: "hello",
		});
		expect(missing.isError).toBe(true);
		expect(firstText(missing)).toContain("not found in team");
	});

	it("team-dashboard command honors hasUI gate and reports status", async () => {
		const harness = ExtensionHarness.create();
		registerTeamsToolExtension(harness.api);
		const command = harness.commands.get("team-dashboard");
		if (!command) throw new Error("Expected team-dashboard command to be registered");

		const hidden = createCommandContext(false);
		await command.handler("status", hidden.ctx);
		expect(hidden.notifications).toHaveLength(0);

		const visible = createCommandContext(true);
		await command.handler("status", visible.ctx);
		expect(visible.notifications).toHaveLength(1);
		expect(visible.notifications[0]).toContain("dashboard");
	});
});
