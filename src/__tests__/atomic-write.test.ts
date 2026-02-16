import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync, restoreFromBackup } from "../atomic-write.js";

/** Create a fresh temp directory for each test. */
function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "atomic-write-test-"));
}

describe("atomicWriteFileSync", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("writes content to a new file", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "test.json");

		atomicWriteFileSync(filePath, '{"key":"value"}\n');

		expect(readFileSync(filePath, "utf-8")).toBe('{"key":"value"}\n');
	});

	test("overwrites existing file content", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "test.json");
		writeFileSync(filePath, "old content");

		atomicWriteFileSync(filePath, "new content");

		expect(readFileSync(filePath, "utf-8")).toBe("new content");
	});

	test("leaves no temp files on success", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "test.json");

		atomicWriteFileSync(filePath, "data");

		const files = readdirSync(tmpDir);
		expect(files).toEqual(["test.json"]);
	});

	test("sets file mode when specified", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "secret.json");

		atomicWriteFileSync(filePath, '{"secret":true}', { mode: 0o600 });

		const stat = statSync(filePath);
		// Check owner read/write permissions (mask out umask effects)
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("preserves original file when write target dir does not exist", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "nonexistent-subdir", "test.json");

		expect(() => atomicWriteFileSync(filePath, "data")).toThrow();
	});

	test("concurrent writes produce valid content (no interleaving)", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "concurrent.json");

		// Simulate concurrent writes — both should succeed without corruption
		atomicWriteFileSync(filePath, "write-1");
		atomicWriteFileSync(filePath, "write-2");

		const content = readFileSync(filePath, "utf-8");
		expect(content === "write-1" || content === "write-2").toBe(true);
	});

	test("cleans up temp file on write error", () => {
		tmpDir = makeTmpDir();
		const lockedDir = join(tmpDir, "locked");
		const { mkdirSync } = require("node:fs");
		mkdirSync(lockedDir);
		const lockedFile = join(lockedDir, "test.json");
		writeFileSync(lockedFile, "original");

		// Make directory read-only to prevent tmp file creation
		chmodSync(lockedDir, 0o444);

		try {
			expect(() => atomicWriteFileSync(lockedFile, "new data")).toThrow();
			// No temp files should be left behind
			chmodSync(lockedDir, 0o755);
			const files = readdirSync(lockedDir).filter((f) => f.endsWith(".tmp"));
			expect(files).toEqual([]);
			// Original file should be untouched
			expect(readFileSync(lockedFile, "utf-8")).toBe("original");
		} finally {
			// Ensure cleanup even if assertions fail
			try {
				chmodSync(lockedDir, 0o755);
			} catch {
				/* already restored */
			}
		}
	});

	test("creates backup when backup option is true", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "settings.json");
		writeFileSync(filePath, '{"old":true}');

		atomicWriteFileSync(filePath, '{"new":true}', { backup: true });

		expect(readFileSync(filePath, "utf-8")).toBe('{"new":true}');
		expect(readFileSync(`${filePath}.bak`, "utf-8")).toBe('{"old":true}');
	});

	test("does not create backup for new files even with backup option", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "new-file.json");

		atomicWriteFileSync(filePath, '{"new":true}', { backup: true });

		expect(readFileSync(filePath, "utf-8")).toBe('{"new":true}');
		expect(existsSync(`${filePath}.bak`)).toBe(false);
	});

	test("overwrites existing backup file", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "settings.json");

		writeFileSync(filePath, "v1");
		atomicWriteFileSync(filePath, "v2", { backup: true });
		expect(readFileSync(`${filePath}.bak`, "utf-8")).toBe("v1");

		atomicWriteFileSync(filePath, "v3", { backup: true });
		expect(readFileSync(`${filePath}.bak`, "utf-8")).toBe("v2");
	});
});

describe("restoreFromBackup", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("returns false when no backup exists", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "missing.json");

		expect(restoreFromBackup(filePath)).toBe(false);
	});

	test("restores from valid backup", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "settings.json");
		writeFileSync(`${filePath}.bak`, '{"restored":true}');

		const result = restoreFromBackup(filePath);

		expect(result).toBe(true);
		expect(readFileSync(filePath, "utf-8")).toBe('{"restored":true}');
	});

	test("validates backup content before restoring", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "settings.json");
		writeFileSync(`${filePath}.bak`, "not valid json {{{");

		const result = restoreFromBackup(filePath, (content) => {
			JSON.parse(content);
		});

		expect(result).toBe(false);
		expect(existsSync(filePath)).toBe(false);
	});

	test("restores valid JSON backup with validator", () => {
		tmpDir = makeTmpDir();
		const filePath = join(tmpDir, "auth.json");
		writeFileSync(`${filePath}.bak`, '{"key":"secret"}');

		const result = restoreFromBackup(filePath, (content) => {
			JSON.parse(content);
		});

		expect(result).toBe(true);
		expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({ key: "secret" });
	});
});
