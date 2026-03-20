import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteArchivedTeamFromDisk,
	getTeamArchivesDir,
	loadAllArchivedTeamsFromDisk,
	loadArchivedTeamFromDisk,
	writeArchivedTeamToDisk,
} from "../archive-store.js";
import {
	addTaskToBoard,
	addTeamMessage,
	archiveTeam,
	createTeamStore,
	getArchivedTeams,
	getTeams,
} from "../store.js";

let originalTallowHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
	originalTallowHome = process.env.TALLOW_CODING_AGENT_DIR;
	tmpHome = mkdtempSync(join(tmpdir(), "tallow-team-archives-"));
	process.env.TALLOW_CODING_AGENT_DIR = tmpHome;
	getArchivedTeams().clear();
	getTeams().clear();
});

afterEach(() => {
	getArchivedTeams().clear();
	getTeams().clear();
	if (originalTallowHome === undefined) {
		delete process.env.TALLOW_CODING_AGENT_DIR;
	} else {
		process.env.TALLOW_CODING_AGENT_DIR = originalTallowHome;
	}
	rmSync(tmpHome, { force: true, recursive: true });
});

describe("team archive persistence", () => {
	it("writes and reloads archived teams from disk", () => {
		const team = createTeamStore("alpha");
		addTaskToBoard(team, "Investigate", "Read files", []);
		const message = addTeamMessage(team, "alice", "bob", "hello");
		message.readBy.add("bob");

		const archived = archiveTeam("alpha");
		expect(archived).toBeDefined();
		if (!archived) return;

		writeArchivedTeamToDisk(archived);

		const loaded = loadArchivedTeamFromDisk("alpha");
		expect(loaded).toBeDefined();
		expect(loaded?.name).toBe("alpha");
		expect(loaded?.tasks).toHaveLength(1);
		expect(loaded?.messages).toHaveLength(1);
		expect(loaded?.messages[0].readBy.has("bob")).toBe(true);
	});

	it("lists archives newest-first", () => {
		const first = createTeamStore("first");
		addTaskToBoard(first, "One", "", []);
		const archivedFirst = archiveTeam("first");
		expect(archivedFirst).toBeDefined();
		if (!archivedFirst) return;
		archivedFirst.archivedAt = 1;
		writeArchivedTeamToDisk(archivedFirst);

		const second = createTeamStore("second");
		addTaskToBoard(second, "Two", "", []);
		const archivedSecond = archiveTeam("second");
		expect(archivedSecond).toBeDefined();
		if (!archivedSecond) return;
		archivedSecond.archivedAt = 2;
		writeArchivedTeamToDisk(archivedSecond);

		const names = loadAllArchivedTeamsFromDisk().map((archive) => archive.name);
		expect(names).toEqual(["second", "first"]);
	});

	it("deletes persisted archives", () => {
		createTeamStore("gone");
		const archived = archiveTeam("gone");
		expect(archived).toBeDefined();
		if (!archived) return;
		writeArchivedTeamToDisk(archived);
		expect(loadArchivedTeamFromDisk("gone")?.name).toBe("gone");

		deleteArchivedTeamFromDisk("gone");

		expect(loadArchivedTeamFromDisk("gone")).toBeUndefined();
		expect(getTeamArchivesDir().startsWith(tmpHome)).toBe(true);
	});
});
