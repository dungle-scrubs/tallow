/**
 * E2E: Package AGENTS.md injection.
 *
 * Verifies that AGENTS.md files from packages configured in settings
 * are loaded and injected into the system prompt via agentsFilesOverride.
 *
 * NOTE: TALLOW_HOME is a module-scope constant (evaluated once at import time),
 * so we can't isolate via temp settings.json files. Instead, we use the
 * `settings: { packages: [...] }` override to control which packages are loaded.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTallowSession, type TallowSession } from "../../src/sdk.js";
import { createMockModel } from "../../test-utils/mock-model.js";

const cleanupDirs: string[] = [];

/** Create a fake package directory with optional AGENTS.md content. */
function createFakePackage(name: string, options: { agentsContent?: string } = {}): string {
	const pkgDir = mkdtempSync(join(tmpdir(), `tallow-pkg-${name}-`));
	cleanupDirs.push(pkgDir);

	writeFileSync(
		join(pkgDir, "package.json"),
		JSON.stringify({
			name,
			version: "1.0.0",
			pi: { extensions: [], skills: [], prompts: [] },
		})
	);

	if (options.agentsContent) {
		writeFileSync(join(pkgDir, "AGENTS.md"), options.agentsContent);
	}

	return pkgDir;
}

/**
 * Create a tallow session with specific packages.
 *
 * @param packages - Package paths to inject via settings override
 * @param cwd - Working directory (default: temp dir)
 * @returns Created TallowSession
 */
async function createTestSession(
	packages: Array<string | { source: string; extensions?: string[] }>,
	cwd?: string
): Promise<TallowSession> {
	const tmpCwd = cwd ?? mkdtempSync(join(tmpdir(), "tallow-cwd-"));
	if (!cwd) cleanupDirs.push(tmpCwd);

	return createTallowSession({
		cwd: tmpCwd,
		model: createMockModel(),
		provider: "mock",
		apiKey: "mock-api-key",
		session: { type: "memory" },
		noBundledExtensions: true,
		noBundledSkills: true,
		settings: { packages },
	});
}

afterEach(() => {
	for (const dir of cleanupDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
	cleanupDirs.length = 0;
});

describe("Package AGENTS.md injection", () => {
	it("injects AGENTS.md from a local package into the system prompt", async () => {
		const pkgDir = createFakePackage("test-plugin", {
			agentsContent: "## Test Plugin Rules\n\nAlways use snake_case.",
		});

		const tallow = await createTestSession([pkgDir]);
		const prompt = tallow.session.systemPrompt;

		expect(prompt).toContain("Test Plugin Rules");
		expect(prompt).toContain("Always use snake_case.");
	});

	it("injects AGENTS.md from multiple packages", async () => {
		const pkg1 = createFakePackage("plugin-a", {
			agentsContent: "## Plugin A\n\nPlugin A instructions.",
		});
		const pkg2 = createFakePackage("plugin-b", {
			agentsContent: "## Plugin B\n\nPlugin B instructions.",
		});

		const tallow = await createTestSession([pkg1, pkg2]);
		const prompt = tallow.session.systemPrompt;

		expect(prompt).toContain("Plugin A instructions.");
		expect(prompt).toContain("Plugin B instructions.");
	});

	it("skips packages without AGENTS.md gracefully", async () => {
		const pkgWithout = createFakePackage("no-agents-plugin");
		const pkgWith = createFakePackage("has-agents-plugin", {
			agentsContent: "## Has Agents\n\nThis plugin has instructions.",
		});

		const tallow = await createTestSession([pkgWithout, pkgWith]);
		const prompt = tallow.session.systemPrompt;

		expect(prompt).toContain("This plugin has instructions.");
	});

	it("handles empty packages list", async () => {
		const tallow = await createTestSession([]);

		// Should boot without errors and not include extra Project Context
		expect(tallow.session.systemPrompt).toBeTruthy();
	});

	it("handles non-existent package path gracefully", async () => {
		const tallow = await createTestSession(["/nonexistent/path/to/fake-plugin"]);

		// Should not throw
		expect(tallow.session.systemPrompt).toBeTruthy();
	});

	it("preserves project AGENTS.md alongside package AGENTS.md", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "tallow-cwd-"));
		cleanupDirs.push(tmpCwd);

		// Create a project AGENTS.md in the cwd
		writeFileSync(join(tmpCwd, "AGENTS.md"), "## Project Rules\n\nProject-specific rule.");

		const pkgDir = createFakePackage("test-plugin", {
			agentsContent: "## Plugin Rules\n\nPlugin-specific rule.",
		});

		const tallow = await createTestSession([pkgDir], tmpCwd);
		const prompt = tallow.session.systemPrompt;

		// Both should be present
		expect(prompt).toContain("Project-specific rule.");
		expect(prompt).toContain("Plugin-specific rule.");

		// Project context should appear before package context
		const projectIdx = prompt.indexOf("Project-specific rule.");
		const pluginIdx = prompt.indexOf("Plugin-specific rule.");
		expect(projectIdx).toBeLessThan(pluginIdx);
	});

	it("handles object-style package source with source field", async () => {
		const pkgDir = createFakePackage("object-source-plugin", {
			agentsContent: "## Object Source\n\nFrom object-style package config.",
		});

		const tallow = await createTestSession([{ source: pkgDir, extensions: ["*"] }]);
		const prompt = tallow.session.systemPrompt;

		expect(prompt).toContain("From object-style package config.");
	});

	it("deduplicates same package appearing twice", async () => {
		const pkgDir = createFakePackage("dupe-plugin", {
			agentsContent: "## Dupe Content\n\nShould appear once.",
		});

		const tallow = await createTestSession([pkgDir, pkgDir]);
		const prompt = tallow.session.systemPrompt;

		// Content should appear exactly once via our seen-set dedup
		const matches = prompt.split("Should appear once.").length - 1;
		expect(matches).toBe(1);
	});

	it("injects package AGENTS.md under Project Context heading", async () => {
		const pkgDir = createFakePackage("context-test", {
			agentsContent: "## Context Test\n\nSome context content.",
		});

		const tallow = await createTestSession([pkgDir]);
		const prompt = tallow.session.systemPrompt;

		// Should appear within the Project Context section
		const contextIdx = prompt.indexOf("# Project Context");
		const contentIdx = prompt.indexOf("Some context content.");
		expect(contextIdx).not.toBe(-1);
		expect(contentIdx).not.toBe(-1);
		expect(contextIdx).toBeLessThan(contentIdx);
	});
});
