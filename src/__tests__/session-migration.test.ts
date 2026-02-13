import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSessionDirName, migrateSessionsToPerCwdDirs } from "../session-migration.js";

/**
 * Create a minimal session .jsonl file with a header line.
 *
 * @param dir - Directory to write the file in
 * @param filename - File name (should end in .jsonl)
 * @param cwd - Working directory to embed in the session header
 * @returns Full path to the created file
 */
function createSessionFile(dir: string, filename: string, cwd: string): string {
	const header = JSON.stringify({ type: "session", version: 3, id: "test-id", cwd });
	const message = JSON.stringify({ type: "message", id: "msg1", message: { role: "user" } });
	writeFileSync(join(dir, filename), `${header}\n${message}\n`);
	return join(dir, filename);
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
		`tallow-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

describe("encodeSessionDirName", () => {
	test("encodes Unix absolute path", () => {
		expect(encodeSessionDirName("/Users/kevin/dev/tallow")).toBe("--Users-kevin-dev-tallow--");
	});

	test("encodes path with colons (Windows-style)", () => {
		expect(encodeSessionDirName("C:\\Users\\kevin\\dev")).toBe("--C--Users-kevin-dev--");
	});

	test("handles root path", () => {
		expect(encodeSessionDirName("/")).toBe("----");
	});
});

describe("migrateSessionsToPerCwdDirs", () => {
	test("moves flat .jsonl files into per-cwd subdirectories", () => {
		const dir = makeTempDir();
		createSessionFile(dir, "session1.jsonl", "/Users/kevin/dev/tallow");
		createSessionFile(dir, "session2.jsonl", "/Users/kevin/dev/fuse");
		createSessionFile(dir, "session3.jsonl", "/Users/kevin/dev/tallow");

		const migrated = migrateSessionsToPerCwdDirs(dir);

		expect(migrated).toBe(3);

		// Flat files should be gone
		const remaining = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		expect(remaining).toHaveLength(0);

		// Per-cwd subdirs should exist with the right files
		const tallowDir = join(dir, "--Users-kevin-dev-tallow--");
		const fuseDir = join(dir, "--Users-kevin-dev-fuse--");

		expect(existsSync(tallowDir)).toBe(true);
		expect(existsSync(fuseDir)).toBe(true);
		expect(readdirSync(tallowDir)).toHaveLength(2);
		expect(readdirSync(fuseDir)).toHaveLength(1);
	});

	test("is idempotent — second run is a no-op", () => {
		const dir = makeTempDir();
		createSessionFile(dir, "session1.jsonl", "/Users/kevin/dev/tallow");

		const first = migrateSessionsToPerCwdDirs(dir);
		expect(first).toBe(1);

		const second = migrateSessionsToPerCwdDirs(dir);
		expect(second).toBe(0);
	});

	test("files with missing cwd go to --unknown--", () => {
		const dir = makeTempDir();
		// Header without cwd field
		writeFileSync(
			join(dir, "no-cwd.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "x" })}\n`
		);

		const migrated = migrateSessionsToPerCwdDirs(dir);

		expect(migrated).toBe(1);
		const unknownDir = join(dir, "--unknown--");
		expect(existsSync(unknownDir)).toBe(true);
		expect(readdirSync(unknownDir)).toContain("no-cwd.jsonl");
	});

	test("corrupt files go to --unknown--", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "corrupt.jsonl"), "not valid json at all\n");

		const migrated = migrateSessionsToPerCwdDirs(dir);

		expect(migrated).toBe(1);
		expect(readdirSync(join(dir, "--unknown--"))).toContain("corrupt.jsonl");
	});

	test("returns 0 for non-existent directory", () => {
		expect(migrateSessionsToPerCwdDirs(`/tmp/does-not-exist-${Date.now()}`)).toBe(0);
	});

	test("returns 0 for empty directory", () => {
		const dir = makeTempDir();
		expect(migrateSessionsToPerCwdDirs(dir)).toBe(0);
	});

	test("ignores existing subdirectories", () => {
		const dir = makeTempDir();
		// Create an existing per-cwd subdir with a session inside
		const subdir = join(dir, "--Users-kevin-dev-tallow--");
		mkdirSync(subdir);
		createSessionFile(subdir, "existing.jsonl", "/Users/kevin/dev/tallow");

		// Add a flat file for a different project
		createSessionFile(dir, "other.jsonl", "/Users/kevin/dev/fuse");

		const migrated = migrateSessionsToPerCwdDirs(dir);

		// Only the flat file should be migrated
		expect(migrated).toBe(1);
		// Existing subdir should still have its original file
		expect(readdirSync(subdir)).toContain("existing.jsonl");
		expect(readdirSync(subdir)).toHaveLength(1);
	});

	test("preserves file content after migration", () => {
		const dir = makeTempDir();
		const path = createSessionFile(dir, "session.jsonl", "/Users/kevin/dev/tallow");
		const originalContent = readFileSync(path, "utf-8");

		migrateSessionsToPerCwdDirs(dir);

		const migratedPath = join(dir, "--Users-kevin-dev-tallow--", "session.jsonl");
		expect(readFileSync(migratedPath, "utf-8")).toBe(originalContent);
	});
});
