import { afterEach, describe, expect, it } from "bun:test";
import {
	addTaskToBoard,
	addTeamMessage,
	createTeamStore,
	formatTeamStatus,
	getReadyTasks,
	getTeam,
	getTeammatesByStatus,
	getTeams,
	getUnread,
	isTaskReady,
	markRead,
	type Team,
	type TeammateRecord,
} from "../store";

// ── Helpers ──────────────────────────────────────────────────

/** Create a fresh team, clearing the global store first. */
function freshTeam(name = "test-team"): Team {
	getTeams().clear();
	return createTeamStore(name);
}

// ════════════════════════════════════════════════════════════════
// Team store
// ════════════════════════════════════════════════════════════════

describe("createTeamStore", () => {
	afterEach(() => getTeams().clear());

	it("creates a team and registers it in the global store", () => {
		const team = createTeamStore("alpha");
		expect(team.name).toBe("alpha");
		expect(team.tasks).toEqual([]);
		expect(team.teammates.size).toBe(0);
		expect(team.messages).toEqual([]);
		expect(team.taskCounter).toBe(0);
		expect(getTeam("alpha")).toBe(team);
	});

	it("overwrites an existing team with the same name", () => {
		const first = createTeamStore("alpha");
		addTaskToBoard(first, "task1", "desc", []);
		const second = createTeamStore("alpha");
		expect(second.tasks).toEqual([]);
		expect(getTeam("alpha")).toBe(second);
	});
});

describe("getTeam", () => {
	afterEach(() => getTeams().clear());

	it("returns undefined for non-existent team", () => {
		expect(getTeam("nope")).toBeUndefined();
	});

	it("returns the team by name", () => {
		const team = createTeamStore("beta");
		expect(getTeam("beta")).toBe(team);
	});
});

// ════════════════════════════════════════════════════════════════
// Task board
// ════════════════════════════════════════════════════════════════

describe("addTaskToBoard", () => {
	it("assigns incrementing IDs", () => {
		const team = freshTeam();
		const t1 = addTaskToBoard(team, "first", "desc1", []);
		const t2 = addTaskToBoard(team, "second", "desc2", []);
		expect(t1.id).toBe("1");
		expect(t2.id).toBe("2");
	});

	it("creates a pending task with no assignee", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "my task", "details", ["99"]);
		expect(task.status).toBe("pending");
		expect(task.assignee).toBeNull();
		expect(task.blockedBy).toEqual(["99"]);
		expect(task.result).toBeNull();
	});

	it("pushes the task into the team's task list", () => {
		const team = freshTeam();
		addTaskToBoard(team, "a", "", []);
		addTaskToBoard(team, "b", "", []);
		expect(team.tasks.length).toBe(2);
		expect(team.tasks[0].title).toBe("a");
		expect(team.tasks[1].title).toBe("b");
	});
});

// ════════════════════════════════════════════════════════════════
// isTaskReady
// ════════════════════════════════════════════════════════════════

describe("isTaskReady", () => {
	it("returns true for pending task with no blockers", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "free", "", []);
		expect(isTaskReady(team, task)).toBe(true);
	});

	it("returns false for non-pending task", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "done", "", []);
		task.status = "completed";
		expect(isTaskReady(team, task)).toBe(false);
	});

	it("returns false for claimed task", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "claimed", "", []);
		task.status = "claimed";
		expect(isTaskReady(team, task)).toBe(false);
	});

	it("returns false when blocker is still pending", () => {
		const team = freshTeam();
		const blocker = addTaskToBoard(team, "blocker", "", []);
		const task = addTaskToBoard(team, "blocked", "", [blocker.id]);
		expect(isTaskReady(team, task)).toBe(false);
	});

	it("returns true when all blockers are completed", () => {
		const team = freshTeam();
		const b1 = addTaskToBoard(team, "b1", "", []);
		const b2 = addTaskToBoard(team, "b2", "", []);
		const task = addTaskToBoard(team, "blocked", "", [b1.id, b2.id]);

		b1.status = "completed";
		expect(isTaskReady(team, task)).toBe(false);

		b2.status = "completed";
		expect(isTaskReady(team, task)).toBe(true);
	});

	it("returns false when blocker is claimed (not completed)", () => {
		const team = freshTeam();
		const blocker = addTaskToBoard(team, "blocker", "", []);
		const task = addTaskToBoard(team, "blocked", "", [blocker.id]);
		blocker.status = "claimed";
		expect(isTaskReady(team, task)).toBe(false);
	});

	it("returns false when blocker is failed", () => {
		const team = freshTeam();
		const blocker = addTaskToBoard(team, "blocker", "", []);
		const task = addTaskToBoard(team, "blocked", "", [blocker.id]);
		blocker.status = "failed";
		expect(isTaskReady(team, task)).toBe(false);
	});

	it("returns false when blocker ID does not exist", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "orphan", "", ["999"]);
		expect(isTaskReady(team, task)).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════
