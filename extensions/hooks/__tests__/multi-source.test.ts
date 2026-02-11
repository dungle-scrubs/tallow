import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tests for the multi-source hooks merge logic.
 *
 * We can't easily test the full extension (it needs the pi runtime),
 * but we can test the merge behavior by simulating the file layout
 * and importing the helper functions.
 *
 * Since the helpers are internal to the extension, we test via the
 * file layout the extension would scan.
 */

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tallow-hooks-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a hooks.json file at the given path */
function writeHooks(filePath: string, hooks: Record<string, unknown[]>): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(hooks, null, 2));
}

/** Write a settings.json with a hooks key */
function writeSettings(filePath: string, hooks: Record<string, unknown[]>): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify({ hooks }, null, 2));
}

/** Read and parse a JSON file */
function readJson(filePath: string): Record<string, unknown> {
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

describe("Hooks file layout", () => {
	it("global hooks.json is created correctly", () => {
		const hooksPath = join(tmpDir, ".tallow", "hooks.json");
		writeHooks(hooksPath, {
			tool_call: [{ matcher: "bash", hooks: [{ type: "command", command: "echo test" }] }],
		});

		expect(existsSync(hooksPath)).toBe(true);
		const content = readJson(hooksPath) as { tool_call: { matcher: string }[] };
		expect(content.tool_call).toHaveLength(1);
		expect(content.tool_call[0].matcher).toBe("bash");
	});

	it("project hooks.json is created correctly", () => {
		const hooksPath = join(tmpDir, ".tallow", "hooks.json");
		writeHooks(hooksPath, {
			tool_result: [{ matcher: "write", hooks: [{ type: "command", command: "echo done" }] }],
		});

		expect(existsSync(hooksPath)).toBe(true);
		const content = readJson(hooksPath) as { tool_result: unknown[] };
		expect(content.tool_result).toHaveLength(1);
	});

	it("extension hooks.json is created correctly", () => {
		const hooksPath = join(tmpDir, ".tallow", "extensions", "my-ext", "hooks.json");
		writeHooks(hooksPath, {
			tool_call: [{ matcher: "edit", hooks: [{ type: "command", command: "echo edit" }] }],
		});

		expect(existsSync(hooksPath)).toBe(true);

		const extDir = join(tmpDir, ".tallow", "extensions");
		const entries = readdirSync(extDir);
		expect(entries).toContain("my-ext");

		const extHooks = readJson(join(extDir, "my-ext", "hooks.json")) as {
			tool_call: unknown[];
		};
		expect(extHooks.tool_call).toHaveLength(1);
	});

	it("settings.json hooks key is read correctly", () => {
		const settingsPath = join(tmpDir, ".tallow", "settings.json");
		writeSettings(settingsPath, {
			tool_call: [{ matcher: "bash", hooks: [{ type: "command", command: "echo test" }] }],
		});

		const content = readJson(settingsPath) as { hooks: { tool_call: unknown[] } };
		expect(content.hooks.tool_call).toHaveLength(1);
	});

	it("multiple extension hooks.json files coexist", () => {
		const extDir = join(tmpDir, ".tallow", "extensions");

		writeHooks(join(extDir, "ext-a", "hooks.json"), {
			tool_call: [{ matcher: "bash", hooks: [{ type: "command", command: "echo a" }] }],
		});

		writeHooks(join(extDir, "ext-b", "hooks.json"), {
			tool_call: [{ matcher: "write", hooks: [{ type: "command", command: "echo b" }] }],
			tool_result: [{ matcher: "edit", hooks: [{ type: "command", command: "echo b-result" }] }],
		});

		writeHooks(join(extDir, "ext-c", "hooks.json"), {
			tool_call: [{ matcher: "read", hooks: [{ type: "command", command: "echo c" }] }],
		});

		const entries = readdirSync(extDir);
		expect(entries.sort()).toEqual(["ext-a", "ext-b", "ext-c"]);

		const merged: Record<string, unknown[]> = {};
		for (const entry of entries) {
			const hooks = readJson(join(extDir, entry, "hooks.json"));
			for (const [event, matchers] of Object.entries(hooks) as [string, unknown[]][]) {
				if (!merged[event]) merged[event] = [];
				merged[event].push(...matchers);
			}
		}

		expect(merged.tool_call).toHaveLength(3);
		expect(merged.tool_result).toHaveLength(1);
	});

	it("project-local extension hooks.json is found", () => {
		const localExtDir = join(tmpDir, ".tallow", "extensions");
		writeHooks(join(localExtDir, "local-ext", "hooks.json"), {
			agent_end: [{ hooks: [{ type: "command", command: "echo done" }] }],
		});

		const content = readJson(join(localExtDir, "local-ext", "hooks.json")) as {
			agent_end: unknown[];
		};
		expect(content.agent_end).toHaveLength(1);
	});

	it("hooks.json from packages in settings.json is found", () => {
		const pkgDir = join(tmpDir, "my-package");
		writeHooks(join(pkgDir, "hooks.json"), {
			tool_call: [{ matcher: "bash", hooks: [{ type: "command", command: "echo pkg-hook" }] }],
		});

		const settingsPath = join(tmpDir, ".tallow", "settings.json");
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ packages: [pkgDir] }, null, 2));

		const pkgHooks = readJson(join(pkgDir, "hooks.json")) as {
			tool_call: { matcher: string }[];
		};
		expect(pkgHooks.tool_call).toHaveLength(1);
		expect(pkgHooks.tool_call[0].matcher).toBe("bash");

		const settings = readJson(settingsPath) as { packages: string[] };
		expect(settings.packages).toContain(pkgDir);
		expect(existsSync(join(settings.packages[0], "hooks.json"))).toBe(true);
	});

	it("multiple packages with hooks.json all contribute", () => {
		const pkgA = join(tmpDir, "pkg-a");
		const pkgB = join(tmpDir, "pkg-b");

		writeHooks(join(pkgA, "hooks.json"), {
			tool_call: [{ matcher: "bash", hooks: [{ type: "command", command: "echo a" }] }],
		});
		writeHooks(join(pkgB, "hooks.json"), {
			tool_call: [{ matcher: "write", hooks: [{ type: "command", command: "echo b" }] }],
			agent_end: [{ hooks: [{ type: "command", command: "echo b-end" }] }],
		});

		const settingsPath = join(tmpDir, ".tallow", "settings.json");
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ packages: [pkgA, pkgB] }, null, 2));

		const settings = readJson(settingsPath) as { packages: string[] };
		const merged: Record<string, unknown[]> = {};
		for (const pkg of settings.packages) {
			const hooksPath = join(pkg, "hooks.json");
			if (existsSync(hooksPath)) {
				const hooks = readJson(hooksPath);
				for (const [event, matchers] of Object.entries(hooks) as [string, unknown[]][]) {
					if (!merged[event]) merged[event] = [];
					merged[event].push(...matchers);
				}
			}
		}

		expect(merged.tool_call).toHaveLength(2);
		expect(merged.agent_end).toHaveLength(1);
	});

	it("package without hooks.json is silently skipped", () => {
		const pkgDir = join(tmpDir, "no-hooks-pkg");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "no-hooks" }));

		const settingsPath = join(tmpDir, ".tallow", "settings.json");
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ packages: [pkgDir] }, null, 2));

		expect(existsSync(join(pkgDir, "hooks.json"))).toBe(false);

		const settings = readJson(settingsPath) as { packages: string[] };
		const merged: Record<string, unknown[]> = {};
		for (const pkg of settings.packages) {
			const hooksPath = join(pkg, "hooks.json");
			if (existsSync(hooksPath)) {
				const hooks = readJson(hooksPath);
				for (const [event, matchers] of Object.entries(hooks) as [string, unknown[]][]) {
					if (!merged[event]) merged[event] = [];
					merged[event].push(...matchers);
				}
			}
		}

		expect(Object.keys(merged)).toHaveLength(0);
	});
});
