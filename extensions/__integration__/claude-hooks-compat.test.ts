import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadHooksConfig } from "../hooks/index.js";

let cwd: string;
let homeDir: string;
let originalHome: string | undefined;

/**
 * Writes JSON with pretty formatting, creating parent directories as needed.
 *
 * @param filePath - Destination file path
 * @param value - JSON-serializable payload
 * @returns void
 */
function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "tallow-claude-hooks-cwd-"));
	homeDir = mkdtempSync(join(tmpdir(), "tallow-claude-hooks-home-"));
	originalHome = process.env.HOME;
	process.env.HOME = homeDir;
});

afterEach(() => {
	if (originalHome !== undefined) {
		process.env.HOME = originalHome;
	} else {
		delete process.env.HOME;
	}

	rmSync(cwd, { recursive: true, force: true });
	rmSync(homeDir, { recursive: true, force: true });
});

describe("Claude hooks compatibility integration", () => {
	it("loads and translates .claude/settings.json hook events", () => {
		writeJson(join(cwd, ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "echo pre" }],
					},
				],
				PostToolUseFailure: [
					{
						matcher: "Write",
						hooks: [{ type: "command", command: "echo fail" }],
					},
				],
			},
		});

		const config = loadHooksConfig(cwd);
		expect(config.tool_call).toHaveLength(1);
		expect(config.tool_result).toHaveLength(1);
		expect(config.tool_call[0]?.matcher).toBe("bash");
		expect(config.tool_result[0]?.matcher).toBe("write");
		expect(config.tool_call[0]?.hooks[0]?._claudeSource).toBe(true);
		expect(config.tool_call[0]?.hooks[0]?._claudeEventName).toBe("PreToolUse");
		expect(config.tool_result[0]?.hooks[0]?._claudeEventName).toBe("PostToolUseFailure");
	});

	it("keeps .tallow hooks ahead of .claude hooks for matching order", () => {
		writeJson(join(cwd, ".tallow", "hooks.json"), {
			tool_call: [
				{
					matcher: "bash",
					hooks: [{ type: "command", command: "echo tallow" }],
				},
			],
		});
		writeJson(join(cwd, ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "echo claude" }],
					},
				],
			},
		});

		const config = loadHooksConfig(cwd);
		const handlers = config.tool_call?.map((entry) => entry.hooks[0]?.command);
		expect(handlers).toEqual(["echo tallow", "echo claude"]);
	});

	it("allows native and Claude event names in the same .claude config", () => {
		writeJson(join(cwd, ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [
					{
						matcher: "Edit|Write",
						hooks: [{ type: "command", command: "echo claude" }],
					},
				],
				tool_call: [
					{
						matcher: "bash",
						hooks: [{ type: "command", command: "echo native" }],
					},
				],
			},
		});

		const config = loadHooksConfig(cwd);
		expect(config.tool_call).toHaveLength(2);
		expect(config.tool_call?.[0]?.matcher).toBe("edit|write");
		expect(config.tool_call?.[1]?.matcher).toBe("bash");
	});
});