// Messaging
// ════════════════════════════════════════════════════════════════

describe("addTeamMessage", () => {
	it("creates a message with empty readBy set", () => {
		const team = freshTeam();
		const msg = addTeamMessage(team, "alice", "bob", "hello");
		expect(msg.from).toBe("alice");
		expect(msg.to).toBe("bob");
		expect(msg.content).toBe("hello");
		expect(msg.readBy.size).toBe(0);
		expect(msg.timestamp).toBeGreaterThan(0);
	});

	it("pushes messages into the team's message list", () => {
		const team = freshTeam();
		addTeamMessage(team, "alice", "bob", "first");
		addTeamMessage(team, "bob", "alice", "second");
		expect(team.messages.length).toBe(2);
	});
});

describe("getUnread", () => {
	it("returns messages addressed to the recipient", () => {
		const team = freshTeam();
		addTeamMessage(team, "alice", "bob", "for bob");
		addTeamMessage(team, "alice", "charlie", "for charlie");
		const unread = getUnread(team, "bob");
		expect(unread.length).toBe(1);
		expect(unread[0].content).toBe("for bob");
	});

	it("includes broadcast messages (to='all')", () => {
		const team = freshTeam();
		addTeamMessage(team, "alice", "all", "broadcast");
		addTeamMessage(team, "alice", "bob", "direct");
		const unread = getUnread(team, "bob");
		expect(unread.length).toBe(2);
	});

	it("excludes already-read messages", () => {
		const team = freshTeam();
		const msg = addTeamMessage(team, "alice", "bob", "read this");
		msg.readBy.add("bob");
		expect(getUnread(team, "bob").length).toBe(0);
	});

	it("returns empty array when no messages", () => {
		const team = freshTeam();
		expect(getUnread(team, "bob")).toEqual([]);
	});

	it("does not return messages sent to other recipients", () => {
		const team = freshTeam();
		addTeamMessage(team, "alice", "charlie", "not for bob");
		expect(getUnread(team, "bob")).toEqual([]);
	});
});

