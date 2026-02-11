import { afterEach, describe, expect, it } from "bun:test";
import type { Teammate } from "../index";
import { createTeamStore, getTeams, type Team } from "../store";

// ── Helpers ──────────────────────────────────────────────────

function freshTeam(name = "test-team"): Team<Teammate> {
	getTeams().clear();
	return createTeamStore(name) as Team<Teammate>;
}

/** Create a mock teammate tracking abort/dispose calls. */
function mockTeammate(
	name: string,
	status: Teammate["status"] = "working",
	isStreaming = false
): { mate: Teammate; calls: string[] } {
	const calls: string[] = [];
	const mate: Teammate = {
		name,
		role: "test-role",
		model: "test-model",
		status,
		session: {
			isStreaming,
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
	return { mate, calls };
}

// ════════════════════════════════════════════════════════════════
// agent_end interrupt behavior (simulated)
// ════════════════════════════════════════════════════════════════

describe("agent_end interrupt (simulated)", () => {
	afterEach(() => getTeams().clear());

	/**
	 * Simulate the agent_end handler from index.ts.
	 * We test the logic directly since we can't trigger pi.on("agent_end")
	 * without a full extension runtime.
	 */
	async function simulateAgentEnd() {
		for (const [, team] of getTeams() as Map<string, Team<Teammate>>) {
			for (const [, mate] of team.teammates) {
				if (mate.status === "working" || mate.status === "idle") {
					try {
						if (mate.session.isStreaming) await mate.session.abort();
						mate.session.dispose();
					} catch {
						// Best-effort cleanup
					}
					mate.status = "shutdown";
				}
			}
		}
	}

	it("shuts down working teammates", async () => {
		const team = freshTeam();
		const { mate, calls } = mockTeammate("alice", "working", true);
		team.teammates.set("alice", mate);

		await simulateAgentEnd();

		expect(mate.status).toBe("shutdown");
		expect(calls).toContain("abort");
		expect(calls).toContain("dispose");
	});

	it("shuts down idle teammates", async () => {
		const team = freshTeam();
		const { mate, calls } = mockTeammate("alice", "idle");
		team.teammates.set("alice", mate);

		await simulateAgentEnd();

		expect(mate.status).toBe("shutdown");
		expect(calls).toContain("dispose");
	});

	it("skips already-shutdown teammates", async () => {
		const team = freshTeam();
		const { mate, calls } = mockTeammate("alice", "shutdown");
		team.teammates.set("alice", mate);

		await simulateAgentEnd();

		expect(mate.status).toBe("shutdown");
		expect(calls).toEqual([]); // no abort or dispose called
	});

	it("skips error teammates", async () => {
		const team = freshTeam();
		const { mate, calls } = mockTeammate("alice", "error");
		team.teammates.set("alice", mate);

		await simulateAgentEnd();

		expect(mate.status).toBe("error");
		expect(calls).toEqual([]);
	});

	it("handles multiple teams and teammates", async () => {
		const team1 = createTeamStore("team1") as Team<Teammate>;
		const team2 = createTeamStore("team2") as Team<Teammate>;

		const { mate: a1, calls: c1 } = mockTeammate("alice", "working", true);
		const { mate: b1, calls: c2 } = mockTeammate("bob", "idle");
		const { mate: a2, calls: c3 } = mockTeammate("carol", "working");

		team1.teammates.set("alice", a1);
		team1.teammates.set("bob", b1);
		team2.teammates.set("carol", a2);

		await simulateAgentEnd();

		expect(a1.status).toBe("shutdown");
		expect(b1.status).toBe("shutdown");
		expect(a2.status).toBe("shutdown");
		expect(c1).toContain("abort"); // was streaming
		expect(c2).not.toContain("abort"); // not streaming
		expect(c3).not.toContain("abort"); // not streaming
	});

	it("only aborts streaming teammates", async () => {
		const team = freshTeam();
		const { mate: streaming, calls: sc } = mockTeammate("alice", "working", true);
		const { mate: notStreaming, calls: nsc } = mockTeammate("bob", "working", false);
		team.teammates.set("alice", streaming);
		team.teammates.set("bob", notStreaming);

		await simulateAgentEnd();

		expect(sc).toContain("abort");
		expect(nsc).not.toContain("abort");
		// Both should be disposed
		expect(sc).toContain("dispose");
		expect(nsc).toContain("dispose");
	});
});

// ════════════════════════════════════════════════════════════════
// session_shutdown behavior (simulated)
// ════════════════════════════════════════════════════════════════

describe("session_shutdown (simulated)", () => {
	afterEach(() => getTeams().clear());

	async function simulateSessionShutdown() {
		for (const [, team] of getTeams() as Map<string, Team<Teammate>>) {
			for (const [, mate] of team.teammates) {
				try {
					if (mate.session.isStreaming) await mate.session.abort();
					mate.session.dispose();
				} catch {
					// ignore
				}
				mate.status = "shutdown";
			}
		}
		getTeams().clear();
	}

	it("shuts down all teammates regardless of status", async () => {
		const team = freshTeam();
		const { mate: working } = mockTeammate("alice", "working");
		const { mate: idle } = mockTeammate("bob", "idle");
		const { mate: errored } = mockTeammate("carol", "error");
		team.teammates.set("alice", working);
		team.teammates.set("bob", idle);
		team.teammates.set("carol", errored);

		await simulateSessionShutdown();

		expect(working.status).toBe("shutdown");
		expect(idle.status).toBe("shutdown");
		expect(errored.status).toBe("shutdown");
	});

	it("clears the teams store", async () => {
		freshTeam("team1");
		createTeamStore("team2");

		await simulateSessionShutdown();
		expect(getTeams().size).toBe(0);
	});
});
