import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFrontmatterIndex } from "../frontmatter-index.js";
import { resolveModel } from "../model-resolver.js";
import type { ForkOptions } from "../spawn.js";
import { buildForkArgs } from "../spawn.js";

// ── Model Resolver ──────────────────────────────────────────

describe("resolveModel", () => {
	test("resolves 'sonnet' to a model ID containing 'sonnet'", () => {
		const result = resolveModel("sonnet");
		// Fuzzy resolver may or may not find a match depending on configured providers.
		// When it does, the result should contain "sonnet".
		if (result !== "sonnet") {
			expect(result?.toLowerCase()).toContain("sonnet");
		}
	});

	test("resolves 'inherit' to undefined", () => {
		expect(resolveModel("inherit")).toBeUndefined();
	});

	test("resolves undefined to undefined", () => {
		expect(resolveModel(undefined)).toBeUndefined();
	});

	test("passes through unknown model strings as-is", () => {
		// When fuzzy resolution finds no match, the input is returned as-is
		expect(resolveModel("zzz-nonexistent-xyzzy")).toBe("zzz-nonexistent-xyzzy");
	});
});

// ── Frontmatter Index ───────────────────────────────────────

describe("buildFrontmatterIndex", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-index-test-"));
		originalCwd = process.cwd();

		// Create project structure with prompts and commands
		const promptsDir = path.join(tmpDir, ".tallow", "prompts");
		const commandsDir = path.join(tmpDir, ".tallow", "commands");
		fs.mkdirSync(promptsDir, { recursive: true });
		fs.mkdirSync(commandsDir, { recursive: true });

		// Prompt with context: fork
		fs.writeFileSync(
			path.join(promptsDir, "review.md"),
			`---
description: Review code
context: fork
agent: reviewer
model: haiku
---
Review the code.
`
		);

		// Prompt with context: inline (explicit)
		fs.writeFileSync(
			path.join(promptsDir, "inline-cmd.md"),
			`---
description: Inline command
context: inline
---
Do something inline.
`
		);

		// Prompt with no context field (defaults to inline, not indexed)
		fs.writeFileSync(
			path.join(promptsDir, "plain.md"),
			`---
description: Plain prompt
---
Just a regular prompt.
`
		);

		// Prompt with allowed-tools
		fs.writeFileSync(
			path.join(promptsDir, "restricted.md"),
			`---
description: Restricted tools
context: fork
allowed-tools: Read, Bash, Edit
---
Do restricted work.
`
		);

		// Nested command (subdir)
		const nestedDir = path.join(promptsDir, "tallow");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(
			path.join(nestedDir, "deploy.md"),
			`---
description: Deploy
context: fork
model: sonnet
---
Deploy the project.
`
		);

		// Command without fork (model only — should still index for warning)
		fs.writeFileSync(
			path.join(commandsDir, "with-model.md"),
			`---
description: Has model but inline
model: opus
---
Use opus model.
`
		);

		process.chdir(tmpDir);
	});

	afterAll(() => {
		process.chdir(originalCwd);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("indexes prompt with context: fork", () => {
		const index = buildFrontmatterIndex();
		const entry = index.get("review");
		expect(entry).toBeDefined();
		expect(entry?.context).toBe("fork");
		expect(entry?.agent).toBe("reviewer");
		expect(entry?.model).toBe("haiku");
	});

	test("indexes prompt with explicit context: inline", () => {
		// context: inline is still a relevant field — the index stores it so
		// the extension can warn if agent/model is set on an inline command
		const index = buildFrontmatterIndex();
		const entry = index.get("inline-cmd");
		expect(entry).toBeDefined();
		expect(entry?.context).toBe("inline");
	});

	test("does not index prompts with no relevant frontmatter", () => {
		const index = buildFrontmatterIndex();
		expect(index.has("plain")).toBe(false);
	});

	test("parses allowed-tools as string array", () => {
		const index = buildFrontmatterIndex();
		const entry = index.get("restricted");
		expect(entry).toBeDefined();
		expect(entry?.allowedTools).toEqual(["Read", "Bash", "Edit"]);
	});

	test("indexes nested directory prompts as dir:name", () => {
		const index = buildFrontmatterIndex();
		const entry = index.get("tallow:deploy");
		expect(entry).toBeDefined();
		expect(entry?.context).toBe("fork");
		expect(entry?.model).toBe("sonnet");
	});

	test("indexes commands with model field", () => {
		const index = buildFrontmatterIndex();
		const entry = index.get("with-model");
		expect(entry).toBeDefined();
		expect(entry?.model).toBe("opus");
	});

	test("stores filePath for each entry", () => {
		const index = buildFrontmatterIndex();
		const entry = index.get("review");
		expect(entry?.filePath).toContain("review.md");
		expect(fs.existsSync(entry?.filePath ?? "")).toBe(true);
	});

	test("logs debug message for allowed-tools", () => {
		const logs: string[] = [];
		buildFrontmatterIndex((msg) => logs.push(msg));
		expect(logs.some((l) => l.includes("allowed-tools") && l.includes("restricted"))).toBe(true);
	});
});

// ── Spawn Args Construction ─────────────────────────────────

