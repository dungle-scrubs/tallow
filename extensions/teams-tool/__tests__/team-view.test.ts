import { afterEach, describe, expect, it } from "bun:test";
import { buildTeamView, type Teammate } from "../index";
import { addTaskToBoard, createTeamStore, getTeams, type Team } from "../store";

// ── Helpers ──────────────────────────────────────────────────

function freshTeam(name = "test-team"): Team<Teammate> {
	getTeams().clear();
	return createTeamStore(name) as Team<Teammate>;
}

function addMockTeammate(
	team: Team<Teammate>,
	name: string,
	status: Teammate["status"] = "idle"
): Teammate {
	const mate: Teammate = {
		name,
		role: `${name}-role`,
		model: "test-model",
		status,
		session: {
			isStreaming: false,
			prompt: async () => {},
			followUp: async () => {},
			abort: async () => {},
			dispose: () => {},
			messages: [],
		} as unknown as Teammate["session"],
	};
	team.teammates.set(name, mate);
	return mate;
}

// ════════════════════════════════════════════════════════════════
// buildTeamView
// ════════════════════════════════════════════════════════════════

describe("buildTeamView", () => {
	afterEach(() => getTeams().clear());

	it("produces a serializable snapshot with no session references", () => {
		const team = freshTeam();
		addTaskToBoard(team, "Task A", "desc", []);
		addMockTeammate(team, "alice", "working");

		const view = buildTeamView(team);

		// No AgentSession in the output
		expect(JSON.stringify(view)).not.toContain("session");
		expect(view.name).toBe("test-team");
		expect(view.tasks.length).toBe(1);
		expect(view.teammates.length).toBe(1);
	});

	it("maps task fields correctly", () => {
		const team = freshTeam();
		const blocker = addTaskToBoard(team, "Step 1", "", []);
		addTaskToBoard(team, "Step 2", "", [blocker.id]);
		blocker.status = "completed";

		const view = buildTeamView(team);

		expect(view.tasks[0]).toEqual({
			id: "1",
			title: "Step 1",
			status: "completed",
			assignee: null,
			blockedBy: [],
		});
		expect(view.tasks[1]).toEqual({
			id: "2",
			title: "Step 2",
			status: "pending",
			assignee: null,
			blockedBy: ["1"],
		});
	});

	it("maps teammate fields and detects current task", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "Count files", "", []);
		task.status = "claimed";
		task.assignee = "alice";
		addMockTeammate(team, "alice", "working");
		addMockTeammate(team, "bob", "idle");

		const view = buildTeamView(team);

		const alice = view.teammates.find((m) => m.name === "alice")!;
		expect(alice.status).toBe("working");
		expect(alice.currentTask).toBe("Count files");

		const bob = view.teammates.find((m) => m.name === "bob")!;
		expect(bob.status).toBe("idle");
		expect(bob.currentTask).toBeUndefined();
	});

	it("handles empty team", () => {
		const team = freshTeam();
		const view = buildTeamView(team);

		expect(view.name).toBe("test-team");
		expect(view.tasks).toEqual([]);
		expect(view.teammates).toEqual([]);
	});

	it("only assigns currentTask for claimed tasks", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "Done task", "", []);
		task.status = "completed";
		task.assignee = "alice";
		addMockTeammate(team, "alice", "idle");

		const view = buildTeamView(team);
		const alice = view.teammates.find((m) => m.name === "alice")!;
		expect(alice.currentTask).toBeUndefined(); // completed, not claimed
	});
});
