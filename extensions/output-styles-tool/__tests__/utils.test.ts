import { describe, expect, test } from "bun:test";
import {
	buildReminderContent,
	buildStyledPrompt,
	type OutputStyle,
	parseFrontmatterBlock,
	parseStyleFile,
	shouldRemind,
} from "../utils.js";

// ── parseFrontmatterBlock ───────────────────────────

describe("parseFrontmatterBlock", () => {
	test("parses simple key-value pairs", () => {
		const result = parseFrontmatterBlock("name: Reviewer\ndescription: Reviews code");
		expect(result).toEqual({ name: "Reviewer", description: "Reviews code" });
	});

	test("handles values with colons", () => {
		const result = parseFrontmatterBlock("description: time: 5pm meeting");
		expect(result.description).toBe("time: 5pm meeting");
	});

	test("trims whitespace from keys and values", () => {
		const result = parseFrontmatterBlock("  name  :  Spaced Out  ");
		expect(result.name).toBe("Spaced Out");
	});

	test("skips lines without colons", () => {
		const result = parseFrontmatterBlock("name: Test\nno-colon-here\nkey: val");
		expect(result).toEqual({ name: "Test", key: "val" });
	});

	test("skips empty keys", () => {
		const result = parseFrontmatterBlock(": empty-key\nname: Valid");
		expect(result).toEqual({ name: "Valid" });
	});

	test("returns empty for empty input", () => {
		expect(parseFrontmatterBlock("")).toEqual({});
	});
});

// ── parseStyleFile ──────────────────────────────────

describe("parseStyleFile", () => {
	test("parses full frontmatter with all fields", () => {
		const content = `---
name: Code Reviewer
description: Reviews code without making changes
keep-tool-instructions: true
reminder: true
reminder-interval: 3
---

You review code. You identify issues.`;

		const style = parseStyleFile(content, "/styles/reviewer.md", "user");

		expect(style.id).toBe("reviewer");
		expect(style.name).toBe("Code Reviewer");
		expect(style.description).toBe("Reviews code without making changes");
		expect(style.keepToolInstructions).toBe(true);
		expect(style.reminder).toBe(true);
		expect(style.reminderInterval).toBe(3);
		expect(style.body).toBe("You review code. You identify issues.");
		expect(style.scope).toBe("user");
		expect(style.path).toBe("/styles/reviewer.md");
	});

	test("uses filename as ID and name when no frontmatter", () => {
		const style = parseStyleFile("Just a body.", "/path/concise.md", "project");

		expect(style.id).toBe("concise");
		expect(style.name).toBe("concise");
		expect(style.body).toBe("Just a body.");
		expect(style.scope).toBe("project");
	});

	test("uses filename as name when name not in frontmatter", () => {
		const content = `---
description: Something
---

Body here.`;

		const style = parseStyleFile(content, "/styles/my-style.md", "user");
		expect(style.name).toBe("my-style");
	});

	test("defaults keepToolInstructions to false", () => {
		const content = `---
name: Test
---

Body.`;

		const style = parseStyleFile(content, "/test.md", "user");
		expect(style.keepToolInstructions).toBe(false);
	});

	test("defaults reminder to false", () => {
		const content = `---
name: Test
---

Body.`;

		const style = parseStyleFile(content, "/test.md", "user");
		expect(style.reminder).toBe(false);
	});

	test("defaults reminderInterval to 5", () => {
		const content = `---
name: Test
reminder: true
---

Body.`;

		const style = parseStyleFile(content, "/test.md", "user");
		expect(style.reminderInterval).toBe(5);
	});

	test("handles invalid reminderInterval gracefully", () => {
		const content = `---
reminder-interval: not-a-number
---

Body.`;

		const style = parseStyleFile(content, "/test.md", "user");
		expect(style.reminderInterval).toBe(5);
	});

	test("handles missing closing --- by treating entire file as body", () => {
		const content = `---
name: Broken
This has no closing delimiter`;

		const style = parseStyleFile(content, "/broken.md", "user");
		expect(style.body).toBe(content.trim());
		expect(style.name).toBe("broken");
	});

	test("handles empty body after frontmatter", () => {
		const content = `---
name: Empty Body
---
`;

		const style = parseStyleFile(content, "/empty.md", "user");
		expect(style.body).toBe("");
		expect(style.name).toBe("Empty Body");
	});

	test("preserves multiline body", () => {
		const content = `---
name: Multi
---

Line one.

Line two.

Line three.`;

		const style = parseStyleFile(content, "/multi.md", "user");
		expect(style.body).toBe("Line one.\n\nLine two.\n\nLine three.");
	});
});

