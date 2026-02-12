import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getNonCollidingSkillPaths } from "../index.js";

describe("getNonCollidingSkillPaths", () => {
	let tmpDir: string;
	let claudeSkillsDir: string;
	let tallowSkillsDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-test-"));
		claudeSkillsDir = path.join(tmpDir, "claude-skills");
		tallowSkillsDir = path.join(tmpDir, "tallow-skills");
		fs.mkdirSync(claudeSkillsDir, { recursive: true });
		fs.mkdirSync(tallowSkillsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should skip skills that exist in tallow skills dir", () => {
		// Both dirs have "database" skill
		fs.mkdirSync(path.join(claudeSkillsDir, "database"));
		fs.mkdirSync(path.join(tallowSkillsDir, "database"));

		const result = getNonCollidingSkillPaths(claudeSkillsDir, tallowSkillsDir);
		expect(result).toEqual([]);
	});

	it("should include skills not present in tallow skills dir", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, "unique-skill"));

		const result = getNonCollidingSkillPaths(claudeSkillsDir, tallowSkillsDir);
		expect(result).toEqual([path.join(claudeSkillsDir, "unique-skill")]);
	});

	it("should return individual subdirectory paths, not parent", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, "skill-a"));
		fs.mkdirSync(path.join(claudeSkillsDir, "skill-b"));

		const result = getNonCollidingSkillPaths(claudeSkillsDir, tallowSkillsDir);
		expect(result).toEqual([
			path.join(claudeSkillsDir, "skill-a"),
			path.join(claudeSkillsDir, "skill-b"),
		]);
	});

	it("should filter mixed colliding and non-colliding skills", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, "database"));
		fs.mkdirSync(path.join(claudeSkillsDir, "custom-tool"));
		fs.mkdirSync(path.join(tallowSkillsDir, "database"));

		const result = getNonCollidingSkillPaths(claudeSkillsDir, tallowSkillsDir);
		expect(result).toEqual([path.join(claudeSkillsDir, "custom-tool")]);
	});

	it("should handle empty directories", () => {
		const result = getNonCollidingSkillPaths(claudeSkillsDir, tallowSkillsDir);
		expect(result).toEqual([]);
	});

	it("should skip dot-prefixed entries", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, ".hidden"));
		fs.mkdirSync(path.join(claudeSkillsDir, "visible"));

		const result = getNonCollidingSkillPaths(claudeSkillsDir, tallowSkillsDir);
		expect(result).toEqual([path.join(claudeSkillsDir, "visible")]);
	});

	it("should skip files (non-directories)", () => {
		fs.writeFileSync(path.join(claudeSkillsDir, "readme.md"), "");
		fs.mkdirSync(path.join(claudeSkillsDir, "real-skill"));

		const result = getNonCollidingSkillPaths(claudeSkillsDir, tallowSkillsDir);
		expect(result).toEqual([path.join(claudeSkillsDir, "real-skill")]);
	});

	it("should return empty array if claude skills dir doesn't exist", () => {
		const result = getNonCollidingSkillPaths("/nonexistent/path", tallowSkillsDir);
		expect(result).toEqual([]);
	});
});
