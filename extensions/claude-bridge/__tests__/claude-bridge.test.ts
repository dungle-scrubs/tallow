import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectKnownSkillNames, getNonCollidingSkillPaths } from "../index.js";

describe("getNonCollidingSkillPaths", () => {
	let tmpDir: string;
	let claudeSkillsDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-test-"));
		claudeSkillsDir = path.join(tmpDir, "claude-skills");
		fs.mkdirSync(claudeSkillsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should skip skills whose names are in the known set", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, "database"));
		fs.writeFileSync(
			path.join(claudeSkillsDir, "database", "SKILL.md"),
			"---\ndescription: db\n---\n"
		);

		const result = getNonCollidingSkillPaths(claudeSkillsDir, new Set(["database"]));
		expect(result).toEqual([]);
	});

	it("should include skills not in the known set", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, "unique-skill"));
		fs.writeFileSync(
			path.join(claudeSkillsDir, "unique-skill", "SKILL.md"),
			"---\ndescription: u\n---\n"
		);

		const result = getNonCollidingSkillPaths(claudeSkillsDir, new Set());
		expect(result).toEqual([path.join(claudeSkillsDir, "unique-skill", "SKILL.md")]);
	});

	it("should return SKILL.md file paths when available", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, "skill-a"));
		fs.writeFileSync(
			path.join(claudeSkillsDir, "skill-a", "SKILL.md"),
			"---\ndescription: a\n---\n"
		);
		fs.mkdirSync(path.join(claudeSkillsDir, "skill-b"));
		fs.writeFileSync(
			path.join(claudeSkillsDir, "skill-b", "SKILL.md"),
			"---\ndescription: b\n---\n"
		);

		const result = getNonCollidingSkillPaths(claudeSkillsDir, new Set());
		expect(result).toEqual([
			path.join(claudeSkillsDir, "skill-a", "SKILL.md"),
			path.join(claudeSkillsDir, "skill-b", "SKILL.md"),
		]);
	});

	it("should fall back to directory path when no SKILL.md exists", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, "no-skill-md"));

		const result = getNonCollidingSkillPaths(claudeSkillsDir, new Set());
		expect(result).toEqual([path.join(claudeSkillsDir, "no-skill-md")]);
	});

	it("should not pick up auxiliary .md files when returning SKILL.md paths", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, "database"));
		fs.writeFileSync(
			path.join(claudeSkillsDir, "database", "SKILL.md"),
			"---\ndescription: db\n---\n"
		);
		fs.writeFileSync(path.join(claudeSkillsDir, "database", "reference.md"), "# Reference\n");

		const result = getNonCollidingSkillPaths(claudeSkillsDir, new Set());
		// Returns the SKILL.md file, not the directory — so reference.md is never loaded
		expect(result).toEqual([path.join(claudeSkillsDir, "database", "SKILL.md")]);
	});

	it("should filter mixed colliding and non-colliding skills", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, "database"));
		fs.writeFileSync(
			path.join(claudeSkillsDir, "database", "SKILL.md"),
			"---\ndescription: db\n---\n"
		);
		fs.mkdirSync(path.join(claudeSkillsDir, "custom-tool"));
		fs.writeFileSync(
			path.join(claudeSkillsDir, "custom-tool", "SKILL.md"),
			"---\ndescription: ct\n---\n"
		);

		const result = getNonCollidingSkillPaths(claudeSkillsDir, new Set(["database"]));
		expect(result).toEqual([path.join(claudeSkillsDir, "custom-tool", "SKILL.md")]);
	});

	it("should handle empty directories", () => {
		const result = getNonCollidingSkillPaths(claudeSkillsDir, new Set());
		expect(result).toEqual([]);
	});

	it("should skip dot-prefixed entries", () => {
		fs.mkdirSync(path.join(claudeSkillsDir, ".hidden"));
		fs.mkdirSync(path.join(claudeSkillsDir, "visible"));
		fs.writeFileSync(
			path.join(claudeSkillsDir, "visible", "SKILL.md"),
			"---\ndescription: v\n---\n"
		);

		const result = getNonCollidingSkillPaths(claudeSkillsDir, new Set());
		expect(result).toEqual([path.join(claudeSkillsDir, "visible", "SKILL.md")]);
	});

	it("should skip files (non-directories)", () => {
		fs.writeFileSync(path.join(claudeSkillsDir, "readme.md"), "");
		fs.mkdirSync(path.join(claudeSkillsDir, "real-skill"));
		fs.writeFileSync(
			path.join(claudeSkillsDir, "real-skill", "SKILL.md"),
			"---\ndescription: rs\n---\n"
		);

		const result = getNonCollidingSkillPaths(claudeSkillsDir, new Set());
		expect(result).toEqual([path.join(claudeSkillsDir, "real-skill", "SKILL.md")]);
	});

	it("should return empty array if claude skills dir doesn't exist", () => {
		const result = getNonCollidingSkillPaths("/nonexistent/path", new Set());
		expect(result).toEqual([]);
	});
});

describe("collectKnownSkillNames", () => {
	let tmpDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-known-"));
		agentDir = path.join(tmpDir, "agent");
		cwd = path.join(tmpDir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should find skills in agent dir", () => {
		fs.mkdirSync(path.join(agentDir, "skills", "my-skill"), { recursive: true });

		const names = collectKnownSkillNames(agentDir, cwd);
		expect(names.has("my-skill")).toBe(true);
	});

	it("should find skills in project .tallow/skills/", () => {
		fs.mkdirSync(path.join(cwd, ".tallow", "skills", "project-skill"), { recursive: true });

		const names = collectKnownSkillNames(agentDir, cwd);
		expect(names.has("project-skill")).toBe(true);
	});

	it("should find skills in project .pi/skills/ (legacy)", () => {
		fs.mkdirSync(path.join(cwd, ".pi", "skills", "legacy-skill"), { recursive: true });

		const names = collectKnownSkillNames(agentDir, cwd);
		expect(names.has("legacy-skill")).toBe(true);
	});

	it("should find skills from packages in agent settings", () => {
		const pkgDir = path.join(tmpDir, "my-package");
		fs.mkdirSync(path.join(pkgDir, "skills", "pkg-skill"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [pkgDir] }));

		const names = collectKnownSkillNames(agentDir, cwd);
		expect(names.has("pkg-skill")).toBe(true);
	});

	it("should find skills from packages in project settings", () => {
		const pkgDir = path.join(tmpDir, "project-package");
		fs.mkdirSync(path.join(pkgDir, "skills", "proj-pkg-skill"), { recursive: true });
		fs.mkdirSync(path.join(cwd, ".tallow"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".tallow", "settings.json"),
			JSON.stringify({ packages: [pkgDir] })
		);

		const names = collectKnownSkillNames(agentDir, cwd);
		expect(names.has("proj-pkg-skill")).toBe(true);
	});

	it("should handle missing settings files gracefully", () => {
		const names = collectKnownSkillNames(agentDir, cwd);
		expect(names.size).toBe(0);
	});

	it("should deduplicate across sources", () => {
		fs.mkdirSync(path.join(agentDir, "skills", "shared"), { recursive: true });
		fs.mkdirSync(path.join(cwd, ".tallow", "skills", "shared"), { recursive: true });

		const names = collectKnownSkillNames(agentDir, cwd);
		expect(names.has("shared")).toBe(true);
		expect(names.size).toBe(1);
	});
});
