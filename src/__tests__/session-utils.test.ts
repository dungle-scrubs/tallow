import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSessionDirName } from "../session-migration.js";

// We can't import from session-utils directly because it reads TALLOW_HOME
// at module scope. Instead, test the core logic by reimplementing the lookup
// against the same file format. For integration, we test via the CLI.
//
// However, we CAN test the functions if we set the env var before import.
// But TALLOW_HOME is resolved at import time in config.ts. So we test the
// pure logic functions here and integration via CLI E2E.

/**
 * Create a minimal session .jsonl file following the naming convention.
 *
 * @param dir - Session subdirectory
 * @param sessionId - ID to embed in header and filename
 * @param cwd - Working directory for the session header
 * @returns Full path to the created file
 */
function createSessionFile(dir: string, sessionId: string, cwd: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filename = `${timestamp}_${sessionId}.jsonl`;
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd,
	});
	const filePath = join(dir, filename);
	writeFileSync(filePath, `${header}\n`);
	return filePath;
}

/**
 * Create a session file with a non-standard filename (ID only in header).
 *
 * @param dir - Session subdirectory
 * @param filename - Custom filename
 * @param sessionId - ID to embed in header only
 * @param cwd - Working directory
 * @returns Full path to the created file
 */
function createSessionFileCustomName(
	dir: string,
	filename: string,
	sessionId: string,
	cwd: string
): string {
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd,
	});
	const filePath = join(dir, filename);
	writeFileSync(filePath, `${header}\n`);
	return filePath;
}

let tempDir: string;

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

/**
 * Create a fresh temp directory for a test.
 *
 * @returns Path to the temp directory
 */
function makeTempDir(): string {
	tempDir = join(
		tmpdir(),
		`tallow-session-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

/**
 * Reimplementation of findSessionById for testing without TALLOW_HOME dependency.
 * Mirrors src/session-utils.ts logic.
 *
 * @param sessionId - The session ID to find
 * @param sessionsDir - Absolute path to the per-cwd session directory
 * @returns Path to the session file, or null if not found
 */
function findSessionByIdInDir(sessionId: string, sessionsDir: string): string | null {
	if (!existsSync(sessionsDir)) return null;

	const { readdirSync } = require("node:fs");
	let files: string[];
	try {
		files = readdirSync(sessionsDir).filter((f: string) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}

	// Fast path: filename suffix
	const suffixMatch = files.find((f: string) => f.endsWith(`_${sessionId}.jsonl`));
	if (suffixMatch) return join(sessionsDir, suffixMatch);

	// Slow path: header parse
	for (const file of files) {
		const filePath = join(sessionsDir, file);
		try {
			const content = readFileSync(filePath, "utf-8");
			const firstNewline = content.indexOf("\n");
			const headerLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
			const header = JSON.parse(headerLine);
			if (header.type === "session" && header.id === sessionId) {
				return filePath;
			}
		} catch {
			// Skip corrupt files
		}
	}

	return null;
}

describe("findSessionById (logic)", () => {
	test("finds session by filename suffix", () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "--Users-kevin-dev-test--");
		mkdirSync(sessionsDir, { recursive: true });

		const created = createSessionFile(sessionsDir, "my-ci-run-1", "/Users/kevin/dev/test");

		const found = findSessionByIdInDir("my-ci-run-1", sessionsDir);
		expect(found).toBe(created);
	});

	test("finds session by header parse when filename doesn't match convention", () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "--Users-kevin-dev-test--");
		mkdirSync(sessionsDir, { recursive: true });

		const created = createSessionFileCustomName(
			sessionsDir,
			"unusual-name.jsonl",
			"hidden-id-42",
			"/Users/kevin/dev/test"
		);

		const found = findSessionByIdInDir("hidden-id-42", sessionsDir);
		expect(found).toBe(created);
	});

	test("returns null when session doesn't exist", () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "--Users-kevin-dev-test--");
		mkdirSync(sessionsDir, { recursive: true });

		createSessionFile(sessionsDir, "other-session", "/Users/kevin/dev/test");

		const found = findSessionByIdInDir("nonexistent-id", sessionsDir);
		expect(found).toBeNull();
	});

	test("returns null for non-existent directory", () => {
		const found = findSessionByIdInDir("any-id", `/tmp/does-not-exist-${Date.now()}`);
		expect(found).toBeNull();
	});

	test("skips corrupt files gracefully", () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "--Users-kevin-dev-test--");
		mkdirSync(sessionsDir, { recursive: true });

		// Corrupt file
		writeFileSync(join(sessionsDir, "corrupt.jsonl"), "not json at all\n");

		// Valid file
		const created = createSessionFile(sessionsDir, "valid-session", "/Users/kevin/dev/test");

		const found = findSessionByIdInDir("valid-session", sessionsDir);
		expect(found).toBe(created);
	});

	test("prefers filename suffix match over header parse", () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "--Users-kevin-dev-test--");
		mkdirSync(sessionsDir, { recursive: true });

		// Create two files with the same ID — one with convention naming, one without
		const conventional = createSessionFile(sessionsDir, "target-id", "/Users/kevin/dev/test");
		createSessionFileCustomName(
			sessionsDir,
			"weird-name.jsonl",
			"target-id",
			"/Users/kevin/dev/test"
		);

		const found = findSessionByIdInDir("target-id", sessionsDir);
		// Should find the conventional one (suffix match is faster)
		expect(found).toBe(conventional);
	});
});

describe("session file format", () => {
	test("created files have valid JSON header", () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "--test--");
		mkdirSync(sessionsDir);

		const filePath = createSessionFile(sessionsDir, "test-id", "/test");
		const content = readFileSync(filePath, "utf-8");
		const header = JSON.parse(content.split("\n")[0]);

		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		expect(header.id).toBe("test-id");
		expect(header.cwd).toBe("/test");
		expect(typeof header.timestamp).toBe("string");
	});

	test("filename follows timestamp_id.jsonl convention", () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "--test--");
		mkdirSync(sessionsDir);

		const filePath = createSessionFile(sessionsDir, "my-session", "/test");
		const filename = filePath.split("/").pop() ?? "";

		expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T.*_my-session\.jsonl$/);
	});
});

describe("encodeSessionDirName (used by session lookup)", () => {
	test("produces deterministic encoding for same cwd", () => {
		const a = encodeSessionDirName("/Users/kevin/dev/project");
		const b = encodeSessionDirName("/Users/kevin/dev/project");
		expect(a).toBe(b);
	});

	test("different cwds produce different encodings", () => {
		const a = encodeSessionDirName("/Users/kevin/dev/project-a");
		const b = encodeSessionDirName("/Users/kevin/dev/project-b");
		expect(a).not.toBe(b);
	});
});