describe("markRead", () => {
	it("marks direct messages as read", () => {
		const team = freshTeam();
		addTeamMessage(team, "alice", "bob", "msg1");
		addTeamMessage(team, "alice", "bob", "msg2");
		markRead(team, "bob");
		expect(getUnread(team, "bob")).toEqual([]);
	});

	it("marks broadcast messages as read for the recipient", () => {
		const team = freshTeam();
		addTeamMessage(team, "alice", "all", "broadcast");
		markRead(team, "bob");
		expect(getUnread(team, "bob")).toEqual([]);
		// charlie hasn't read it yet
		expect(getUnread(team, "charlie").length).toBe(1);
	});

	it("does not affect messages for other recipients", () => {
		const team = freshTeam();
		addTeamMessage(team, "alice", "charlie", "for charlie");
		markRead(team, "bob");
		expect(getUnread(team, "charlie").length).toBe(1);
	});

	it("is idempotent", () => {
		const team = freshTeam();
		addTeamMessage(team, "alice", "bob", "msg");
		markRead(team, "bob");
		markRead(team, "bob");
		expect(getUnread(team, "bob")).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════
// Integration: task dependency chain
// ════════════════════════════════════════════════════════════════

describe("task dependency chain", () => {
	it("models a linear A → B → C pipeline", () => {
		const team = freshTeam();
		const a = addTaskToBoard(team, "A", "first step", []);
		const b = addTaskToBoard(team, "B", "second step", [a.id]);
		const c = addTaskToBoard(team, "C", "third step", [b.id]);

		// Only A is ready initially
		expect(isTaskReady(team, a)).toBe(true);
		expect(isTaskReady(team, b)).toBe(false);
		expect(isTaskReady(team, c)).toBe(false);

		// Complete A → B becomes ready
		a.status = "completed";
		expect(isTaskReady(team, b)).toBe(true);
		expect(isTaskReady(team, c)).toBe(false);

		// Complete B → C becomes ready
		b.status = "completed";
		expect(isTaskReady(team, c)).toBe(true);
	});

	it("models a fan-in (A + B → C)", () => {
		const team = freshTeam();
		const a = addTaskToBoard(team, "A", "", []);
		const b = addTaskToBoard(team, "B", "", []);
		const c = addTaskToBoard(team, "C", "", [a.id, b.id]);

		expect(isTaskReady(team, c)).toBe(false);

		a.status = "completed";
		expect(isTaskReady(team, c)).toBe(false);

		b.status = "completed";
		expect(isTaskReady(team, c)).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════
// formatTeamStatus
// ════════════════════════════════════════════════════════════════

describe("formatTeamStatus", () => {
	it("shows (none) for empty team", () => {
		const team = freshTeam();
		const out = formatTeamStatus(team);
		expect(out).toContain("# Team: test-team");
		expect(out).toContain("(none)");
	});

	it("shows task statuses with correct icons", () => {
		const team = freshTeam();
		const t1 = addTaskToBoard(team, "Ready Task", "", []);
		const _t2 = addTaskToBoard(team, "Blocked Task", "", [t1.id]);
		t1.status = "completed";
		t1.result = "done!";

		const out = formatTeamStatus(team);
		expect(out).toContain("✓ #1 Ready Task [completed]");
		expect(out).toContain("done!");
		expect(out).toContain("○ #2 Blocked Task [pending]");
	});

	it("shows teammate list", () => {
		const team = freshTeam();
		team.teammates.set("alice", {
			name: "alice",
			role: "Researcher",
			model: "haiku",
			status: "working",
		});
		team.teammates.set("bob", { name: "bob", role: "Writer", model: "sonnet", status: "idle" });

		const out = formatTeamStatus(team);
		expect(out).toContain("⚡ alice (haiku) [working] — Researcher");
		expect(out).toContain("💤 bob (sonnet) [idle] — Writer");
	});

	it("shows recent messages", () => {
		const team = freshTeam();
		addTeamMessage(team, "alice", "bob", "hello bob");

		const out = formatTeamStatus(team);
		expect(out).toContain("## Recent Messages");
		expect(out).toContain("alice → bob: hello bob");
	});

	it("truncates long results and messages", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "Big", "", []);
		task.status = "completed";
		task.result = "x".repeat(300);

		const out = formatTeamStatus(team);
		expect(out).toContain(`${"x".repeat(200)}...`);
	});

	it("limits to last 10 messages", () => {
		const team = freshTeam();
		for (let i = 0; i < 15; i++) {
			addTeamMessage(team, "a", "b", `msg-${i}`);
		}
		const out = formatTeamStatus(team);
		expect(out).not.toContain("msg-4");
		expect(out).toContain("msg-5");
		expect(out).toContain("msg-14");
	});
});

// ════════════════════════════════════════════════════════════════
// Integration: message flow with read tracking
// ════════════════════════════════════════════════════════════════

describe("message flow with read tracking", () => {
	it("tracks independent read state per recipient", () => {
		const team = freshTeam();
		addTeamMessage(team, "orchestrator", "all", "kickoff");
		addTeamMessage(team, "alice", "bob", "direct to bob");

		// Both have unread
		expect(getUnread(team, "alice").length).toBe(1); // broadcast only
		expect(getUnread(team, "bob").length).toBe(2); // broadcast + direct

		// Alice reads
		markRead(team, "alice");
		expect(getUnread(team, "alice").length).toBe(0);
		expect(getUnread(team, "bob").length).toBe(2); // bob unaffected

		// New message after alice read
		addTeamMessage(team, "bob", "all", "update");
		expect(getUnread(team, "alice").length).toBe(1);
		expect(getUnread(team, "bob").length).toBe(3); // 2 original unread + bob's own broadcast (to="all" includes sender)
	});
});

// ════════════════════════════════════════════════════════════════
// getReadyTasks
// ════════════════════════════════════════════════════════════════

describe("getReadyTasks", () => {
	afterEach(() => getTeams().clear());

	it("returns empty for team with no tasks", () => {
		const team = freshTeam();
		expect(getReadyTasks(team)).toEqual([]);
	});

	it("returns unblocked pending tasks", () => {
		const team = freshTeam();
		const t1 = addTaskToBoard(team, "free1", "", []);
		const t2 = addTaskToBoard(team, "free2", "", []);
		expect(getReadyTasks(team)).toEqual([t1, t2]);
	});

	it("excludes claimed tasks", () => {
		const team = freshTeam();
		const t1 = addTaskToBoard(team, "claimed", "", []);
		t1.status = "claimed";
		addTaskToBoard(team, "free", "", []);
		expect(getReadyTasks(team).length).toBe(1);
		expect(getReadyTasks(team)[0].title).toBe("free");
	});

	it("excludes blocked tasks", () => {
		const team = freshTeam();
		const blocker = addTaskToBoard(team, "blocker", "", []);
		addTaskToBoard(team, "blocked", "", [blocker.id]);
		expect(getReadyTasks(team).length).toBe(1);
		expect(getReadyTasks(team)[0].title).toBe("blocker");
	});

	it("includes newly unblocked tasks after blocker completes", () => {
		const team = freshTeam();
		const blocker = addTaskToBoard(team, "blocker", "", []);
		const blocked = addTaskToBoard(team, "blocked", "", [blocker.id]);

		expect(getReadyTasks(team)).toEqual([blocker]);

		blocker.status = "completed";
		expect(getReadyTasks(team)).toEqual([blocked]);
	});

	it("handles fan-in: unblocks only when ALL blockers complete", () => {
		const team = freshTeam();
		const a = addTaskToBoard(team, "A", "", []);
		const b = addTaskToBoard(team, "B", "", []);
		const c = addTaskToBoard(team, "C", "", [a.id, b.id]);

		a.status = "completed";
		expect(getReadyTasks(team)).toEqual([b]); // C still blocked by B

		b.status = "completed";
		expect(getReadyTasks(team)).toEqual([c]);
	});
});

// ════════════════════════════════════════════════════════════════
// getTeammatesByStatus
// ════════════════════════════════════════════════════════════════

describe("getTeammatesByStatus", () => {
	afterEach(() => getTeams().clear());

	function addMate(team: Team, name: string, status: TeammateRecord["status"]): TeammateRecord {
		const mate: TeammateRecord = { name, role: "test", model: "test-model", status };
		team.teammates.set(name, mate);
		return mate;
	}

	it("returns empty when no teammates", () => {
		const team = freshTeam();
		expect(getTeammatesByStatus(team, "idle")).toEqual([]);
	});

	it("filters by idle status", () => {
		const team = freshTeam();
		addMate(team, "alice", "idle");
		addMate(team, "bob", "working");
		addMate(team, "carol", "idle");
		const idle = getTeammatesByStatus(team, "idle");
		expect(idle.length).toBe(2);
		expect(idle.map((m) => m.name)).toEqual(["alice", "carol"]);
	});

	it("filters by working status", () => {
		const team = freshTeam();
		addMate(team, "alice", "idle");
		addMate(team, "bob", "working");
		const working = getTeammatesByStatus(team, "working");
		expect(working.length).toBe(1);
		expect(working[0].name).toBe("bob");
	});

	it("filters by shutdown status", () => {
		const team = freshTeam();
		addMate(team, "alice", "shutdown");
		addMate(team, "bob", "idle");
		expect(getTeammatesByStatus(team, "shutdown").length).toBe(1);
	});

	it("returns all when all match", () => {
		const team = freshTeam();
		addMate(team, "alice", "idle");
		addMate(team, "bob", "idle");
		expect(getTeammatesByStatus(team, "idle").length).toBe(2);
	});
});
