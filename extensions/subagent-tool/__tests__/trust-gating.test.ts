import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../agents.js";

let projectRoot = "";
let originalTrustCwd: string | undefined;
let originalTrustStatus: string | undefined;

/**
 * Write a minimal project agent into the temp project.
 *
 * @returns Nothing
 */
function writeProjectAgent(): void {
	mkdirSync(join(projectRoot, ".tallow", "agents"), { recursive: true });
	writeFileSync(
		join(projectRoot, ".tallow", "agents", "worker.md"),
		`---
name: worker
description: Project worker
---
You are a project worker.
`
	);
	writeFileSync(
		join(projectRoot, ".tallow", "agents", "_defaults.md"),
		`---
maxTurns: 3
---
`
	);
}

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), "subagent-trust-gating-"));
	originalTrustCwd = process.env.TALLOW_PROJECT_TRUST_CWD;
	originalTrustStatus = process.env.TALLOW_PROJECT_TRUST_STATUS;
	writeProjectAgent();
});

afterEach(() => {
	if (originalTrustCwd === undefined) {
		delete process.env.TALLOW_PROJECT_TRUST_CWD;
	} else {
		process.env.TALLOW_PROJECT_TRUST_CWD = originalTrustCwd;
	}
	if (originalTrustStatus === undefined) {
		delete process.env.TALLOW_PROJECT_TRUST_STATUS;
	} else {
		process.env.TALLOW_PROJECT_TRUST_STATUS = originalTrustStatus;
	}
	rmSync(projectRoot, { force: true, recursive: true });
});

describe("discoverAgents trust gating", () => {
	it("loads project agents when the project is trusted", () => {
		process.env.TALLOW_PROJECT_TRUST_CWD = projectRoot;
		process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";

		const discovered = discoverAgents(projectRoot, "project");
		expect(discovered.agents).toHaveLength(1);
		expect(discovered.agents[0]?.name).toBe("worker");
		expect(discovered.defaults.maxTurns).toBe(3);
	});

	it("blocks project agents and defaults when the project is not trusted", () => {
		process.env.TALLOW_PROJECT_TRUST_CWD = projectRoot;
		process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";

		const discovered = discoverAgents(projectRoot, "project");
		expect(discovered.agents).toEqual([]);
		expect(discovered.defaults.maxTurns).toBeUndefined();
		expect(discovered.projectAgentsDir).toBeNull();
	});
});
