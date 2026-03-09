import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSharedSkillsDirs } from "../sdk.js";

/**
 * Create a temporary directory for test fixtures.
 *
 * @returns Path to the newly created temp directory
 */
function createTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "shared-skills-test-"));
}

describe("resolveSharedSkillsDirs", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = createTmpDir();
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	test("returns empty array when no settings provided", () => {
		expect(resolveSharedSkillsDirs(undefined)).toEqual([]);
	});

	test("returns empty array when sharedSkillsDirs is not present", () => {
		expect(resolveSharedSkillsDirs({})).toEqual([]);
		expect(resolveSharedSkillsDirs({ theme: "nord" })).toEqual([]);
	});

	test("returns empty array when sharedSkillsDirs is not an array", () => {
		expect(resolveSharedSkillsDirs({ sharedSkillsDirs: "~/.skills" })).toEqual([]);
		expect(resolveSharedSkillsDirs({ sharedSkillsDirs: 42 })).toEqual([]);
		expect(resolveSharedSkillsDirs({ sharedSkillsDirs: null })).toEqual([]);
		expect(resolveSharedSkillsDirs({ sharedSkillsDirs: true })).toEqual([]);
	});

	test("resolves absolute paths that exist as directories", () => {
		const skillsDir = join(tmp, "my-skills");
		mkdirSync(skillsDir);

		const result = resolveSharedSkillsDirs({ sharedSkillsDirs: [skillsDir] });
		expect(result).toEqual([skillsDir]);
	});

	test("skips non-existent directories silently", () => {
		const result = resolveSharedSkillsDirs({
			sharedSkillsDirs: [join(tmp, "does-not-exist")],
		});
		expect(result).toEqual([]);
	});

	test("skips paths that exist but are files, not directories", () => {
		const filePath = join(tmp, "not-a-dir");
		writeFileSync(filePath, "hello");

		const result = resolveSharedSkillsDirs({ sharedSkillsDirs: [filePath] });
		expect(result).toEqual([]);
	});

	test("rejects relative paths", () => {
		const result = resolveSharedSkillsDirs({
			sharedSkillsDirs: ["relative/path", "./also-relative", "no-slash"],
		});
		expect(result).toEqual([]);
	});

	test("rejects non-string entries", () => {
		const result = resolveSharedSkillsDirs({
			sharedSkillsDirs: [42, null, undefined, true, {}],
		});
		expect(result).toEqual([]);
	});

	test("rejects empty string entries", () => {
		const result = resolveSharedSkillsDirs({
			sharedSkillsDirs: ["", "  "],
		});
		expect(result).toEqual([]);
	});

	test("handles mixed valid and invalid entries", () => {
		const validDir = join(tmp, "valid-skills");
		mkdirSync(validDir);

		const result = resolveSharedSkillsDirs({
			sharedSkillsDirs: [
				validDir,
				"relative/path",
				join(tmp, "nonexistent"),
				42 as unknown as string,
				validDir, // duplicate — should appear twice (dedup is not this function's job)
			],
		});
		expect(result).toEqual([validDir, validDir]);
	});

	test("handles tilde expansion for ~/path", () => {
		// We can't easily test ~ expansion without mocking homedir,
		// but we can verify the function doesn't crash on ~ paths
		// and correctly rejects them when the path doesn't exist.
		const result = resolveSharedSkillsDirs({
			sharedSkillsDirs: ["~/.skills-nonexistent-test-dir-12345"],
		});
		expect(result).toEqual([]);
	});

	test("returns empty array for empty sharedSkillsDirs array", () => {
		expect(resolveSharedSkillsDirs({ sharedSkillsDirs: [] })).toEqual([]);
	});
});
