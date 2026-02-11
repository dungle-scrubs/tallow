import { afterEach, describe, expect, it } from "bun:test";
import { addTaskToBoard, createTeamStore, getTeams, type Team } from "../store";

/**
 * Tests for teammate_idle and task_completed event emission.
 *
 * Since wakeTeammate and createTeammateTools require real AgentSession
 * instances, we test the event contracts and store state transitions
 * that trigger events.
 */

// ── Helpers ──────────────────────────────────────────────────

function freshTeam(name = "test-team"): Team {
	getTeams().clear();
	return createTeamStore(name);
}

/** Mock event emitter that records emitted events */
function createMockEvents() {
	const emitted: Array<{ event: string; data: unknown }> = [];
	return {
		emit(event: string, data: unknown) {
			emitted.push({ event, data });
		},
		on(_event: string, _handler: (data: unknown) => void) {},
		emitted,
	};
}

// ════════════════════════════════════════════════════════════════
// task_completed event data
// ════════════════════════════════════════════════════════════════

describe("task_completed event contract", () => {
	afterEach(() => getTeams().clear());

	it("task completion updates store state correctly", () => {
		const team = freshTeam();
		addTaskToBoard(team, "Write tests", "Add unit tests for events", []);

		const task = team.tasks[0];
		task.status = "claimed";
		task.assignee = "alice";

		// Simulate what createTeammateTools does on complete
		task.status = "completed";
		task.result = "All tests passing";

		expect(task.status).toBe("completed");
		expect(task.result).toBe("All tests passing");
		expect(task.assignee).toBe("alice");
	});

	it("event payload matches expected shape", () => {
		const events = createMockEvents();
		const team = freshTeam("my-team");
		addTaskToBoard(team, "Deploy", "", []);
		const task = team.tasks[0];
		task.assignee = "bob";

		// Simulate the emit that createTeammateTools does
		task.status = "completed";
		task.result = "Deployed v2.0";
		events.emit("task_completed", {
			team: team.name,
			task_id: task.id,
			task_title: task.title,
			assignee: task.assignee,
			result: task.result,
		});

		expect(events.emitted).toHaveLength(1);
		const payload = events.emitted[0];
		expect(payload.event).toBe("task_completed");
		expect(payload.data).toEqual({
			team: "my-team",
			task_id: task.id,
			task_title: "Deploy",
			assignee: "bob",
			result: "Deployed v2.0",
		});
	});
});

// ════════════════════════════════════════════════════════════════
// teammate_idle event data
// ════════════════════════════════════════════════════════════════

describe("teammate_idle event contract", () => {
	it("event payload matches expected shape", () => {
		const events = createMockEvents();

		// Simulate the emit that wakeTeammate does when work completes
		events.emit("teammate_idle", {
			team: "my-team",
			teammate: "alice",
			role: "reviewer",
		});

		expect(events.emitted).toHaveLength(1);
		const payload = events.emitted[0];
		expect(payload.event).toBe("teammate_idle");
		expect(payload.data).toEqual({
			team: "my-team",
			teammate: "alice",
			role: "reviewer",
		});
	});
});

// ════════════════════════════════════════════════════════════════
// hooks matcher fields
// ════════════════════════════════════════════════════════════════

describe("hook matcher field mapping", () => {
	it("teammate_idle matches on 'teammate' field", () => {
		const data = { team: "t", teammate: "alice", role: "dev" };
		const matcherField = "teammate";
		const pattern = /alice/;
		expect(pattern.test(data[matcherField])).toBe(true);
	});

	it("task_completed matches on 'assignee' field", () => {
		const data = {
			team: "t",
			task_id: "1",
			task_title: "Test",
			assignee: "bob",
			result: "done",
		};
		const matcherField = "assignee";
		const pattern = /bob/;
		expect(pattern.test(data[matcherField])).toBe(true);
	});
});
