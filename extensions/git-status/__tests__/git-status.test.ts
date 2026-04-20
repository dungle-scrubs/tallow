import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import gitStatus, { formatStatus, parseGitStatus, parsePullRequestInfo } from "../index.js";

describe("git-status extension", () => {
	test("registers session_start, agent_end, tool_result, and session_shutdown handlers", () => {
		const events: string[] = [];
		const pi = {
			on: (event: string) => {
				events.push(event);
			},
		} as unknown as ExtensionAPI;

		gitStatus(pi);
		expect(events).toContain("session_start");
		expect(events).toContain("agent_end");
		expect(events).toContain("tool_result");
		expect(events).toContain("session_shutdown");
	});

	test("does not register any commands", () => {
		const commands: string[] = [];
		const pi = {
			on: () => {},
			registerCommand: (name: string) => {
				commands.push(name);
			},
		} as unknown as ExtensionAPI;

		gitStatus(pi);
		expect(commands).toHaveLength(0);
	});
});

describe("parseGitStatus", () => {
	test("extracts branch, ahead/behind, and dirty state", () => {
		const parsed = parseGitStatus(
			[
				"# branch.oid abcdef",
				"# branch.head main",
				"# branch.upstream origin/main",
				"# branch.ab +2 -3",
				"1 .M N... 100644 100644 100644 abc def file.ts",
			].join("\n")
		);

		expect(parsed).toEqual({
			branch: "main",
			dirty: true,
			ahead: 2,
			behind: 3,
			prState: null,
			prNumber: null,
		});
	});

	test("returns null when branch metadata is missing", () => {
		expect(parseGitStatus("# branch.oid abcdef")).toBeNull();
	});
});

describe("parsePullRequestInfo", () => {
	test("prefers draft state when isDraft is true", () => {
		expect(parsePullRequestInfo('{"number":42,"isDraft":true,"state":"OPEN"}')).toEqual({
			prState: "draft",
			prNumber: 42,
		});
	});

	test("normalizes regular PR state values", () => {
		expect(parsePullRequestInfo('{"number":42,"state":"OPEN"}')).toEqual({
			prState: "open",
			prNumber: 42,
		});
	});
});

describe("formatStatus", () => {
	test("includes dirty, ahead/behind, and PR metadata", () => {
		const formatted = formatStatus({
			branch: "main",
			dirty: true,
			ahead: 1,
			behind: 2,
			prState: "draft",
			prNumber: 42,
		});

		expect(formatted).toContain("main");
		expect(formatted).toContain("*");
		expect(formatted).toContain("↑1");
		expect(formatted).toContain("↓2");
		expect(formatted).toContain("PR#42(draft)");
	});
});
