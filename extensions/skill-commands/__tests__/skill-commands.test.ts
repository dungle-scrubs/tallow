import { describe, expect, it } from "bun:test";
import { resolveCommandName } from "../index.js";

describe("resolveCommandName", () => {
	it("should return valid name unchanged", () => {
		const result = resolveCommandName({
			name: "my-skill",
			filePath: "/a/my-skill/SKILL.md",
		});
		expect(result).toBe("my-skill");
	});

	it("should accept names with numbers", () => {
		const result = resolveCommandName({
			name: "skill-v2",
			filePath: "/a/skill-v2/SKILL.md",
		});
		expect(result).toBe("skill-v2");
	});

	it("should fall back to directory name when frontmatter name has spaces and parens", () => {
		const result = resolveCommandName({
			name: "code-simplifier (Python Expert)",
			filePath: "/a/code-simplifier/SKILL.md",
		});
		expect(result).toBe("code-simplifier");
	});

	it("should fall back to directory name when frontmatter name has uppercase", () => {
		const result = resolveCommandName({
			name: "MySkill",
			filePath: "/a/my-skill/SKILL.md",
		});
		expect(result).toBe("my-skill");
	});

	it("should fall back to directory name when frontmatter name has spaces", () => {
		const result = resolveCommandName({
			name: "code simplifier",
			filePath: "/a/code-simplifier/SKILL.md",
		});
		expect(result).toBe("code-simplifier");
	});

	it("should return null when both name and directory are invalid", () => {
		const result = resolveCommandName({
			name: "Bad Name!",
			filePath: "/a/Bad Name!/SKILL.md",
		});
		expect(result).toBeNull();
	});

	it("should fall back to directory name when frontmatter has special chars", () => {
		const result = resolveCommandName({
			name: "skill@v2.0",
			filePath: "/a/skill-v2/SKILL.md",
		});
		expect(result).toBe("skill-v2");
	});

	it("should handle deeply nested file paths", () => {
		const result = resolveCommandName({
			name: "Invalid Name",
			filePath: "/home/user/.claude/skills/valid-name/SKILL.md",
		});
		expect(result).toBe("valid-name");
	});
});
