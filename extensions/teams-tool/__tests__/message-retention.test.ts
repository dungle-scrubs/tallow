import { afterEach, describe, expect, it } from "bun:test";
import { buildDashboardSnapshot } from "../dashboard/state.js";
import {
	addTeamMessage,
	createTeamStore,
	formatTeamStatus,
	getArchivedTeams,
	getTeamMessageRetentionLimit,
	getTeams,
	getUnread,
	markRead,
	TEAM_MESSAGE_KEEP_FULL_HISTORY_ENV,
	TEAM_MESSAGE_RETENTION_LIMIT_DEFAULT,
	TEAM_MESSAGE_RETENTION_LIMIT_ENV,
} from "../store.js";

const originalKeepFullHistory = process.env[TEAM_MESSAGE_KEEP_FULL_HISTORY_ENV];
const originalRetentionLimit = process.env[TEAM_MESSAGE_RETENTION_LIMIT_ENV];

/**
 * Reset active and archived team stores for test isolation.
 * @returns void
 */
function resetTeamStores(): void {
	getTeams().clear();
	getArchivedTeams().clear();
}

/**
 * Restore team-message retention env overrides.
 * @returns void
 */
function restoreRetentionEnv(): void {
	if (originalKeepFullHistory === undefined) {
		delete process.env[TEAM_MESSAGE_KEEP_FULL_HISTORY_ENV];
	} else {
		process.env[TEAM_MESSAGE_KEEP_FULL_HISTORY_ENV] = originalKeepFullHistory;
	}
	if (originalRetentionLimit === undefined) {
		delete process.env[TEAM_MESSAGE_RETENTION_LIMIT_ENV];
	} else {
		process.env[TEAM_MESSAGE_RETENTION_LIMIT_ENV] = originalRetentionLimit;
	}
}

/**
 * Resolve one dashboard team snapshot by name.
 * @param teamName - Team name to locate
 * @returns Dashboard-team snapshot
 * @throws {Error} When the team is missing from the snapshot
 */
function requireDashboardTeam(
	teamName: string
): ReturnType<typeof buildDashboardSnapshot>["teams"][number] {
	const snapshot = buildDashboardSnapshot();
	const team = snapshot.teams.find((entry) => entry.name === teamName);
	expect(team).toBeDefined();
	if (!team) throw new Error(`Expected dashboard team snapshot for "${teamName}"`);
	return team;
}

afterEach(() => {
	resetTeamStores();
	restoreRetentionEnv();
});

describe("team message retention", () => {
	it("keeps all messages when count stays at configured limit", () => {
		delete process.env[TEAM_MESSAGE_KEEP_FULL_HISTORY_ENV];
		process.env[TEAM_MESSAGE_RETENTION_LIMIT_ENV] = "4";
		const team = createTeamStore("retention-boundary");

		for (let index = 0; index < 4; index++) {
			addTeamMessage(team, "alice", "bob", `msg-${index}`);
		}

		expect(team.messages).toHaveLength(4);
		expect(team.messages[0]?.content).toBe("msg-0");
		expect(team.messages[3]?.content).toBe("msg-3");
		expect(getTeamMessageRetentionLimit()).toBe(4);
	});

	it("evicts oldest messages when count exceeds limit", () => {
		process.env[TEAM_MESSAGE_RETENTION_LIMIT_ENV] = "3";
		const team = createTeamStore("retention-overflow");

		for (let index = 0; index < 6; index++) {
			addTeamMessage(team, "alice", "bob", `msg-${index}`);
		}

		expect(team.messages).toHaveLength(3);
		expect(team.messages.map((message) => message.content)).toEqual(["msg-3", "msg-4", "msg-5"]);
	});

	it("keeps unread/read behavior correct after retention evictions", () => {
		process.env[TEAM_MESSAGE_RETENTION_LIMIT_ENV] = "2";
		const team = createTeamStore("retention-unread");

		addTeamMessage(team, "orchestrator", "bob", "stale-direct");
		addTeamMessage(team, "alice", "charlie", "noise");
		addTeamMessage(team, "alice", "bob", "fresh-direct");

		expect(team.messages).toHaveLength(2);
		expect(team.messages.some((message) => message.content === "stale-direct")).toBe(false);
		expect(getUnread(team, "bob")).toHaveLength(1);
		expect(getUnread(team, "bob")[0]?.content).toBe("fresh-direct");

		markRead(team, "bob");
		expect(getUnread(team, "bob")).toEqual([]);
	});

	it("supports debug override that keeps full team-message history", () => {
		process.env[TEAM_MESSAGE_KEEP_FULL_HISTORY_ENV] = "1";
		process.env[TEAM_MESSAGE_RETENTION_LIMIT_ENV] = "2";
		const team = createTeamStore("retention-debug");

		for (let index = 0; index < 5; index++) {
			addTeamMessage(team, "alice", "bob", `msg-${index}`);
		}

		expect(team.messages).toHaveLength(5);
		expect(team.messages[0]?.content).toBe("msg-0");
		expect(team.messages[4]?.content).toBe("msg-4");
		expect(getTeamMessageRetentionLimit()).toBe(Number.POSITIVE_INFINITY);
	});

	it("keeps status and dashboard rendering useful with retained messages", () => {
		const teamName = "retention-formatters";
		process.env[TEAM_MESSAGE_RETENTION_LIMIT_ENV] = "5";
		const team = createTeamStore(teamName);

		for (let index = 0; index < TEAM_MESSAGE_RETENTION_LIMIT_DEFAULT + 2; index++) {
			const from = index % 2 === 0 ? "alice" : "bob";
			const to = index % 2 === 0 ? "all" : "alice";
			addTeamMessage(team, from, to, `message-${index}`);
		}

		const status = formatTeamStatus(team);
		const dashboardTeam = requireDashboardTeam(teamName);
		const latestMessageIndex = TEAM_MESSAGE_RETENTION_LIMIT_DEFAULT + 1;
		expect(status).toContain("## Recent Messages");
		expect(status).toContain(`message-${latestMessageIndex}`);
		expect(dashboardTeam.feed[dashboardTeam.feed.length - 1]?.content).toContain(
			`message-${latestMessageIndex}`
		);
		expect(dashboardTeam.recentMessageLinks).toContain("alice→all");
		expect(dashboardTeam.recentMessageLinks).toContain("bob→@alice");
	});
});
