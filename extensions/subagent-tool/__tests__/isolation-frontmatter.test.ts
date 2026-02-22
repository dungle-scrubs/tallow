import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../agents.js";

const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

/**
 * Create a temporary project directory with a `.tallow/agents` folder.
 *
 * @returns Project root path
 */
function createProjectWithAgentsDir(): string {
	const projectRoot = mkdtempSync(join(tmpdir(), "subagent-isolation-test-"));
	createdDirs.push(projectRoot);
	mkdirSync(join(projectRoot, ".tallow", "agents"), { recursive: true });
	return projectRoot;
}

/**
 * Write a markdown agent definition into a temp project.
 *
 * @param projectRoot - Project root containing `.tallow/agents`
 * @param fileName - Markdown filename
 * @param content - Full markdown content
 */
function writeAgentFile(projectRoot: string, fileName: string, content: string): void {
	writeFileSync(join(projectRoot, ".tallow", "agents", fileName), content, "utf-8");
}

describe("agent frontmatter isolation", () => {
	it("parses `isolation: worktree` from agent frontmatter", () => {
		const projectRoot = createProjectWithAgentsDir();
		writeAgentFile(
			projectRoot,
			"worker.md",
			`---
name: worker
description: test agent
isolation: worktree
---
You are a worker.
`
		);

		const discovered = discoverAgents(projectRoot, "project");
		expect(discovered.agents).toHaveLength(1);
		expect(discovered.agents[0]?.isolation).toBe("worktree");
	});

	it("parses defaults isolation from _defaults.md", () => {
		const projectRoot = createProjectWithAgentsDir();
		writeAgentFile(
			projectRoot,
			"_defaults.md",
			`---
isolation: worktree
---
`
		);
		writeAgentFile(
			projectRoot,
			"worker.md",
			`---
name: worker
description: test agent
---
You are a worker.
`
		);

		const discovered = discoverAgents(projectRoot, "project");
		expect(discovered.defaults.isolation).toBe("worktree");
		expect(discovered.agents[0]?.isolation).toBeUndefined();
	});

	it("rejects invalid isolation values deterministically", () => {
		const projectRoot = createProjectWithAgentsDir();
		writeAgentFile(
			projectRoot,
			"worker.md",
			`---
name: worker
description: test agent
isolation: sandbox
---
You are a worker.
`
		);

		expect(() => discoverAgents(projectRoot, "project")).toThrow(/Invalid isolation/);
	});
});
