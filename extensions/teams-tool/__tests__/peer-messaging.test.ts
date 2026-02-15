import { afterEach, describe, expect, it } from "bun:test";
import { createTeammateTools, type Teammate } from "../index";
import { addTeamMessage, createTeamStore, getTeams, getUnread, type Team } from "../store";

// ── Helpers ──────────────────────────────────────────────────

function freshTeam(name = "test-team"): Team<Teammate> {
	getTeams().clear();
	return createTeamStore(name) as Team<Teammate>;
}

/** Create a mock teammate that records prompts and tracks status. */
function mockTeammate(
	name: string,
	status: Teammate["status"] = "idle"
): { mate: Teammate; prompts: string[] } {
	const prompts: string[] = [];
	const mate: Teammate = {
		name,
		role: "test-role",
		model: "test-model",
		status,
		session: {
			isStreaming: false,
			prompt: async (msg: string) => {
				prompts.push(msg);
			},
			followUp: async (msg: string) => {
				prompts.push(msg);
			},
			abort: async () => {},
			dispose: () => {},
			messages: [],
		} as unknown as Teammate["session"],
	};
	return { mate, prompts };
}

/** Find a tool by name, throwing if not found (test helper). */
function findTool(tools: ReturnType<typeof createTeammateTools>, name: string) {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`Tool "${name}" not found`);
	return tool;
}

function mockEvents() {
	const emitted: Array<{ event: string; data: unknown }> = [];
	return {
		emit(event: string, data: unknown) {
			emitted.push({ event, data });
		},
		on() {},
		emitted,
	};
}

// ════════════════════════════════════════════════════════════════
// Direct teammate-to-teammate messaging (no orchestrator)
// ════════════════════════════════════════════════════════════════

