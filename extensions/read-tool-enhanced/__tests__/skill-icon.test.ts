import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_SKILL_ICON, readSkillIcon } from "../index.js";

describe("readSkillIcon", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-icon-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Write a SKILL.md with the given frontmatter content. */
	function writeSkill(frontmatter: string, body = "# Skill"): string {
		const filePath = path.join(tmpDir, "SKILL.md");
		fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}`);
		return filePath;
	}

	it("returns custom icon from frontmatter", () => {
		const fp = writeSkill('name: test\nicon: "🎯"\ndescription: test');
		expect(readSkillIcon(fp)).toBe("🎯");
	});

	it("returns default icon when icon field is missing", () => {
		const fp = writeSkill("name: test\ndescription: test");
		expect(readSkillIcon(fp)).toBe(DEFAULT_SKILL_ICON);
	});

	it("returns default icon when icon field is empty string", () => {
		const fp = writeSkill('name: test\nicon: ""\ndescription: test');
		expect(readSkillIcon(fp)).toBe(DEFAULT_SKILL_ICON);
	});

	it("returns default icon when file does not exist", () => {
		expect(readSkillIcon("/nonexistent/SKILL.md")).toBe(DEFAULT_SKILL_ICON);
	});

	it("handles non-emoji icon values", () => {
		const fp = writeSkill("name: test\nicon: star\ndescription: test");
		expect(readSkillIcon(fp)).toBe("star");
	});

	it("handles multi-codepoint emoji", () => {
		const fp = writeSkill('name: test\nicon: "🏗️"\ndescription: test');
		expect(readSkillIcon(fp)).toBe("🏗️");
	});
});
