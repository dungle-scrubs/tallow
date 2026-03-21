import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerUpstream from "../index.js";

describe("upstream-check extension", () => {
	test("does not register command when packages/tallow-tui is absent", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "upstream-test-"));
		const originalCwd = process.cwd();
		try {
			process.chdir(tmpDir);
			const commands: string[] = [];
			const pi = {
				registerCommand: (name: string) => {
					commands.push(name);
				},
			} as unknown as ExtensionAPI;

			registerUpstream(pi);
			expect(commands).not.toContain("upstream");
		} finally {
			process.chdir(originalCwd);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("registers upstream command when packages/tallow-tui exists", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "upstream-test-"));
		mkdirSync(join(tmpDir, "packages", "tallow-tui"), { recursive: true });
		const originalCwd = process.cwd();
		try {
			process.chdir(tmpDir);
			const commands: string[] = [];
			const pi = {
				registerCommand: (name: string) => {
					commands.push(name);
				},
			} as unknown as ExtensionAPI;

			registerUpstream(pi);
			expect(commands).toContain("upstream");
		} finally {
			process.chdir(originalCwd);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
