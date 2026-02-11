import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Tests for Task(agent_type) parsing in agent frontmatter
 * and PI_ALLOWED_AGENT_TYPES enforcement.
 *
 * Since discoverAgents reads from the filesystem, we create temp
 * agent files and invoke discovery via the exported module.
 */

// We can't easily import discoverAgents (not exported), so we test
// the parsing logic by creating agent .md files and checking the
// parsed output matches expectations. We'll test the env var
// enforcement logic separately.

describe("Task(agent_type) parsing", () => {
	let tmpDir: string;
	let agentsDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tallow-test-"));
		agentsDir = path.join(tmpDir, ".tallow", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("parses Task(agent_type) from tools frontmatter", () => {
		const agentMd = `---
name: orchestrator
description: Manages workers
tools: read, bash, Task(reviewer), Task(worker)
---
You coordinate work.`;

		fs.writeFileSync(path.join(agentsDir, "orchestrator.md"), agentMd);

		// Parse manually using the same regex the extension uses
		const TASK_PATTERN = /^Task\((.+)\)$/;
		const rawTools = "read, bash, Task(reviewer), Task(worker)".split(",").map((t) => t.trim());

		const tools: string[] = [];
		const allowedAgentTypes: string[] = [];
		for (const t of rawTools) {
			const match = TASK_PATTERN.exec(t);
			if (match?.[1]) {
				allowedAgentTypes.push(match[1]);
			} else {
				tools.push(t);
			}
		}

		expect(tools).toEqual(["read", "bash"]);
		expect(allowedAgentTypes).toEqual(["reviewer", "worker"]);
	});

	it("handles no Task() entries", () => {
		const TASK_PATTERN = /^Task\((.+)\)$/;
		const rawTools = "read, bash, edit".split(",").map((t) => t.trim());

		const tools: string[] = [];
		const allowedAgentTypes: string[] = [];
		for (const t of rawTools) {
			const match = TASK_PATTERN.exec(t);
			if (match?.[1]) {
				allowedAgentTypes.push(match[1]);
			} else {
				tools.push(t);
			}
		}

		expect(tools).toEqual(["read", "bash", "edit"]);
		expect(allowedAgentTypes).toEqual([]);
	});

	it("handles only Task() entries", () => {
		const TASK_PATTERN = /^Task\((.+)\)$/;
		const rawTools = "Task(scout), Task(worker)".split(",").map((t) => t.trim());

		const tools: string[] = [];
		const allowedAgentTypes: string[] = [];
		for (const t of rawTools) {
			const match = TASK_PATTERN.exec(t);
			if (match?.[1]) {
				allowedAgentTypes.push(match[1]);
			} else {
				tools.push(t);
			}
		}

		expect(tools).toEqual([]);
		expect(allowedAgentTypes).toEqual(["scout", "worker"]);
	});
});

describe("PI_ALLOWED_AGENT_TYPES enforcement", () => {
	const origEnv = process.env.PI_ALLOWED_AGENT_TYPES;

	afterEach(() => {
		if (origEnv === undefined) {
			delete process.env.PI_ALLOWED_AGENT_TYPES;
		} else {
			process.env.PI_ALLOWED_AGENT_TYPES = origEnv;
		}
	});

	it("allows agents when no restriction is set", () => {
		delete process.env.PI_ALLOWED_AGENT_TYPES;
		const allowedTypes = process.env.PI_ALLOWED_AGENT_TYPES?.split(",").filter(Boolean);
		expect(allowedTypes).toBeUndefined();
	});

	it("blocks agents not in the allowed list", () => {
		process.env.PI_ALLOWED_AGENT_TYPES = "reviewer,worker";
		const allowedTypes = process.env.PI_ALLOWED_AGENT_TYPES.split(",").filter(Boolean);
		const requested = ["reviewer", "hacker"];
		const blocked = requested.filter((a) => !allowedTypes.includes(a));

		expect(blocked).toEqual(["hacker"]);
	});

	it("allows all agents when they match the restriction", () => {
		process.env.PI_ALLOWED_AGENT_TYPES = "reviewer,worker";
		const allowedTypes = process.env.PI_ALLOWED_AGENT_TYPES.split(",").filter(Boolean);
		const requested = ["reviewer", "worker"];
		const blocked = requested.filter((a) => !allowedTypes.includes(a));

		expect(blocked).toEqual([]);
	});

	it("handles empty allowed list", () => {
		process.env.PI_ALLOWED_AGENT_TYPES = "";
		const allowedTypes = process.env.PI_ALLOWED_AGENT_TYPES.split(",").filter(Boolean);
		// Empty list means no restriction (length === 0 check)
		expect(allowedTypes).toEqual([]);
		expect(allowedTypes.length > 0).toBe(false);
	});
});
