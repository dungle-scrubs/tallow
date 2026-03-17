import { describe, expect, test } from "bun:test";
import {
	cleanStepText,
	detectPlanIntent,
	extractTodoItems,
	isPlanModeToolAllowed,
	isSafeCommand,
	PLAN_MODE_ALLOWED_TOOLS,
	stripPlanIntent,
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

describe("detectPlanIntent", () => {
	// ── True positives ──────────────────────────────────────────────
	test("detects 'plan only'", () => {
		expect(detectPlanIntent("plan only")).toBe(true);
	});

	test("detects 'plan-only' (hyphenated)", () => {
		expect(detectPlanIntent("this is plan-only")).toBe(true);
	});

	test("detects 'just plan'", () => {
		expect(detectPlanIntent("just plan for now")).toBe(true);
	});

	test("detects 'only plan'", () => {
		expect(detectPlanIntent("only plan, don't execute")).toBe(true);
	});

	test("detects 'plan mode' as directive", () => {
		expect(detectPlanIntent("plan mode please")).toBe(true);
	});

	test("detects 'planning mode'", () => {
		expect(detectPlanIntent("planning mode please")).toBe(true);
	});

	test("detects 'don't implement'", () => {
		expect(detectPlanIntent("don't implement yet")).toBe(true);
	});

	test("detects curly apostrophe 'don\u2019t implement'", () => {
		expect(detectPlanIntent("don\u2019t implement yet")).toBe(true);
	});

	test("detects 'do not implement'", () => {
		expect(detectPlanIntent("do not implement")).toBe(true);
	});

	test("detects 'don't code yet'", () => {
		expect(detectPlanIntent("don't code yet")).toBe(true);
	});

	test("detects 'don't make changes'", () => {
		expect(detectPlanIntent("don't make changes")).toBe(true);
	});

	test("detects 'do not make changes'", () => {
		expect(detectPlanIntent("do not make changes")).toBe(true);
	});

	test("detects 'no implementation yet'", () => {
		expect(detectPlanIntent("no implementation yet")).toBe(true);
	});

	test("detects 'no changes first'", () => {
		expect(detectPlanIntent("no changes first")).toBe(true);
	});

	test("detects 'read-only mode'", () => {
		expect(detectPlanIntent("read-only mode")).toBe(true);
	});

	test("detects 'read only mode' (no hyphen)", () => {
		expect(detectPlanIntent("read only mode")).toBe(true);
	});

	test("detects 'this is plan'", () => {
		expect(detectPlanIntent("this is plan")).toBe(true);
	});

	test("detects 'this is planning'", () => {
		expect(detectPlanIntent("this is planning")).toBe(true);
	});

	test("detects 'plan first'", () => {
		expect(detectPlanIntent("plan first")).toBe(true);
	});

	test("detects 'plan before'", () => {
		expect(detectPlanIntent("plan before implementing")).toBe(true);
	});

	test("detects the exact user complaint: 'not yet, this is plan only'", () => {
		expect(detectPlanIntent("not yet, this is plan only")).toBe(true);
	});

	test("is case-insensitive", () => {
		expect(detectPlanIntent("Plan Only")).toBe(true);
		expect(detectPlanIntent("PLAN MODE")).toBe(true);
		expect(detectPlanIntent("DON'T IMPLEMENT")).toBe(true);
	});

	test("detects intent mixed with a request", () => {
		expect(detectPlanIntent("don't implement, just review the auth flow")).toBe(true);
		expect(detectPlanIntent("analyze the database schema, plan only")).toBe(true);
	});

	// ── True negatives ──────────────────────────────────────────────
	test("does NOT match 'make a plan for the API' (noun usage)", () => {
		expect(detectPlanIntent("make a plan for the API")).toBe(false);
	});

	test("does NOT match 'what does plan mode do?' (question about plan mode)", () => {
		expect(detectPlanIntent("what does plan mode do?")).toBe(false);
	});

	test("does NOT match 'how does plan mode work?' (question)", () => {
		expect(detectPlanIntent("how does plan mode work?")).toBe(false);
	});

	test("does NOT match 'execute the plan' (opposite intent)", () => {
		expect(detectPlanIntent("execute the plan")).toBe(false);
	});

	test("does NOT match 'the implementation plan looks good' (plan as noun)", () => {
		expect(detectPlanIntent("the implementation plan looks good")).toBe(false);
	});

	test("does NOT match 'plan' alone (too ambiguous)", () => {
		expect(detectPlanIntent("plan")).toBe(false);
	});

	test("does NOT match empty string", () => {
		expect(detectPlanIntent("")).toBe(false);
	});

	test("does NOT match 'the plan is to refactor auth' (noun usage)", () => {
		expect(detectPlanIntent("the plan is to refactor auth")).toBe(false);
	});

	test("does NOT match 'I planned the migration' (past tense)", () => {
		expect(detectPlanIntent("I planned the migration")).toBe(false);
	});
});

describe("stripPlanIntent", () => {
	test("strips 'don't implement' and keeps the request", () => {
		expect(stripPlanIntent("don't implement, just review the auth flow")).toBe(
			"just review the auth flow"
		);
	});

	test("returns original when stripping leaves empty string", () => {
		expect(stripPlanIntent("plan only")).toBe("plan only");
	});

	test("strips 'this is plan only' prefix from mixed input", () => {
		expect(stripPlanIntent("this is plan only, analyze the database schema")).toBe(
			"analyze the database schema"
		);
	});

	test("strips 'plan mode' from mixed input", () => {
		expect(stripPlanIntent("plan mode — review the auth module")).toBe("review the auth module");
	});

	test("strips 'do not make changes' and cleans punctuation", () => {
		expect(stripPlanIntent("do not make changes, review the config")).toBe("review the config");
	});

	test("cleans up double spaces after stripping", () => {
		expect(stripPlanIntent("please plan only review auth")).toBe("please review auth");
	});

	test("handles multiple intent phrases in one message", () => {
		const result = stripPlanIntent("plan only, don't implement, analyze the code");
		expect(result).toBe("analyze the code");
	});

	test("returns original when entire message is intent", () => {
		expect(stripPlanIntent("just plan")).toBe("just plan");
	});

	test("returns original for empty string", () => {
		expect(stripPlanIntent("")).toBe("");
	});
});
