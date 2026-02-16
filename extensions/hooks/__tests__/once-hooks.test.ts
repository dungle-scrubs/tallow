import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHookStateManager } from "../state-manager.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tallow-hooks-once-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("createHookStateManager", () => {
	it("returns empty state when no state file exists", () => {
		const mgr = createHookStateManager(tmpDir);
		const hookId = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo hello",
		});
		expect(mgr.hasRun(hookId)).toBe(false);
	});

	it("marks a hook as run and persists to disk", () => {
		const mgr = createHookStateManager(tmpDir);
		const hookId = mgr.computeHookId("session_start", undefined, {
			type: "command",
			command: "echo welcome",
		});

		mgr.markAsRun(hookId);
		expect(mgr.hasRun(hookId)).toBe(true);

		// Verify file was written
		const statePath = join(tmpDir, "hooks-state.json");
		expect(existsSync(statePath)).toBe(true);
		const content = JSON.parse(readFileSync(statePath, "utf-8"));
		expect(content.executedHooks).toContain(hookId);
	});

	it("loads persisted state on creation", () => {
		const hookId = "abc123def456";
		const statePath = join(tmpDir, "hooks-state.json");
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(statePath, JSON.stringify({ executedHooks: [hookId] }));

		const mgr = createHookStateManager(tmpDir);
		expect(mgr.hasRun(hookId)).toBe(true);
	});

	it("handles corrupt state file gracefully", () => {
		const statePath = join(tmpDir, "hooks-state.json");
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(statePath, "not valid json {{{");

		const mgr = createHookStateManager(tmpDir);
		const hookId = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo test",
		});
		expect(mgr.hasRun(hookId)).toBe(false);
	});

	it("handles state file with wrong shape gracefully", () => {
		const statePath = join(tmpDir, "hooks-state.json");
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(statePath, JSON.stringify({ executedHooks: "not-an-array" }));

		const mgr = createHookStateManager(tmpDir);
		const hookId = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo test",
		});
		expect(mgr.hasRun(hookId)).toBe(false);
	});

	it("does not duplicate entries on repeated markAsRun calls", () => {
		const mgr = createHookStateManager(tmpDir);
		const hookId = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo once",
		});

		mgr.markAsRun(hookId);
		mgr.markAsRun(hookId);
		mgr.markAsRun(hookId);

		const statePath = join(tmpDir, "hooks-state.json");
		const content = JSON.parse(readFileSync(statePath, "utf-8"));
		const count = content.executedHooks.filter((id: string) => id === hookId).length;
		expect(count).toBe(1);
	});

	it("reload() refreshes state from disk", () => {
		const mgr = createHookStateManager(tmpDir);
		const hookId = "externally-added-id";

		expect(mgr.hasRun(hookId)).toBe(false);

		// Simulate external write
		const statePath = join(tmpDir, "hooks-state.json");
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(statePath, JSON.stringify({ executedHooks: [hookId] }));

		mgr.reload();
		expect(mgr.hasRun(hookId)).toBe(true);
	});
});

describe("computeHookId", () => {
	it("produces stable identifiers for the same config", () => {
		const mgr = createHookStateManager(tmpDir);
		const id1 = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo test",
		});
		const id2 = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo test",
		});
		expect(id1).toBe(id2);
	});

	it("produces different identifiers for different events", () => {
		const mgr = createHookStateManager(tmpDir);
		const handler = { type: "command", command: "echo test" };
		const id1 = mgr.computeHookId("tool_call", "bash", handler);
		const id2 = mgr.computeHookId("tool_result", "bash", handler);
		expect(id1).not.toBe(id2);
	});

	it("produces different identifiers for different matchers", () => {
		const mgr = createHookStateManager(tmpDir);
		const handler = { type: "command", command: "echo test" };
		const id1 = mgr.computeHookId("tool_call", "bash", handler);
		const id2 = mgr.computeHookId("tool_call", "write|edit", handler);
		expect(id1).not.toBe(id2);
	});

	it("produces different identifiers for different commands", () => {
		const mgr = createHookStateManager(tmpDir);
		const id1 = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo a",
		});
		const id2 = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo b",
		});
		expect(id1).not.toBe(id2);
	});

	it("produces different identifiers for different agent names", () => {
		const mgr = createHookStateManager(tmpDir);
		const id1 = mgr.computeHookId("agent_end", undefined, {
			type: "agent",
			agent: "reviewer",
		});
		const id2 = mgr.computeHookId("agent_end", undefined, {
			type: "agent",
			agent: "linter",
		});
		expect(id1).not.toBe(id2);
	});

	it("treats undefined matcher the same as missing matcher", () => {
		const mgr = createHookStateManager(tmpDir);
		const handler = { type: "command", command: "echo test" };
		const id1 = mgr.computeHookId("tool_call", undefined, handler);
		const id2 = mgr.computeHookId("tool_call", undefined, handler);
		expect(id1).toBe(id2);
	});

	it("returns a 16-character hex string", () => {
		const mgr = createHookStateManager(tmpDir);
		const id = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo test",
		});
		expect(id).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("multiple once-hooks tracked independently", () => {
	it("tracks different once-hooks independently", () => {
		const mgr = createHookStateManager(tmpDir);
		const id1 = mgr.computeHookId("session_start", undefined, {
			type: "command",
			command: "echo welcome",
		});
		const id2 = mgr.computeHookId("tool_call", "bash", {
			type: "command",
			command: "echo check",
		});

		mgr.markAsRun(id1);
		expect(mgr.hasRun(id1)).toBe(true);
		expect(mgr.hasRun(id2)).toBe(false);

		mgr.markAsRun(id2);
		expect(mgr.hasRun(id1)).toBe(true);
		expect(mgr.hasRun(id2)).toBe(true);
	});

	it("persists multiple hook IDs across manager instances", () => {
		const ids = ["hook-a", "hook-b", "hook-c"];

		const mgr1 = createHookStateManager(tmpDir);
		for (const id of ids) {
			mgr1.markAsRun(id);
		}

		const mgr2 = createHookStateManager(tmpDir);
		for (const id of ids) {
			expect(mgr2.hasRun(id)).toBe(true);
		}
		expect(mgr2.hasRun("hook-d")).toBe(false);
	});
});
