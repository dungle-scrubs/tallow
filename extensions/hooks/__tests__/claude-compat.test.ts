import { describe, expect, it } from "bun:test";
import {
	adaptEventDataForHook,
	CLAUDE_EVENT_MAP,
	shouldSkipClaudeToolResultHandler,
	translateClaudeHooks,
	translateClaudeOutput,
	translateClaudeToolMatcher,
} from "../index.js";

describe("translateClaudeToolMatcher", () => {
	it("maps Claude built-in tool names to tallow tool names", () => {
		expect(translateClaudeToolMatcher("Bash")).toBe("bash");
		expect(translateClaudeToolMatcher("Edit|Write")).toBe("edit|write");
		expect(translateClaudeToolMatcher("Read|Glob|Grep")).toBe("read|find|grep");
	});

	it("passes through unknown and MCP matchers unchanged", () => {
		expect(translateClaudeToolMatcher("mcp__github__.*")).toBe("mcp__github__.*");
		expect(translateClaudeToolMatcher("CustomTool")).toBe("CustomTool");
		expect(translateClaudeToolMatcher("*")).toBe("*");
	});
});

describe("translateClaudeHooks", () => {
	it("translates Claude event names to tallow event names", () => {
		const config = {
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
			PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo post" }] }],
			Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
		};

		const translated = translateClaudeHooks(config, "test-source");
		expect(translated.tool_call).toHaveLength(1);
		expect(translated.tool_result).toHaveLength(1);
		expect(translated.agent_end).toHaveLength(1);
		expect(translated.tool_call[0]?.matcher).toBe("bash");
		expect(translated.tool_result[0]?.matcher).toBe("write");

		const handler = translated.tool_call[0]?.hooks[0];
		expect(handler?._claudeSource).toBe(true);
		expect(handler?._claudeEventName).toBe("PreToolUse");
	});

	it("translates worktree aliases and preserves scope matchers", () => {
		const translated = translateClaudeHooks({
			WorktreeCreate: [
				{ matcher: "project|feature", hooks: [{ type: "command", command: "echo create" }] },
			],
			WorktreeRemove: [
				{ matcher: "project", hooks: [{ type: "command", command: "echo remove" }] },
			],
		});

		expect(translated.worktree_create).toHaveLength(1);
		expect(translated.worktree_remove).toHaveLength(1);
		expect(translated.worktree_create[0]?.matcher).toBe("project|feature");
		expect(translated.worktree_remove[0]?.matcher).toBe("project");
		expect(translated.worktree_remove[0]?.hooks[0]?._claudeEventName).toBe("WorktreeRemove");
	});

	it("translates worktree lifecycle aliases", () => {
		const translated = translateClaudeHooks({
			WorktreeCreate: [{ hooks: [{ type: "command", command: "echo create" }] }],
			WorktreeRemove: [{ hooks: [{ type: "command", command: "echo remove" }] }],
		});

		expect(translated.worktree_create).toHaveLength(1);
		expect(translated.worktree_remove).toHaveLength(1);
		expect(translated.worktree_create[0]?.hooks[0]?._claudeEventName).toBe("WorktreeCreate");
		expect(translated.worktree_remove[0]?.hooks[0]?._claudeEventName).toBe("WorktreeRemove");
	});

	it("skips PermissionRequest with a warning", () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((arg) => String(arg)).join(" "));
		};

		try {
			const translated = translateClaudeHooks(
				{
					PermissionRequest: [
						{ matcher: "Bash", hooks: [{ type: "command", command: "echo deny" }] },
					],
				},
				"/tmp/.claude/settings.json"
			);

			expect(Object.keys(translated)).toHaveLength(0);
			expect(warnings.some((line) => line.includes("PermissionRequest"))).toBe(true);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("supports mixed native + Claude events in the same config", () => {
		const translated = translateClaudeHooks({
			PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "echo a" }] }],
			tool_call: [{ matcher: "bash", hooks: [{ type: "command", command: "echo b" }] }],
		});

		expect(translated.tool_call).toHaveLength(2);
		expect(translated.tool_call[0]?.matcher).toBe("edit|write");
		expect(translated.tool_call[1]?.matcher).toBe("bash");
	});

	it("passes unknown events through for forward compatibility", () => {
		const translated = translateClaudeHooks({
			FutureEvent: [{ hooks: [{ type: "command", command: "echo future" }] }],
		});

		expect(translated.FutureEvent).toHaveLength(1);
		expect(translated.FutureEvent[0]?.hooks[0]?._claudeSource).toBe(true);
		expect(translated.FutureEvent[0]?.hooks[0]?._claudeEventName).toBe("FutureEvent");
	});

	it("maps all documented Claude events", () => {
		const expectedMappings = {
			SessionStart: "session_start",
			UserPromptSubmit: "input",
			PreToolUse: "tool_call",
			PermissionRequest: "tool_call",
			PostToolUse: "tool_result",
			PostToolUseFailure: "tool_result",
			Notification: "notification",
			SubagentStart: "subagent_start",
			SubagentStop: "subagent_stop",
			WorktreeCreate: "worktree_create",
			WorktreeRemove: "worktree_remove",
			Stop: "agent_end",
			TeammateIdle: "teammate_idle",
			TaskCompleted: "task_completed",
			PreCompact: "session_before_compact",
			SessionEnd: "session_shutdown",
		};

		expect(CLAUDE_EVENT_MAP).toEqual(expectedMappings);
	});
});

