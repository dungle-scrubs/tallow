import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionWithId, findSessionById } from "../session-utils.js";

let cwd = "";
let tallowHome = "";
let originalTallowHome: string | undefined;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "session-utils-cwd-"));
	tallowHome = mkdtempSync(join(tmpdir(), "session-utils-home-"));
	originalTallowHome = process.env.TALLOW_HOME;
	process.env.TALLOW_HOME = tallowHome;
});

afterEach(() => {
	if (originalTallowHome === undefined) {
		delete process.env.TALLOW_HOME;
	} else {
		process.env.TALLOW_HOME = originalTallowHome;
	}
	rmSync(cwd, { force: true, recursive: true });
	rmSync(tallowHome, { force: true, recursive: true });
});

describe("session-utils runtime TALLOW_HOME", () => {
	test("uses the current TALLOW_HOME env override at call time", () => {
		const sessionManager = createSessionWithId("runtime-home", cwd);
		const sessionPath = findSessionById("runtime-home", cwd);

		expect(sessionManager.getSessionId()).toBe("runtime-home");
		expect(sessionPath).toContain(tallowHome);
		expect(sessionPath).toContain("sessions");
	});
});
