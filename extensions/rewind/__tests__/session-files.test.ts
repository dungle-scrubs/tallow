import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLiveSessionIdsForCwd } from "../session-files.js";

/**
 * Encode a cwd into the session directory name used by tallow.
 *
 * @param cwd - Absolute working directory path
 * @returns Encoded directory name
 */
function encodeSessionDirName(cwd: string): string {
	const withoutLeadingSlash = cwd.startsWith("/") || cwd.startsWith("\\") ? cwd.slice(1) : cwd;
	const safeName = withoutLeadingSlash
		.replaceAll("/", "-")
		.replaceAll("\\", "-")
		.replaceAll(":", "-");
	return `--${safeName}--`;
}

/**
 * Create a minimal JSONL session file for a test home/cwd pair.
 *
 * @param homeDir - Tallow home directory
 * @param cwd - Session working directory
 * @param sessionId - Session id to persist in the header
 * @param fileName - Session filename to create
 * @returns Absolute path to the created session file
 */
function createSessionFile(
	homeDir: string,
	cwd: string,
	sessionId: string,
	fileName: string
): string {
	const sessionDir = join(homeDir, "sessions", encodeSessionDirName(cwd));
	mkdirSync(sessionDir, { recursive: true });
	const filePath = join(sessionDir, fileName);
	writeFileSync(
		filePath,
		`${JSON.stringify({ cwd, id: sessionId, timestamp: new Date().toISOString(), type: "session", version: 3 })}\n`
	);
	return filePath;
}

describe("listLiveSessionIdsForCwd", () => {
	const originalHome = process.env.HOME;
	const originalTallowHome = process.env.TALLOW_CODING_AGENT_DIR;
	const originalPiHome = process.env.PI_CODING_AGENT_DIR;
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "rewind-session-files-"));
		process.env.HOME = tmpRoot;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.TALLOW_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}

		if (originalTallowHome === undefined) {
			delete process.env.TALLOW_CODING_AGENT_DIR;
		} else {
			process.env.TALLOW_CODING_AGENT_DIR = originalTallowHome;
		}

		if (originalPiHome === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalPiHome;
		}

		rmSync(tmpRoot, { force: true, recursive: true });
	});

	it("finds live session ids across the default and active tallow homes", () => {
		const cwd = "/Users/kevin/dev/tallow";
		const defaultHome = join(tmpRoot, ".tallow");
		const activeHome = join(tmpRoot, ".tallow-project");
		process.env.TALLOW_CODING_AGENT_DIR = activeHome;

		createSessionFile(defaultHome, cwd, "default-session", "2026-04-20_default-session.jsonl");
		createSessionFile(activeHome, cwd, "active-session", "2026-04-20_active-session.jsonl");
		createSessionFile(
			activeHome,
			"/Users/kevin/dev/other",
			"other-project",
			"2026-04-20_other.jsonl"
		);

		const ids = listLiveSessionIdsForCwd(cwd, [defaultHome, activeHome]);
		expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual([
			"active-session",
			"default-session",
		]);
	});

	it("ignores unreadable or corrupt session files", () => {
		const cwd = "/Users/kevin/dev/tallow";
		const defaultHome = join(tmpRoot, ".tallow");
		const sessionDir = join(defaultHome, "sessions", encodeSessionDirName(cwd));
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "corrupt.jsonl"), "not-json\n");
		createSessionFile(defaultHome, cwd, "valid-session", "2026-04-20_valid-session.jsonl");

		const ids = listLiveSessionIdsForCwd(cwd, [defaultHome]);
		expect([...ids]).toEqual(["valid-session"]);
	});
});
