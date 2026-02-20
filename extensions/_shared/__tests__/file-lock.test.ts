import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock } from "../file-lock.js";

const testDirs: string[] = [];

/**
 * Create a unique temp directory for a test case.
 *
 * @returns Absolute temp directory path
 */
function makeTestDir(): string {
	const dir = join(tmpdir(), `file-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	testDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (testDirs.length > 0) {
		const dir = testDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("file lock utility", () => {
	test("acquires and releases lock files", () => {
		const dir = makeTestDir();
		const lockPath = join(dir, "state.json.lock");

		const release = acquireFileLock(lockPath);
		expect(existsSync(lockPath)).toBe(true);

		release();
		expect(existsSync(lockPath)).toBe(false);
	});

	test("preserves active lock file when acquisition times out", () => {
		const dir = makeTestDir();
		const lockPath = join(dir, "state.json.lock");

		const release = acquireFileLock(lockPath, {
			maxRetries: 2,
			retryBaseMs: 1,
			retryJitterMs: 1,
		});

		expect(() =>
			acquireFileLock(lockPath, {
				maxRetries: 2,
				retryBaseMs: 1,
				retryJitterMs: 1,
			})
		).toThrow("busy");
		expect(existsSync(lockPath)).toBe(true);

		release();
	});

	test("reclaims stale lock files when staleMs is configured", () => {
		const dir = makeTestDir();
		const lockPath = join(dir, "state.json.lock");
		writeFileSync(lockPath, "stale");

		const staleDate = new Date(Date.now() - 30_000);
		utimesSync(lockPath, staleDate, staleDate);

		const release = acquireFileLock(lockPath, {
			maxRetries: 2,
			retryBaseMs: 1,
			retryJitterMs: 1,
			staleMs: 1_000,
		});
		expect(existsSync(lockPath)).toBe(true);

		release();
		expect(existsSync(lockPath)).toBe(false);
	});
});