// ── buildStyledPrompt ───────────────────────────────

describe("buildStyledPrompt", () => {
	const basePrompt = "You are a helpful coding assistant.";

	const makeStyle = (overrides: Partial<OutputStyle> = {}): OutputStyle => ({
		id: "test",
		path: "/test.md",
		name: "Test Style",
		description: "",
		keepToolInstructions: false,
		reminder: false,
		reminderInterval: 5,
		body: "Be concise. No explanations.",
		scope: "user",
		...overrides,
	});

	test("prepends style when keepToolInstructions is false", () => {
		const style = makeStyle({ keepToolInstructions: false });
		const result = buildStyledPrompt(basePrompt, style);

		expect(result).toStartWith("# Output Style: Test Style");
		expect(result).toContain("Be concise. No explanations.");
		expect(result).toContain("prefer the output style above");
		expect(result).toEndWith(basePrompt);
	});

	test("appends style when keepToolInstructions is true", () => {
		const style = makeStyle({ keepToolInstructions: true });
		const result = buildStyledPrompt(basePrompt, style);

		expect(result).toStartWith(basePrompt);
		expect(result).toContain("# Output Style: Test Style");
		expect(result).toContain("Be concise. No explanations.");
		expect(result).not.toContain("prefer the output style above");
	});

	test("includes style name in header", () => {
		const style = makeStyle({ name: "Code Reviewer" });
		const result = buildStyledPrompt(basePrompt, style);

		expect(result).toContain("# Output Style: Code Reviewer");
	});

	test("preserves original prompt in both modes", () => {
		for (const keepToolInstructions of [true, false]) {
			const style = makeStyle({ keepToolInstructions });
			const result = buildStyledPrompt(basePrompt, style);
			expect(result).toContain(basePrompt);
		}
	});
});

// ── shouldRemind ────────────────────────────────────

describe("shouldRemind", () => {
	const makeStyle = (overrides: Partial<OutputStyle> = {}): OutputStyle => ({
		id: "test",
		path: "/test.md",
		name: "Test",
		description: "",
		keepToolInstructions: false,
		reminder: true,
		reminderInterval: 5,
		body: "Body",
		scope: "user",
		...overrides,
	});

	test("returns false when reminder is disabled", () => {
		const style = makeStyle({ reminder: false });
		expect(shouldRemind(style, 5)).toBe(false);
		expect(shouldRemind(style, 10)).toBe(false);
	});

	test("returns false on turn 0", () => {
		const style = makeStyle({ reminder: true, reminderInterval: 1 });
		expect(shouldRemind(style, 0)).toBe(false);
	});

	test("fires at correct intervals", () => {
		const style = makeStyle({ reminderInterval: 3 });

		expect(shouldRemind(style, 1)).toBe(false);
		expect(shouldRemind(style, 2)).toBe(false);
		expect(shouldRemind(style, 3)).toBe(true);
		expect(shouldRemind(style, 4)).toBe(false);
		expect(shouldRemind(style, 5)).toBe(false);
		expect(shouldRemind(style, 6)).toBe(true);
		expect(shouldRemind(style, 9)).toBe(true);
	});

	test("fires every turn when interval is 1", () => {
		const style = makeStyle({ reminderInterval: 1 });

		expect(shouldRemind(style, 0)).toBe(false);
		expect(shouldRemind(style, 1)).toBe(true);
		expect(shouldRemind(style, 2)).toBe(true);
		expect(shouldRemind(style, 3)).toBe(true);
	});

	test("default interval of 5", () => {
		const style = makeStyle({ reminderInterval: 5 });

		expect(shouldRemind(style, 4)).toBe(false);
		expect(shouldRemind(style, 5)).toBe(true);
		expect(shouldRemind(style, 10)).toBe(true);
		expect(shouldRemind(style, 7)).toBe(false);
	});
});

// ── buildReminderContent ────────────────────────────

describe("buildReminderContent", () => {
	test("includes style name and body", () => {
		const style: OutputStyle = {
			id: "test",
			path: "/test.md",
			name: "Concise",
			description: "",
			keepToolInstructions: false,
			reminder: true,
			reminderInterval: 5,
			body: "Be brief. No fluff.",
			scope: "user",
		};

		const result = buildReminderContent(style);
		expect(result).toBe("[Style Reminder: Concise]\n\nBe brief. No fluff.");
	});
});