describe("adaptEventDataForHook", () => {
	it("adapts tool_call payload for PreToolUse hooks", () => {
		const adapted = adaptEventDataForHook(
			"tool_call",
			{ input: { command: "echo hi" }, toolName: "bash" },
			{ _claudeEventName: "PreToolUse", _claudeSource: true, type: "command" },
			"/repo"
		);

		expect(adapted.tool_name).toBe("bash");
		expect(adapted.tool_input).toEqual({ command: "echo hi" });
		expect(adapted.hook_event_name).toBe("PreToolUse");
		expect(adapted.cwd).toBe("/repo");
	});

	it("adapts tool_result payload for PostToolUse hooks", () => {
		const adapted = adaptEventDataForHook(
			"tool_result",
			{ content: [{ text: "ok", type: "text" }], input: { path: "a.ts" }, toolName: "write" },
			{ _claudeEventName: "PostToolUse", _claudeSource: true, type: "command" },
			"/repo"
		);

		expect(adapted.tool_name).toBe("write");
		expect(adapted.tool_input).toEqual({ path: "a.ts" });
		expect(adapted.tool_response).toEqual([{ text: "ok", type: "text" }]);
	});

	it("adapts input payload for UserPromptSubmit hooks", () => {
		const adapted = adaptEventDataForHook(
			"input",
			{ source: "terminal", text: "hello" },
			{ _claudeEventName: "UserPromptSubmit", _claudeSource: true, type: "command" },
			"/repo"
		);

		expect(adapted.prompt).toBe("hello");
		expect(adapted.hook_event_name).toBe("UserPromptSubmit");
	});

	it("keeps native hook payload unchanged", () => {
		const event = { input: { command: "ls" }, toolName: "bash" };
		const adapted = adaptEventDataForHook("tool_call", event, { type: "command" }, "/repo");
		expect(adapted).toEqual(event);
	});
});

describe("translateClaudeOutput", () => {
	it("maps permissionDecision deny to a blocking result", () => {
		const result = translateClaudeOutput({
			hookSpecificOutput: {
				permissionDecision: "deny",
				permissionDecisionReason: "no",
			},
		});

		expect(result).toEqual({ decision: "block", ok: false, reason: "no" });
	});

	it("maps top-level decision block to a blocking result", () => {
		const result = translateClaudeOutput({ decision: "block", reason: "blocked" });
		expect(result).toEqual({ decision: "block", ok: false, reason: "blocked" });
	});

	it("maps continue=false to a stop result", () => {
		const result = translateClaudeOutput({ continue: false, stopReason: "stop" });
		expect(result).toEqual({ ok: false, reason: "stop" });
	});

	it("passes additional context through", () => {
		const result = translateClaudeOutput({
			hookSpecificOutput: { additionalContext: "remember this" },
		});
		expect(result).toEqual({ additionalContext: "remember this", ok: true });
	});
});

describe("shouldSkipClaudeToolResultHandler", () => {
	it("only runs PostToolUseFailure when isError=true", () => {
		const handler = {
			_claudeEventName: "PostToolUseFailure",
			_claudeSource: true,
			type: "command",
		};
		expect(shouldSkipClaudeToolResultHandler("tool_result", { isError: false }, handler)).toBe(
			true
		);
		expect(shouldSkipClaudeToolResultHandler("tool_result", { isError: true }, handler)).toBe(
			false
		);
	});

	it("only runs PostToolUse when isError=false", () => {
		const handler = {
			_claudeEventName: "PostToolUse",
			_claudeSource: true,
			type: "command",
		};
		expect(shouldSkipClaudeToolResultHandler("tool_result", { isError: true }, handler)).toBe(true);
		expect(shouldSkipClaudeToolResultHandler("tool_result", { isError: false }, handler)).toBe(
			false
		);
	});
});
