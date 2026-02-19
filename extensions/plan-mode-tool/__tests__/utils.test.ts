import { describe, expect, test } from "bun:test";
import {
	cleanStepText,
	extractDoneSteps,
	extractTodoItems,
	isPlanModeToolAllowed,
	isSafeCommand,
	markCompletedSteps,
	PLAN_MODE_ALLOWED_TOOLS,
	type TodoItem,
} from "../utils.js";

describe("isPlanModeToolAllowed", () => {
	test("allows explicitly allowlisted tools", () => {
		expect(PLAN_MODE_ALLOWED_TOOLS.length).toBeGreaterThan(0);
		expect(isPlanModeToolAllowed("read")).toBe(true);
		expect(isPlanModeToolAllowed("bash")).toBe(true);
		expect(isPlanModeToolAllowed("plan_mode")).toBe(true);
	});

	test("blocks non-allowlisted tools fail-closed", () => {
		expect(isPlanModeToolAllowed("edit")).toBe(false);
		expect(isPlanModeToolAllowed("write")).toBe(false);
		expect(isPlanModeToolAllowed("bg_bash")).toBe(false);
		expect(isPlanModeToolAllowed("subagent")).toBe(false);
		expect(isPlanModeToolAllowed("mcp__github__create_issue")).toBe(false);
		expect(isPlanModeToolAllowed("totally_unknown_tool")).toBe(false);
	});
});

describe("isSafeCommand", () => {
	test("allows read-only file inspection commands", () => {
		expect(isSafeCommand("cat README.md")).toBe(true);
		expect(isSafeCommand("head -n 20 file.ts")).toBe(true);
		expect(isSafeCommand("tail -f log.txt")).toBe(true);
		expect(isSafeCommand("less config.json")).toBe(true);
	});

	test("allows search commands", () => {
		expect(isSafeCommand("grep -r 'TODO' src/")).toBe(true);
		expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
		expect(isSafeCommand("rg 'pattern' --type ts")).toBe(true);
		expect(isSafeCommand("fd '*.json'")).toBe(true);
	});

	test("allows directory listing commands", () => {
		expect(isSafeCommand("ls -la")).toBe(true);
		expect(isSafeCommand("pwd")).toBe(true);
		expect(isSafeCommand("tree src/")).toBe(true);
	});

	test("allows git read commands", () => {
		expect(isSafeCommand("git status")).toBe(true);
		expect(isSafeCommand("git log --oneline -10")).toBe(true);
		expect(isSafeCommand("git diff HEAD~1")).toBe(true);
		expect(isSafeCommand("git branch -a")).toBe(true);
		expect(isSafeCommand("git show HEAD")).toBe(true);
	});

	test("allows system info commands", () => {
		expect(isSafeCommand("uname -a")).toBe(true);
		expect(isSafeCommand("whoami")).toBe(true);
		expect(isSafeCommand("date")).toBe(true);
		expect(isSafeCommand("uptime")).toBe(true);
	});

	test("allows package info commands", () => {
		expect(isSafeCommand("npm list")).toBe(true);
		expect(isSafeCommand("npm outdated")).toBe(true);
		expect(isSafeCommand("yarn info react")).toBe(true);
	});

	test("blocks file modification commands", () => {
		expect(isSafeCommand("rm -rf node_modules")).toBe(false);
		expect(isSafeCommand("mv file.ts other.ts")).toBe(false);
		expect(isSafeCommand("cp src/ dst/")).toBe(false);
		expect(isSafeCommand("mkdir new-dir")).toBe(false);
		expect(isSafeCommand("touch new-file.ts")).toBe(false);
	});

	test("blocks git write commands", () => {
		expect(isSafeCommand("git add .")).toBe(false);
		expect(isSafeCommand("git commit -m 'msg'")).toBe(false);
		expect(isSafeCommand("git push origin main")).toBe(false);
		expect(isSafeCommand("git pull")).toBe(false);
		expect(isSafeCommand("git rebase main")).toBe(false);
		expect(isSafeCommand("git reset --hard")).toBe(false);
	});

	test("blocks package install commands", () => {
		expect(isSafeCommand("npm install lodash")).toBe(false);
		expect(isSafeCommand("yarn add react")).toBe(false);
		expect(isSafeCommand("pnpm add zod")).toBe(false);
		expect(isSafeCommand("pip install requests")).toBe(false);
		expect(isSafeCommand("brew install ripgrep")).toBe(false);
	});

	test("blocks shell redirections", () => {
		expect(isSafeCommand("echo hello > file.txt")).toBe(false);
		expect(isSafeCommand("cat a >> b")).toBe(false);
	});

	test("blocks privilege escalation and system commands", () => {
		expect(isSafeCommand("sudo rm -rf /")).toBe(false);
		expect(isSafeCommand("kill -9 1234")).toBe(false);
		expect(isSafeCommand("reboot")).toBe(false);
	});

	test("blocks editors", () => {
		expect(isSafeCommand("vim file.ts")).toBe(false);
		expect(isSafeCommand("nano config.json")).toBe(false);
		expect(isSafeCommand("code .")).toBe(false);
	});

	test("rejects unknown commands", () => {
		expect(isSafeCommand("some-random-binary --flag")).toBe(false);
	});
});

