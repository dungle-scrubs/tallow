import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSharedSkillsDirsFromSettings } from "../index.js";

/**
 * Create a temporary directory for test fixtures.
 *
 * @returns Path to the newly created temp directory
 */
function createTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "skill-cmds-shared-"));
}

/**
 * Write a settings.json file with the given content.
 *
 * @param dir - Directory to write settings.json into
 * @param settings - Settings object to serialize
 * @returns Path to the written settings.json
 */
function writeSettings(dir: string, settings: Record<string, unknown>): string {
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify(settings, null, 2));
	return path;
}

describe("resolveSharedSkillsDirsFromSettings", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = createTmpDir();
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty array when settings file does not exist", () => {
		expect(resolveSharedSkillsDirsFromSettings(join(tmp, "nope.json"))).toEqual([]);
	});

	it("returns empty array when settings file is invalid JSON", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(path, "not json {{");
		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([]);
	});

	it("returns empty array when sharedSkillsDirs is missing", () => {
		const path = writeSettings(tmp, { theme: "nord" });
		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([]);
	});

	it("returns empty array when sharedSkillsDirs is not an array", () => {
		const path = writeSettings(tmp, { sharedSkillsDirs: "/some/path" });
		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([]);
	});

	it("resolves absolute paths that exist as directories", () => {
		const skillsDir = join(tmp, "my-skills");
		mkdirSync(skillsDir);
		const path = writeSettings(tmp, { sharedSkillsDirs: [skillsDir] });

		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([skillsDir]);
	});

	it("skips non-existent directories silently", () => {
		const path = writeSettings(tmp, {
			sharedSkillsDirs: [join(tmp, "does-not-exist")],
		});
		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([]);
	});

	it("skips paths that are files, not directories", () => {
		const filePath = join(tmp, "not-a-dir");
		writeFileSync(filePath, "hello");
		const path = writeSettings(tmp, { sharedSkillsDirs: [filePath] });

		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([]);
	});

	it("rejects relative paths", () => {
		const path = writeSettings(tmp, {
			sharedSkillsDirs: ["relative/path", "./also-relative", "no-slash"],
		});
		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([]);
	});

	it("rejects non-string and empty entries", () => {
		const path = writeSettings(tmp, {
			sharedSkillsDirs: [42, null, "", "  ", true],
		});
		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([]);
	});

	it("handles mixed valid and invalid entries", () => {
		const validDir = join(tmp, "valid");
		mkdirSync(validDir);
		const path = writeSettings(tmp, {
			sharedSkillsDirs: [validDir, "relative", join(tmp, "nonexistent"), 42],
		});

		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([validDir]);
	});

	it("expands tilde paths (skips when dir does not exist)", () => {
		const path = writeSettings(tmp, {
			sharedSkillsDirs: ["~/.nonexistent-skills-test-dir-99999"],
		});
		expect(resolveSharedSkillsDirsFromSettings(path)).toEqual([]);
	});
});
