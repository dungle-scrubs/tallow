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

describe("agent_end cleanup (simulated)", () => {
	afterEach(() => getTeams().clear());

	/**
	 * Simulate the agent_end handler from index.ts.
	 * Teams with active background work survive; only fully-finished
	 * teams are cleaned up and archived.
	 */
	async function simulateAgentEnd(): Promise<string[]> {
		const archived: string[] = [];
		for (const [name, team] of getTeams() as Map<string, Team<Teammate>>) {
			const hasActiveWork = [...team.teammates.values()].some((m) => m.status === "working");
			if (hasActiveWork) continue;

			for (const [, mate] of team.teammates) {
				if (mate.status === "idle") {
					try {
						mate.unsubscribe?.();
						mate.session.dispose();
					} catch {
						// Best-effort cleanup
					}
					mate.status = "shutdown";
				}
			}
			archived.push(name);
		}
		return archived;
	}

	it("preserves teams with working teammates", async () => {
		const team = freshTeam();
		const { mate, calls } = mockTeammate("alice", "working", true);
		team.teammates.set("alice", mate);

		const archived = await simulateAgentEnd();

		expect(mate.status).toBe("working"); // not killed
		expect(calls).toEqual([]); // no abort or dispose
		expect(archived).toEqual([]); // team not archived
	});

	it("archives team when all teammates are idle", async () => {
		const team = freshTeam();
		const { mate, calls } = mockTeammate("alice", "idle");
		team.teammates.set("alice", mate);

		const archived = await simulateAgentEnd();

		expect(mate.status).toBe("shutdown");
		expect(calls).toContain("dispose");
		expect(archived).toEqual(["test-team"]);
	});

	it("skips already-shutdown teammates", async () => {
		const team = freshTeam();
		const { mate, calls } = mockTeammate("alice", "shutdown");
		team.teammates.set("alice", mate);

		const archived = await simulateAgentEnd();

		expect(mate.status).toBe("shutdown");
		expect(calls).toEqual([]); // no abort or dispose called
		expect(archived).toEqual(["test-team"]); // all done → archive
	});

	it("skips error teammates", async () => {
		const team = freshTeam();
		const { mate, calls } = mockTeammate("alice", "error");
		team.teammates.set("alice", mate);

		const archived = await simulateAgentEnd();

		expect(mate.status).toBe("error");
		expect(calls).toEqual([]);
		expect(archived).toEqual(["test-team"]); // all done → archive
	});

	it("preserves team when any teammate is still working", async () => {
		const team1 = createTeamStore("team1") as Team<Teammate>;
		const team2 = createTeamStore("team2") as Team<Teammate>;

		const { mate: a1 } = mockTeammate("alice", "working", true);
		const { mate: b1, calls: c2 } = mockTeammate("bob", "idle");
		const { mate: a2 } = mockTeammate("carol", "shutdown");

		team1.teammates.set("alice", a1);
		team1.teammates.set("bob", b1);
		team2.teammates.set("carol", a2);

		const archived = await simulateAgentEnd();

		// team1 has alice working → preserved
		expect(a1.status).toBe("working");
		expect(b1.status).toBe("idle"); // not cleaned up (team preserved)
		expect(c2).toEqual([]); // bob not disposed
		expect(archived).not.toContain("team1");

		// team2 has no active work → archived
		expect(archived).toContain("team2");
	});

	it("does not abort or dispose working teammates", async () => {
		const team = freshTeam();
		const { mate: streaming, calls: sc } = mockTeammate("alice", "working", true);
		const { mate: notStreaming, calls: nsc } = mockTeammate("bob", "working", false);
		team.teammates.set("alice", streaming);
		team.teammates.set("bob", notStreaming);

		const archived = await simulateAgentEnd();

		// Both working → team preserved, nothing cleaned up
		expect(sc).toEqual([]);
		expect(nsc).toEqual([]);
		expect(archived).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════
// team_send wait=true abort behavior
// ════════════════════════════════════════════════════════════════

describe("team_send wait=true abort", () => {
	afterEach(() => getTeams().clear());

	/**
	 * Simulate the team_send execute logic for wait=true.
	 * Extracted from the tool's execute function so we can test
	 * the Promise.race / abort-signal behavior in isolation.
	 *
	 * @param mate - Mock teammate
	 * @param signal - AbortSignal to race against
	 * @returns Tool result object
	 */
	async function simulateTeamSendWait(
		mate: Teammate,
		signal?: AbortSignal
	): Promise<{ text: string; isError?: boolean }> {
		if (signal?.aborted) {
			return { text: "team_send was cancelled before execution.", isError: true };
		}

		const abortHandler = () => {
			mate.session.abort().catch(() => {});
		};
		signal?.addEventListener("abort", abortHandler, { once: true });

		try {
			const abortPromise = new Promise<never>((_, reject) => {
				if (signal?.aborted) {
					reject(new DOMException("team_send aborted", "AbortError"));
					return;
				}
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("team_send aborted", "AbortError")),
					{ once: true }
				);
			});

			if (mate.session.isStreaming) {
				await mate.session.followUp("test");
				await Promise.race([mate.session.agent.waitForIdle(), abortPromise]);
			} else {
				mate.status = "working";
				await Promise.race([mate.session.prompt("test"), abortPromise]);
			}
			mate.status = "idle";
			return { text: "completed" };
		} catch {
			if (signal?.aborted) {
				return { text: "cancelled", isError: true };
			}
			mate.status = "error";
			return { text: "errored", isError: true };
		} finally {
			signal?.removeEventListener("abort", abortHandler);
		}
	}

	it("rejects immediately when signal fires during wait", async () => {
		const { mate, calls } = mockTeammate("alice", "idle");
		// Make prompt hang forever (simulating a slow teammate)
		(mate.session as unknown as Record<string, unknown>).prompt = () => new Promise(() => {});

		const ac = new AbortController();

		// Fire abort after a short delay
		setTimeout(() => ac.abort(), 10);

		const result = await simulateTeamSendWait(mate, ac.signal);

		expect(result.isError).toBe(true);
		expect(result.text).toBe("cancelled");
		expect(calls).toContain("abort"); // teammate abort was called
	});

	it("returns error when signal is already aborted at entry", async () => {
		const { mate } = mockTeammate("alice", "idle");
		const ac = new AbortController();
		ac.abort(); // Already aborted

		const result = await simulateTeamSendWait(mate, ac.signal);

		expect(result.isError).toBe(true);
		expect(result.text).toBe("team_send was cancelled before execution.");
	});

	it("handles abort during waitForIdle (streaming teammate)", async () => {
		const { mate, calls } = mockTeammate("alice", "working", true);
		// Make waitForIdle hang forever
		(mate.session as unknown as Record<string, unknown>).agent = {
			waitForIdle: () => new Promise(() => {}),
		};

		const ac = new AbortController();
		setTimeout(() => ac.abort(), 10);

		const result = await simulateTeamSendWait(mate, ac.signal);

		expect(result.isError).toBe(true);
		expect(result.text).toBe("cancelled");
		expect(calls).toContain("abort");
	});

	it("completes normally when no abort signal fires", async () => {
		const { mate } = mockTeammate("alice", "idle");
		// prompt resolves immediately (default mock)

		const ac = new AbortController();
		const result = await simulateTeamSendWait(mate, ac.signal);

		expect(result.isError).toBeUndefined();
		expect(result.text).toBe("completed");
		expect(mate.status).toBe("idle");
	});

	it("does not mark teammate as error on abort", async () => {
		const { mate } = mockTeammate("alice", "idle");
		(mate.session as unknown as Record<string, unknown>).prompt = () => new Promise(() => {});

		const ac = new AbortController();
		setTimeout(() => ac.abort(), 10);

		await simulateTeamSendWait(mate, ac.signal);

		// Status should be "working" (set before Promise.race), NOT "error"
		expect(mate.status).toBe("working");
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