describe("cleanStepText", () => {
	test("removes bold markdown", () => {
		expect(cleanStepText("**Important step**")).toBe("Important step");
	});

	test("removes inline code", () => {
		expect(cleanStepText("Update `config.json` file")).toBe("Config.json file");
	});

	test("strips action verb prefixes", () => {
		expect(cleanStepText("Create the database schema")).toBe("Database schema");
		expect(cleanStepText("Read the configuration file")).toBe("Configuration file");
		expect(cleanStepText("Install the dependencies")).toBe("Dependencies");
	});

	test("capitalizes first character", () => {
		expect(cleanStepText("some lowercase text here")).toBe("Some lowercase text here");
	});

	test("truncates long text to 50 chars", () => {
		const long =
			"This is a very long step description that should be truncated at fifty characters";
		const result = cleanStepText(long);
		expect(result.length).toBeLessThanOrEqual(50);
		expect(result).toEndWith("...");
	});

	test("collapses whitespace", () => {
		expect(cleanStepText("too   many    spaces")).toBe("Too many spaces");
	});
});

describe("extractTodoItems", () => {
	test("extracts numbered steps after Plan: header", () => {
		const message = `Here's what I'll do:

Plan:
1. Analyze the codebase structure
2. Review the configuration files
3. Check the test coverage

Let me know if this works.`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(3);
		expect(items[0].step).toBe(1);
		expect(items[0].completed).toBe(false);
		expect(items[1].step).toBe(2);
		expect(items[2].step).toBe(3);
	});

	test("handles bold Plan: header", () => {
		const message = `**Plan:**
1. First step description here
2. Second step description here`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(2);
	});

	test("returns empty for messages without Plan: header", () => {
		const message = "Here are some numbered things:\n1. Item one\n2. Item two";
		expect(extractTodoItems(message)).toHaveLength(0);
	});

	test("filters out short steps", () => {
		const message = `Plan:
1. Do X
2. Analyze the complete project structure thoroughly`;

		const items = extractTodoItems(message);
		// "Do X" is too short (<=5 chars), should be filtered
		expect(items).toHaveLength(1);
	});

	test("steps are numbered sequentially from 1", () => {
		const message = `Plan:
1. First real step here please
5. Fifth but actually second
10. Tenth but actually third`;

		const items = extractTodoItems(message);
		expect(items.map((i) => i.step)).toEqual([1, 2, 3]);
	});
});

describe("extractDoneSteps", () => {
	test("extracts single done marker", () => {
		expect(extractDoneSteps("I completed the task [DONE:1]")).toEqual([1]);
	});

	test("extracts multiple done markers", () => {
		expect(extractDoneSteps("[DONE:1] and [DONE:3] are complete")).toEqual([1, 3]);
	});

	test("is case-insensitive", () => {
		expect(extractDoneSteps("[done:2] finished")).toEqual([2]);
		expect(extractDoneSteps("[Done:5] finished")).toEqual([5]);
	});

	test("returns empty for no markers", () => {
		expect(extractDoneSteps("No completion markers here")).toEqual([]);
	});
});

describe("markCompletedSteps", () => {
	test("marks matching steps as completed", () => {
		const items: TodoItem[] = [
			{ step: 1, text: "First", completed: false },
			{ step: 2, text: "Second", completed: false },
			{ step: 3, text: "Third", completed: false },
		];

		const count = markCompletedSteps("[DONE:1] [DONE:3]", items);
		expect(count).toBe(2);
		expect(items[0].completed).toBe(true);
		expect(items[1].completed).toBe(false);
		expect(items[2].completed).toBe(true);
	});

	test("returns 0 when no markers match", () => {
		const items: TodoItem[] = [{ step: 1, text: "First", completed: false }];
		expect(markCompletedSteps("No markers", items)).toBe(0);
		expect(items[0].completed).toBe(false);
	});

	test("ignores markers for non-existent steps", () => {
		const items: TodoItem[] = [{ step: 1, text: "First", completed: false }];
		const count = markCompletedSteps("[DONE:99]", items);
		expect(count).toBe(1); // extractDoneSteps found 1 marker
		expect(items[0].completed).toBe(false); // but step 1 wasn't marked
	});

	test("does not un-complete already completed steps", () => {
		const items: TodoItem[] = [{ step: 1, text: "First", completed: true }];
		markCompletedSteps("No new markers", items);
		expect(items[0].completed).toBe(true);
	});
});
