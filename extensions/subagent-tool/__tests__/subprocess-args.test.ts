import { describe, expect, it } from "bun:test";
import { buildSubprocessArgs, type SubprocessArgsOptions } from "../process.js";

describe("buildSubprocessArgs", () => {
	/** Minimal options — no session, no model, just a task. */
	const minimal: SubprocessArgsOptions = { task: "do something" };

	it("always places -p as the last flag, right before the task text", () => {
		const args = buildSubprocessArgs(minimal);
		const pIdx = args.lastIndexOf("-p");
		expect(pIdx).toBeGreaterThanOrEqual(0);
		expect(pIdx).toBe(args.length - 2);
		expect(args[pIdx + 1]).toBe("Task: do something");
	});

	it("uses --no-session when session is omitted", () => {
		const args = buildSubprocessArgs(minimal);
		expect(args).toContain("--no-session");
		expect(args).not.toContain("--session");
	});

	it("uses --session <id> when session is provided", () => {
		const args = buildSubprocessArgs({ ...minimal, session: "my-session" });
		expect(args).toContain("--session");
		expect(args[args.indexOf("--session") + 1]).toBe("my-session");
		expect(args).not.toContain("--no-session");
	});

	it("--no-session is never consumed as -p value (regression: 86a8d26e)", () => {
		// The original bug: -p was placed before --no-session, so Commander
		// treated "--no-session" as the prompt text and the real task became
		// a stray positional argument → "too many arguments".
		const args = buildSubprocessArgs(minimal);
		const pIdx = args.indexOf("-p");
		const noSessionIdx = args.indexOf("--no-session");
		// -p must come AFTER --no-session in the array
		expect(pIdx).toBeGreaterThan(noSessionIdx);
	});

	it("includes --model when modelDisplayName is provided", () => {
		const args = buildSubprocessArgs({
			...minimal,
			modelDisplayName: "anthropic/claude-sonnet-4-6",
		});
		const mIdx = args.indexOf("--model");
		expect(mIdx).toBeGreaterThanOrEqual(0);
		expect(args[mIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
		// Still before -p
		expect(mIdx).toBeLessThan(args.lastIndexOf("-p"));
	});

	it("includes --tools when tools are provided", () => {
		const args = buildSubprocessArgs({ ...minimal, tools: ["read", "bash", "edit"] });
		const tIdx = args.indexOf("--tools");
		expect(tIdx).toBeGreaterThanOrEqual(0);
		expect(args[tIdx + 1]).toBe("read,bash,edit");
		expect(tIdx).toBeLessThan(args.lastIndexOf("-p"));
	});

	it("includes --skill for each skill", () => {
		const args = buildSubprocessArgs({ ...minimal, skills: ["tdd", "git"] });
		const firstSkill = args.indexOf("--skill");
		expect(firstSkill).toBeGreaterThanOrEqual(0);
		expect(args[firstSkill + 1]).toBe("tdd");
		const secondSkill = args.indexOf("--skill", firstSkill + 1);
		expect(secondSkill).toBeGreaterThanOrEqual(0);
		expect(args[secondSkill + 1]).toBe("git");
		// Both before -p
		expect(secondSkill).toBeLessThan(args.lastIndexOf("-p"));
	});

	it("includes --append-system-prompt when path is provided", () => {
		const args = buildSubprocessArgs({
			...minimal,
			systemPromptPath: "/tmp/prompt.md",
		});
		const sIdx = args.indexOf("--append-system-prompt");
		expect(sIdx).toBeGreaterThanOrEqual(0);
		expect(args[sIdx + 1]).toBe("/tmp/prompt.md");
		expect(sIdx).toBeLessThan(args.lastIndexOf("-p"));
	});

	it("produces correct full arg array with all options", () => {
		const args = buildSubprocessArgs({
			session: "sess-123",
			modelDisplayName: "openai/gpt-5",
			tools: ["read", "write"],
			skills: ["tdd"],
			systemPromptPath: "/tmp/prompt.md",
			task: "fix the tests",
		});
		expect(args).toEqual([
			"--mode",
			"json",
			"--session",
			"sess-123",
			"--model",
			"openai/gpt-5",
			"--tools",
			"read,write",
			"--skill",
			"tdd",
			"--append-system-prompt",
			"/tmp/prompt.md",
			"-p",
			"Task: fix the tests",
		]);
	});

	it("omits optional flags when not provided", () => {
		const args = buildSubprocessArgs({ task: "hello" });
		expect(args).toEqual(["--mode", "json", "--no-session", "-p", "Task: hello"]);
	});

	it("always starts with --mode json", () => {
		const args = buildSubprocessArgs(minimal);
		expect(args[0]).toBe("--mode");
		expect(args[1]).toBe("json");
	});
});
