import { afterEach, describe, expect, it } from "bun:test";
import { autoDispatch, type Teammate } from "../index";
import { addTaskToBoard, createTeamStore, getTeams, type Team } from "../store";

// ── Helpers ──────────────────────────────────────────────────

function freshTeam(name = "test-team"): Team<Teammate> {
	getTeams().clear();
	return createTeamStore(name) as Team<Teammate>;
}

/** Create a mock teammate with a fake session that records prompts. */
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

/** Mock event emitter for testing event emission. */
function _mockEvents() {
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
// autoDispatch — core logic
// ════════════════════════════════════════════════════════════════

describe("autoDispatch", () => {
	afterEach(() => getTeams().clear());

	it("assigns a ready task to an idle teammate", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "Write tests", "Unit tests", []);
		const { mate, prompts } = mockTeammate("alice");
		team.teammates.set("alice", mate);

		const count = autoDispatch(team);

		expect(count).toBe(1);
		expect(task.status).toBe("claimed");
		expect(task.assignee).toBe("alice");
		expect(mate.status).toBe("working");
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toContain("Write tests");
	});

	it("does nothing when no tasks are ready", () => {
		const team = freshTeam();
		const blocker = addTaskToBoard(team, "blocker", "", []);
		addTaskToBoard(team, "blocked", "", [blocker.id]);
		blocker.status = "claimed"; // not completed, so blocked stays blocked
		const { mate } = mockTeammate("alice");
		team.teammates.set("alice", mate);

		expect(autoDispatch(team)).toBe(0);
		expect(mate.status).toBe("idle");
	});

	it("does nothing when no teammates are idle", () => {
		const team = freshTeam();
		addTaskToBoard(team, "ready", "", []);
		const { mate } = mockTeammate("bob", "working");
		team.teammates.set("bob", mate);

		expect(autoDispatch(team)).toBe(0);
	});

	it("assigns multiple tasks to multiple idle teammates", () => {
		const team = freshTeam();
		const t1 = addTaskToBoard(team, "Task A", "", []);
		const t2 = addTaskToBoard(team, "Task B", "", []);
		const { mate: alice } = mockTeammate("alice");
		const { mate: bob } = mockTeammate("bob");
		team.teammates.set("alice", alice);
		team.teammates.set("bob", bob);

		expect(autoDispatch(team)).toBe(2);
		expect(t1.status).toBe("claimed");
		expect(t1.assignee).toBe("alice");
		expect(t2.status).toBe("claimed");
		expect(t2.assignee).toBe("bob");
	});

	it("stops when idle teammates are exhausted", () => {
		const team = freshTeam();
		addTaskToBoard(team, "Task A", "", []);
		addTaskToBoard(team, "Task B", "", []);
		addTaskToBoard(team, "Task C", "", []);
		const { mate } = mockTeammate("alice");
		team.teammates.set("alice", mate);

		expect(autoDispatch(team)).toBe(1);
		// Only first task claimed, other two still pending
		expect(team.tasks[0].status).toBe("claimed");
		expect(team.tasks[1].status).toBe("pending");
		expect(team.tasks[2].status).toBe("pending");
	});

	it("skips shutdown and error teammates", () => {
		const team = freshTeam();
		addTaskToBoard(team, "ready", "", []);
		const { mate: dead } = mockTeammate("dead", "shutdown");
		const { mate: broken } = mockTeammate("broken", "error");
		team.teammates.set("dead", dead);
		team.teammates.set("broken", broken);

		expect(autoDispatch(team)).toBe(0);
	});

	it("includes task description in the prompt", () => {
		const team = freshTeam();
		addTaskToBoard(team, "Deploy", "Push to staging env", []);
		const { mate, prompts } = mockTeammate("alice");
		team.teammates.set("alice", mate);

		autoDispatch(team);
		expect(prompts[0]).toContain("Deploy");
		expect(prompts[0]).toContain("Push to staging env");
	});
});

// ════════════════════════════════════════════════════════════════
// autoDispatch — triggered by task completion
// ════════════════════════════════════════════════════════════════

describe("autoDispatch on task completion (unblock chain)", () => {
	afterEach(() => getTeams().clear());

	it("dispatches newly unblocked task when blocker completes", () => {
		const team = freshTeam();
		const blocker = addTaskToBoard(team, "Step 1", "", []);
		const blocked = addTaskToBoard(team, "Step 2", "", [blocker.id]);
		const { mate } = mockTeammate("alice");
		team.teammates.set("alice", mate);

		// Step 2 blocked, no dispatch
		expect(autoDispatch(team)).toBe(1); // dispatches Step 1
		expect(blocker.status).toBe("claimed");
		expect(blocked.status).toBe("pending");

		// Complete Step 1 → Step 2 should now be ready
		blocker.status = "completed";
		// Reset alice to idle (simulating prompt completion)
		mate.status = "idle";

		expect(autoDispatch(team)).toBe(1);
		expect(blocked.status).toBe("claimed");
		expect(blocked.assignee).toBe("alice");
	});

	it("fan-in: dispatches only when all blockers complete", () => {
		const team = freshTeam();
		const a = addTaskToBoard(team, "A", "", []);
		const b = addTaskToBoard(team, "B", "", []);
		const c = addTaskToBoard(team, "C", "", [a.id, b.id]);
		const { mate } = mockTeammate("alice");
		team.teammates.set("alice", mate);

		a.status = "completed";
		mate.status = "idle";
		// B still pending, so C stays blocked. Only B is dispatchable.
		const count = autoDispatch(team);
		expect(count).toBe(1);
		expect(team.tasks.find((t) => t.title === "B")?.status).toBe("claimed");
		expect(c.status).toBe("pending"); // still blocked

		b.status = "completed";
		mate.status = "idle";
		expect(autoDispatch(team)).toBe(1);
		expect(c.status).toBe("claimed");
	});
});

// ════════════════════════════════════════════════════════════════
// autoDispatch — no double-dispatch
// ════════════════════════════════════════════════════════════════

describe("autoDispatch idempotency", () => {
	afterEach(() => getTeams().clear());

	it("does not re-dispatch already claimed tasks", () => {
		const team = freshTeam();
		const task = addTaskToBoard(team, "claimed", "", []);
		task.status = "claimed";
		task.assignee = "bob";
		const { mate } = mockTeammate("alice");
		team.teammates.set("alice", mate);

		expect(autoDispatch(team)).toBe(0);
	});

	it("calling autoDispatch twice does not double-assign", () => {
		const team = freshTeam();
		addTaskToBoard(team, "only one", "", []);
		const { mate } = mockTeammate("alice");
		team.teammates.set("alice", mate);

		expect(autoDispatch(team)).toBe(1);
		mate.status = "idle"; // simulate completion
		expect(autoDispatch(team)).toBe(0); // no more ready tasks
	});
});
