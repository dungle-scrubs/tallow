import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTallowPath } from "../../_shared/tallow-paths";

// ── Auth and model path resolution for team spawning ─────────

describe("team spawn auth path resolution", () => {
	it("resolves auth.json under tallow home", () => {
		const authPath = getTallowPath("auth.json");
		// Must resolve to an absolute path under the tallow home directory
		expect(authPath).toMatch(/auth\.json$/);
		expect(authPath).toContain(".tallow");
	});

	it("resolves models.json under tallow home", () => {
		const modelsPath = getTallowPath("models.json");
		expect(modelsPath).toMatch(/models\.json$/);
		expect(modelsPath).toContain(".tallow");
	});

	it("defaults tallow home to ~/.tallow", () => {
		// Clear any overrides
		const origAgent = process.env.TALLOW_CODING_AGENT_DIR;
		const origPi = process.env.PI_CODING_AGENT_DIR;
		delete process.env.TALLOW_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;

		try {
			const expected = join(homedir(), ".tallow", "auth.json");
			expect(getTallowPath("auth.json")).toBe(expected);
		} finally {
			if (origAgent !== undefined) process.env.TALLOW_CODING_AGENT_DIR = origAgent;
			if (origPi !== undefined) process.env.PI_CODING_AGENT_DIR = origPi;
		}
	});

	it("respects TALLOW_CODING_AGENT_DIR override", () => {
		const origAgent = process.env.TALLOW_CODING_AGENT_DIR;
		process.env.TALLOW_CODING_AGENT_DIR = "/tmp/test-tallow-home";

		try {
			expect(getTallowPath("auth.json")).toBe("/tmp/test-tallow-home/auth.json");
			expect(getTallowPath("models.json")).toBe("/tmp/test-tallow-home/models.json");
		} finally {
			if (origAgent !== undefined) {
				process.env.TALLOW_CODING_AGENT_DIR = origAgent;
			} else {
				delete process.env.TALLOW_CODING_AGENT_DIR;
			}
		}
	});
});

describe("findModel removal", () => {
	it("findModel is no longer exported from teams-tool", async () => {
		const exports = await import("../index");
		expect("findModel" in exports).toBe(false);
	});

	it("team-view no longer imports from pi-ai globals", async () => {
		// The module should load without importing getProviders/getModels from pi-ai
		const teamView = await import("../state/team-view");
		expect(teamView.buildTeamView).toBeDefined();
		expect(teamView.resolveStandardTools).toBeDefined();
		// findModel should not exist
		expect("findModel" in teamView).toBe(false);
	});
});