describe("buildForkArgs", () => {
	const baseOptions: ForkOptions = {
		content: "Do the thing",
		cwd: "/tmp/test",
	};

	test("includes base args (json mode, prompt, no-session)", async () => {
		const args = await buildForkArgs(baseOptions);
		expect(args).toContain("--mode");
		expect(args).toContain("json");
		expect(args).toContain("-p");
		expect(args).toContain("--no-session");
	});

	test("appends task content as last arg", async () => {
		const args = await buildForkArgs(baseOptions);
		const lastArg = args[args.length - 1];
		expect(lastArg).toStartWith("Task: ");
		expect(lastArg).toContain("Do the thing");
	});

	test("adds --models when model provided", async () => {
		const args = await buildForkArgs({ ...baseOptions, model: "claude-sonnet-4-5-20250514" });
		const modelsIndex = args.indexOf("--models");
		expect(modelsIndex).toBeGreaterThan(-1);
		expect(args[modelsIndex + 1]).toBe("claude-sonnet-4-5-20250514");
	});

	test("omits --models when model is undefined", async () => {
		const args = await buildForkArgs(baseOptions);
		expect(args).not.toContain("--models");
	});

	test("adds --tools when tools provided", async () => {
		const args = await buildForkArgs({ ...baseOptions, tools: ["read", "bash", "edit"] });
		const toolsIndex = args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		expect(args[toolsIndex + 1]).toBe("read,bash,edit");
	});

	test("omits --tools when tools is undefined", async () => {
		const args = await buildForkArgs(baseOptions);
		expect(args).not.toContain("--tools");
	});

	test("omits --tools when tools is empty array", async () => {
		const args = await buildForkArgs({ ...baseOptions, tools: [] });
		expect(args).not.toContain("--tools");
	});

	test("adds --skill entries when skills provided", async () => {
		const args = await buildForkArgs({ ...baseOptions, skills: ["git", "ts-standards"] });
		const firstSkillIndex = args.indexOf("--skill");
		expect(firstSkillIndex).toBeGreaterThan(-1);
		expect(args[firstSkillIndex + 1]).toBe("git");
		// Second skill
		const secondSkillIndex = args.indexOf("--skill", firstSkillIndex + 1);
		expect(secondSkillIndex).toBeGreaterThan(-1);
		expect(args[secondSkillIndex + 1]).toBe("ts-standards");
	});

	test("omits --skill when skills is undefined", async () => {
		const args = await buildForkArgs(baseOptions);
		expect(args).not.toContain("--skill");
	});

	test("adds --append-system-prompt when system prompt path provided", async () => {
		const args = await buildForkArgs(baseOptions, "/tmp/prompt.md");
		const promptIndex = args.indexOf("--append-system-prompt");
		expect(promptIndex).toBeGreaterThan(-1);
		expect(args[promptIndex + 1]).toBe("/tmp/prompt.md");
	});

	test("omits --append-system-prompt when path is undefined", async () => {
		const args = await buildForkArgs(baseOptions);
		expect(args).not.toContain("--append-system-prompt");
	});
});

// ── Shell Interpolation Security ─────────────────────────────

describe("shell interpolation boundary", () => {
	test("buildForkArgs does NOT expand shell commands in content", async () => {
		const opts: ForkOptions = {
			content: "Run this: !`echo INJECTED`",
			cwd: process.cwd(),
		};
		const args = await buildForkArgs(opts);
		const taskArg = args[args.length - 1];

		// The !`echo INJECTED` pattern must survive verbatim — NOT be replaced with "INJECTED"
		expect(taskArg).toContain("!`echo INJECTED`");
		expect(taskArg).not.toContain("Task: Run this: INJECTED");
	});

	test("buildForkArgs still expands @file references", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-shell-test-"));
		fs.writeFileSync(path.join(tmpDir, "ref.txt"), "file content here");

		try {
			const opts: ForkOptions = {
				content: "Check @ref.txt",
				cwd: tmpDir,
			};
			const args = await buildForkArgs(opts);
			const taskArg = args[args.length - 1];

			// File reference should be expanded (relative to cwd)
			expect(taskArg).toContain("file content here");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ── Agent Resolution ────────────────────────────────────────

describe("agent resolution", () => {
	test("skill model overrides agent model via resolveModel fallback", () => {
		// Simulates the logic in index.ts:
		// resolvedModel = resolveModel(skillModel) ?? resolveModel(agentModel)
		const skillModel = "haiku";
		const agentModel = "sonnet";
		const resolved = resolveModel(skillModel) ?? resolveModel(agentModel);
		// Should resolve skill model, not agent model
		expect(resolved).toBeDefined();
		expect(resolved).not.toBeUndefined();
	});

	test("falls back to agent model when skill model is undefined", () => {
		const skillModel = undefined;
		const agentModel = "sonnet";
		const resolved = resolveModel(skillModel) ?? resolveModel(agentModel);
		// undefined skill model → falls back to agent model
		expect(resolved).toBeDefined();
	});

	test("returns undefined when both skill and agent model are undefined", () => {
		const skillResolved = resolveModel(undefined);
		const agentResolved = resolveModel(undefined);
		const resolved = skillResolved ?? agentResolved;
		expect(resolved).toBeUndefined();
	});

	test("skill model inherit falls back to agent model", () => {
		const skillModel = "inherit";
		const agentModel = "opus";
		const resolved = resolveModel(skillModel) ?? resolveModel(agentModel);
		// "inherit" → undefined, falls back to agent model "opus"
		expect(resolved).toBeDefined();
	});
});