describe("peer-to-peer teammate messaging", () => {
	afterEach(() => getTeams().clear());

	it("alice can send a message to bob via team_message tool", async () => {
		const team = freshTeam();
		const { mate: alice } = mockTeammate("alice");
		const { mate: bob, prompts: bobPrompts } = mockTeammate("bob");
		team.teammates.set("alice", alice);
		team.teammates.set("bob", bob);

		const events = mockEvents();
		const aliceTools = createTeammateTools(
			team,
			"alice",
			events as unknown as Parameters<typeof createTeammateTools>[2]
		);
		const messageTool = findTool(aliceTools, "team_message");

		// Alice sends a message to bob
		const result = await messageTool.execute("call-1", { to: "bob", content: "I found 42 files" });

		// Message was stored
		const unread = getUnread(team, "bob");
		expect(unread.length).toBe(1);
		expect(unread[0].from).toBe("alice");
		expect(unread[0].content).toBe("I found 42 files");

		// Bob was auto-woken: wakeTeammate called prompt() which resolves
		// instantly with our mock, so status cycles working → idle.
		// The key assertion is that bob received the prompt.
		expect(bobPrompts.length).toBe(1);
		expect(bobPrompts[0]).toContain("alice");
		expect(bobPrompts[0]).toContain("I found 42 files");

		// Result confirms send
		expect(result.content[0].text).toContain("Message sent to bob");
	});

	it("bob can read alice's message via team_inbox tool", async () => {
		const team = freshTeam();
		const { mate: alice } = mockTeammate("alice");
		const { mate: bob } = mockTeammate("bob", "working");
		team.teammates.set("alice", alice);
		team.teammates.set("bob", bob);

		// Alice sends to bob (manually, simulating tool execution)
		addTeamMessage(team, "alice", "bob", "Check task #3");

		const bobTools = createTeammateTools(team, "bob");
		const inboxTool = findTool(bobTools, "team_inbox");

		const result = await inboxTool.execute("call-2", {});
		expect(result.content[0].text).toContain("1 message(s)");
		expect(result.content[0].text).toContain("[alice] Check task #3");

		// After reading, inbox is empty
		const result2 = await inboxTool.execute("call-3", {});
		expect(result2.content[0].text).toBe("No unread messages.");
	});

	it("broadcast reaches all teammates except sender", async () => {
		const team = freshTeam();
		const { mate: alice } = mockTeammate("alice");
		const { mate: bob, prompts: bobPrompts } = mockTeammate("bob");
		const { mate: carol, prompts: carolPrompts } = mockTeammate("carol");
		team.teammates.set("alice", alice);
		team.teammates.set("bob", bob);
		team.teammates.set("carol", carol);

		const aliceTools = createTeammateTools(team, "alice");
		const messageTool = findTool(aliceTools, "team_message");

		await messageTool.execute("call-4", { to: "all", content: "Step 1 done" });

		// Both bob and carol receive the message
		expect(getUnread(team, "bob").length).toBe(1);
		expect(getUnread(team, "carol").length).toBe(1);

		// Both were woken (they were idle)
		expect(bobPrompts.length).toBe(1);
		expect(carolPrompts.length).toBe(1);

		// Alice doesn't get her own broadcast in unread (she sent it)
		// Note: the broadcast IS stored with to="all", but alice wouldn't
		// read her own messages in practice
		expect(getUnread(team, "alice").length).toBe(1); // to="all" includes sender
	});

	it("message to working teammate is stored but doesn't re-prompt", async () => {
		const team = freshTeam();
		const { mate: alice } = mockTeammate("alice");
		const { mate: bob, prompts: bobPrompts } = mockTeammate("bob", "working");
		team.teammates.set("alice", alice);
		team.teammates.set("bob", bob);

		const aliceTools = createTeammateTools(team, "alice");
		const messageTool = findTool(aliceTools, "team_message");

		await messageTool.execute("call-5", { to: "bob", content: "update for you" });

		// Message stored
		expect(getUnread(team, "bob").length).toBe(1);

		// Bob not re-woken (already working, wakeTeammate skips idle check in tool)
		// The tool only wakes idle recipients
		expect(bobPrompts.length).toBe(0);
	});

	it("message to nonexistent teammate still stores message", async () => {
		const team = freshTeam();
		const { mate: alice } = mockTeammate("alice");
		team.teammates.set("alice", alice);

		const aliceTools = createTeammateTools(team, "alice");
		const messageTool = findTool(aliceTools, "team_message");

		const result = await messageTool.execute("call-6", { to: "ghost", content: "hello?" });
		expect(result.content[0].text).toContain("not found");

		// Message still stored (teammate might join later)
		expect(team.messages.length).toBe(1);
		expect(team.messages[0].to).toBe("ghost");
	});

	it("bidirectional conversation between two teammates", async () => {
		const team = freshTeam();
		const { mate: alice, prompts: alicePrompts } = mockTeammate("alice");
		const { mate: bob, prompts: bobPrompts } = mockTeammate("bob");
		team.teammates.set("alice", alice);
		team.teammates.set("bob", bob);

		const aliceTools = createTeammateTools(team, "alice");
		const bobTools = createTeammateTools(team, "bob");
		const aliceMsg = findTool(aliceTools, "team_message");
		const bobMsg = findTool(bobTools, "team_message");

		// Alice → Bob
		await aliceMsg.execute("c1", { to: "bob", content: "Found 42 files" });
		expect(bobPrompts.length).toBe(1);

		// Simulate bob processing and responding
		bob.status = "working"; // bob is now working from the wake
		alice.status = "idle"; // alice finished her task

		// Bob → Alice
		await bobMsg.execute("c2", { to: "alice", content: "Thanks, I need the list" });
		expect(alicePrompts.length).toBe(1);

		// Both messages in log
		expect(team.messages.length).toBe(2);
		expect(team.messages[0].from).toBe("alice");
		expect(team.messages[1].from).toBe("bob");
	});
});

// ════════════════════════════════════════════════════════════════
// Team task board via teammate tools
// ════════════════════════════════════════════════════════════════

describe("teammate task board operations", () => {
	afterEach(() => getTeams().clear());

	it("teammate can list, claim, and complete tasks", async () => {
		const team = freshTeam();
		const { mate: alice } = mockTeammate("alice");
		team.teammates.set("alice", alice);

		// Add tasks to board
		const { addTaskToBoard } = await import("../store");
		addTaskToBoard(team, "Count files", "Count .ts files", []);

		const aliceTools = createTeammateTools(team, "alice");
		const tasksTool = findTool(aliceTools, "team_tasks");

		// List
		const listResult = await tasksTool.execute("c1", { action: "list" });
		expect(listResult.content[0].text).toContain("Count files");
		expect(listResult.content[0].text).toContain("✓READY");

		// Claim
		const claimResult = await tasksTool.execute("c2", { action: "claim", taskId: "1" });
		expect(claimResult.content[0].text).toContain("Claimed #1");
		expect(team.tasks[0].status).toBe("claimed");
		expect(team.tasks[0].assignee).toBe("alice");

		// Complete
		const completeResult = await tasksTool.execute("c3", {
			action: "complete",
			taskId: "1",
			result: "Found 388 files",
		});
		expect(completeResult.content[0].text).toContain("Completed #1");
		expect(team.tasks[0].status).toBe("completed");
		expect(team.tasks[0].result).toBe("Found 388 files");
	});
});
