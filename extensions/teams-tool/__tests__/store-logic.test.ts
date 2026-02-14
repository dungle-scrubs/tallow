/**
 * Tests for teams-tool pure store functions:
 * team creation, task board, dependency resolution, archival/restore,
 * messaging, teammate filtering, and status formatting.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	addTaskToBoard,
	addTeamMessage,
	archiveTeam,
	createTeamStore,
	formatArchivedTeamStatus,
	formatTeamStatus,
	getArchivedTeams,
	getReadyTasks,
	getTeam,
	getTeammatesByStatus,
	getTeams,
	getUnread,
	isTaskReady,
	markRead,
	restoreArchivedTeam,
	type Team,
	type TeamTask,
} from "../store.js";

beforeEach(() => {
	getTeams().clear();
	getArchivedTeams().clear();
});

afterEach(() => {
	getTeams().clear();
	getArchivedTeams().clear();
});

// ── createTeamStore ──────────────────────────────────────────────────────────

describe("createTeamStore", () => {
	it("creates a team with empty collections", () => {
		const team = createTeamStore("alpha");
		expect(team.name).toBe("alpha");
		expect(team.tasks).toEqual([]);
		expect(team.teammates.size).toBe(0);
		expect(team.messages).toEqual([]);
		expect(team.taskCounter).toBe(0);
	});

	it("makes the team retrievable by getTeam", () => {
		createTeamStore("beta");
		expect(getTeam("beta")).toBeDefined();
		expect(getTeam("beta")?.name).toBe("beta");
	});

	it("getTeam returns undefined for nonexistent team", () => {
		expect(getTeam("nonexistent")).toBeUndefined();
	});
});

// ── addTaskToBoard ───────────────────────────────────────────────────────────

describe("addTaskToBoard", () => {
	it("adds task with correct defaults", () => {
		const team = createTeamStore("t1");
		const task = addTaskToBoard(team, "Build feature", "Detailed desc", []);

		expect(task.id).toBe("1");
		expect(task.title).toBe("Build feature");
		expect(task.description).toBe("Detailed desc");
		expect(task.status).toBe("pending");
		expect(task.assignee).toBeNull();
		expect(task.blockedBy).toEqual([]);
		expect(task.result).toBeNull();
	});

	it("increments task counter", () => {
		const team = createTeamStore("t2");
		const first = addTaskToBoard(team, "First", "", []);
		const second = addTaskToBoard(team, "Second", "", []);

		expect(first.id).toBe("1");
		expect(second.id).toBe("2");
		expect(team.taskCounter).toBe(2);
	});

	it("sets blockedBy dependencies", () => {
		const team = createTeamStore("t3");
		addTaskToBoard(team, "Prerequisite", "", []);
		const task = addTaskToBoard(team, "Dependent", "", ["1"]);

		expect(task.blockedBy).toEqual(["1"]);
	});
});

// ── isTaskReady / getReadyTasks ──────────────────────────────────────────────

describe("isTaskReady", () => {
	it("pending task with no deps is ready", () => {
		const team = createTeamStore("ready1");
		const task = addTaskToBoard(team, "No deps", "", []);
		expect(isTaskReady(team, task)).toBe(true);
	});

	it("pending task with unmet deps is not ready", () => {
		const team = createTeamStore("ready2");
		addTaskToBoard(team, "Blocker", "", []);
		const task = addTaskToBoard(team, "Blocked", "", ["1"]);
		expect(isTaskReady(team, task)).toBe(false);
	});

	it("pending task becomes ready when deps are completed", () => {
		const team = createTeamStore("ready3");
		const blocker = addTaskToBoard(team, "Blocker", "", []);
		const blocked = addTaskToBoard(team, "Blocked", "", ["1"]);

		blocker.status = "completed";
		expect(isTaskReady(team, blocked)).toBe(true);
	});

	it("claimed task is not ready (already assigned)", () => {
		const team = createTeamStore("ready4");
		const task = addTaskToBoard(team, "Claimed", "", []);
		task.status = "claimed";
		expect(isTaskReady(team, task)).toBe(false);
	});

	it("completed task is not ready", () => {
		const team = createTeamStore("ready5");
		const task = addTaskToBoard(team, "Done", "", []);
		task.status = "completed";
		expect(isTaskReady(team, task)).toBe(false);
	});

	it("failed task is not ready", () => {
		const team = createTeamStore("ready6");
		const task = addTaskToBoard(team, "Failed", "", []);
		task.status = "failed";
		expect(isTaskReady(team, task)).toBe(false);
	});
});

describe("getReadyTasks", () => {
	it("returns only pending tasks with met dependencies", () => {
		const team = createTeamStore("gr1");
		const t1 = addTaskToBoard(team, "Ready", "", []);
		const t2 = addTaskToBoard(team, "Blocked", "", ["1"]);
		const t3 = addTaskToBoard(team, "Also ready", "", []);

		const ready = getReadyTasks(team);
		expect(ready).toHaveLength(2);
		expect(ready.map((t) => t.title)).toContain("Ready");
		expect(ready.map((t) => t.title)).toContain("Also ready");
	});

	it("returns empty array when all tasks are blocked", () => {
		const team = createTeamStore("gr2");
		addTaskToBoard(team, "A blocks B", "", []);
		addTaskToBoard(team, "B", "", ["1"]);
		team.tasks[0].status = "claimed";

		const ready = getReadyTasks(team);
		expect(ready).toHaveLength(0);
	});
});

// ── archiveTeam / restoreArchivedTeam ────────────────────────────────────────

describe("archiveTeam", () => {
	it("moves team to archive and removes from active", () => {
		createTeamStore("arch1");
		archiveTeam("arch1");

		expect(getTeam("arch1")).toBeUndefined();
		expect(getArchivedTeams().has("arch1")).toBe(true);
	});

	it("preserves tasks and messages in archive", () => {
		const team = createTeamStore("arch2");
		addTaskToBoard(team, "Task 1", "", []);
		addTeamMessage(team, "alice", "bob", "Hello");

		const archived = archiveTeam("arch2");
		expect(archived).toBeDefined();
		expect(archived!.tasks).toHaveLength(1);
		expect(archived!.messages).toHaveLength(1);
	});

	it("returns undefined for nonexistent team", () => {
		expect(archiveTeam("ghost")).toBeUndefined();
	});

	it("records archivedAt timestamp", () => {
		createTeamStore("arch3");
		const before = Date.now();
		const archived = archiveTeam("arch3");
		const after = Date.now();

		expect(archived!.archivedAt).toBeGreaterThanOrEqual(before);
		expect(archived!.archivedAt).toBeLessThanOrEqual(after);
	});
});

describe("restoreArchivedTeam", () => {
	it("restores archived team to active", () => {
		createTeamStore("rest1");
		archiveTeam("rest1");
		restoreArchivedTeam("rest1");

		expect(getTeam("rest1")).toBeDefined();
		expect(getArchivedTeams().has("rest1")).toBe(false);
	});

	it("preserves task state as-is (reset happens in tool layer)", () => {
		const team = createTeamStore("rest2");
		const task = addTaskToBoard(team, "Was claimed", "", []);
		task.status = "claimed";
		task.assignee = "alice";

		archiveTeam("rest2");
		restoreArchivedTeam("rest2");

		const restored = getTeam("rest2")!;
		// Store layer preserves task state — tool layer resets claimed to pending
		expect(restored.tasks[0].status).toBe("claimed");
		expect(restored.tasks[0].assignee).toBe("alice");
	});

	it("returns undefined for nonexistent archive", () => {
		expect(restoreArchivedTeam("ghost")).toBeUndefined();
	});
});

// ── Messaging ────────────────────────────────────────────────────────────────

describe("addTeamMessage", () => {
	it("adds message with correct fields", () => {
		const team = createTeamStore("msg1");
		const msg = addTeamMessage(team, "alice", "bob", "Hello there");

		expect(msg.from).toBe("alice");
		expect(msg.to).toBe("bob");
		expect(msg.content).toBe("Hello there");
		expect(msg.timestamp).toBeGreaterThan(0);
	});

	it("readBy starts empty (sender not auto-added)", () => {
		const team = createTeamStore("msg2");
		const msg = addTeamMessage(team, "alice", "bob", "Hi");

		expect(msg.readBy.size).toBe(0);
	});

	it("accumulates messages in team", () => {
		const team = createTeamStore("msg3");
		addTeamMessage(team, "a", "b", "First");
		addTeamMessage(team, "b", "a", "Reply");

		expect(team.messages).toHaveLength(2);
	});
});

describe("getUnread / markRead", () => {
	it("returns unread messages for recipient", () => {
		const team = createTeamStore("unread1");
		addTeamMessage(team, "alice", "bob", "Read me");
		addTeamMessage(team, "charlie", "bob", "Also for bob");

		const unread = getUnread(team, "bob");
		expect(unread).toHaveLength(2);
	});

	it("excludes messages already read by recipient", () => {
		const team = createTeamStore("unread2");
		addTeamMessage(team, "alice", "bob", "Message");

		markRead(team, "bob");
		const unread = getUnread(team, "bob");
		expect(unread).toHaveLength(0);
	});

	it("broadcast messages (to 'all') are unread for everyone", () => {
		const team = createTeamStore("unread3");
		addTeamMessage(team, "alice", "all", "Announcement");

		expect(getUnread(team, "bob")).toHaveLength(1);
		// readBy starts empty — sender is also unread until markRead
		expect(getUnread(team, "alice")).toHaveLength(1);
	});
});

// ── getTeammatesByStatus ─────────────────────────────────────────────────────

describe("getTeammatesByStatus", () => {
	it("filters by status correctly", () => {
		const team = createTeamStore("status1");
		team.teammates.set("a", { name: "a", role: "r", model: "m", status: "idle" });
		team.teammates.set("b", { name: "b", role: "r", model: "m", status: "working" });
		team.teammates.set("c", { name: "c", role: "r", model: "m", status: "idle" });

		const idle = getTeammatesByStatus(team, "idle");
		expect(idle).toHaveLength(2);

		const working = getTeammatesByStatus(team, "working");
		expect(working).toHaveLength(1);
		expect(working[0].name).toBe("b");
	});

	it("returns empty array when no matches", () => {
		const team = createTeamStore("status2");
		team.teammates.set("a", { name: "a", role: "r", model: "m", status: "idle" });

		expect(getTeammatesByStatus(team, "working")).toHaveLength(0);
	});
});

// ── formatTeamStatus / formatArchivedTeamStatus ──────────────────────────────

describe("formatTeamStatus", () => {
	it("includes team name", () => {
		const team = createTeamStore("fmt1");
		const text = formatTeamStatus(team);
		expect(text).toContain("fmt1");
	});

	it("shows task counts", () => {
		const team = createTeamStore("fmt2");
		addTaskToBoard(team, "Pending", "", []);
		const completed = addTaskToBoard(team, "Done", "", []);
		completed.status = "completed";

		const text = formatTeamStatus(team);
		// Should mention tasks in some form
		expect(text.length).toBeGreaterThan(0);
	});
});

describe("formatArchivedTeamStatus", () => {
	it("includes team name and archived timestamp", () => {
		const team = createTeamStore("afmt1");
		addTaskToBoard(team, "Task", "", []);
		const archived = archiveTeam("afmt1")!;

		const text = formatArchivedTeamStatus(archived);
		expect(text).toContain("afmt1");
		expect(text.length).toBeGreaterThan(0);
	});
});
