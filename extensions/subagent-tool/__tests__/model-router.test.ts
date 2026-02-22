import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tests for tallow-specific routing config loading.
 *
 * selectModels tests live in the synapse package.
 * routeModel behavior tests live in auto-cheap-model.test.ts.
 */

const { loadRoutingConfig } = await import("../model-router.js");

let testCwd = "";
let testHome = "";
let originalHome: string | undefined;
let originalTallowHome: string | undefined;

/**
 * Write a JSON file, creating parent directories as needed.
 *
 * @param filePath - Target file path
 * @param value - JSON value to serialize
 * @returns Nothing
 */
function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
	testCwd = mkdtempSync(join(tmpdir(), "tallow-routing-cwd-"));
	testHome = mkdtempSync(join(tmpdir(), "tallow-routing-home-"));
	originalHome = process.env.HOME;
	originalTallowHome = process.env.TALLOW_CODING_AGENT_DIR;
	process.env.HOME = testHome;
	process.env.TALLOW_CODING_AGENT_DIR = join(testHome, ".tallow");
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalTallowHome === undefined) {
		delete process.env.TALLOW_CODING_AGENT_DIR;
	} else {
		process.env.TALLOW_CODING_AGENT_DIR = originalTallowHome;
	}
	rmSync(testCwd, { recursive: true, force: true });
	rmSync(testHome, { recursive: true, force: true });
});

describe("loadRoutingConfig", () => {
	it("returns defaults when settings files are missing", () => {
		const config = loadRoutingConfig(testCwd);
		expect(config.enabled).toBe(true);
		expect(config.primaryType).toBe("code");
		expect(config.costPreference).toBe("balanced");
		expect(config.mode).toBe("balanced");
		expect(config.signalsMaxAgeMs).toBe(1_800_000);
	});

	it("reads global routing config from ~/.tallow/settings.json", () => {
		writeJson(join(testHome, ".tallow", "settings.json"), {
			routing: {
				costPreference: "eco",
				enabled: false,
				matrixOverridesPath: "~/.tallow/model-matrix-overrides.json",
				mode: "quality",
				primaryType: "text",
				signalsMaxAgeMs: 120_000,
				signalsSnapshotPath: "~/.tallow/routing-signals.json",
			},
		});

		const config = loadRoutingConfig(testCwd);
		expect(config).toEqual({
			costPreference: "eco",
			enabled: false,
			matrixOverridesPath: "~/.tallow/model-matrix-overrides.json",
			mode: "quality",
			primaryType: "text",
			signalsMaxAgeMs: 120_000,
			signalsSnapshotPath: "~/.tallow/routing-signals.json",
		});
	});

	it("project settings override global settings", () => {
		writeJson(join(testHome, ".tallow", "settings.json"), {
			routing: {
				costPreference: "eco",
				enabled: false,
				matrixOverridesPath: "~/.tallow/global-overrides.json",
				mode: "cheap",
				primaryType: "text",
				signalsMaxAgeMs: 120_000,
				signalsSnapshotPath: "~/.tallow/global-signals.json",
			},
		});
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				costPreference: "premium",
				enabled: true,
				matrixOverridesPath: "./.tallow/project-overrides.json",
				mode: "reliable",
				primaryType: "vision",
				signalsMaxAgeMs: 300_000,
				signalsSnapshotPath: "./.tallow/project-signals.json",
			},
		});

		const config = loadRoutingConfig(testCwd);
		expect(config).toEqual({
			costPreference: "premium",
			enabled: true,
			matrixOverridesPath: "./.tallow/project-overrides.json",
			mode: "reliable",
			primaryType: "vision",
			signalsMaxAgeMs: 300_000,
			signalsSnapshotPath: "./.tallow/project-signals.json",
		});
	});

	it("falls back to defaults when routing values are invalid", () => {
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				costPreference: "max-performance",
				enabled: "yes",
				matrixOverridesPath: 42,
				mode: "turbo",
				primaryType: "audio",
				signalsMaxAgeMs: -10,
				signalsSnapshotPath: ["bad"],
			},
		});

		const config = loadRoutingConfig(testCwd);
		expect(config).toEqual({
			costPreference: "balanced",
			enabled: true,
			mode: "balanced",
			primaryType: "code",
			signalsMaxAgeMs: 1_800_000,
		});
	});

	it("uses global valid values when project values are invalid", () => {
		writeJson(join(testHome, ".tallow", "settings.json"), {
			routing: {
				costPreference: "eco",
				enabled: false,
				matrixOverridesPath: "~/.tallow/global-overrides.json",
				mode: "fast",
				primaryType: "text",
				signalsMaxAgeMs: 240_000,
				signalsSnapshotPath: "~/.tallow/global-signals.json",
			},
		});
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				costPreference: "invalid",
				enabled: "invalid",
				matrixOverridesPath: { invalid: true },
				mode: "invalid",
				primaryType: "invalid",
				signalsMaxAgeMs: 0,
				signalsSnapshotPath: true,
			},
		});

		const config = loadRoutingConfig(testCwd);
		expect(config).toEqual({
			costPreference: "eco",
			enabled: false,
			matrixOverridesPath: "~/.tallow/global-overrides.json",
			mode: "fast",
			primaryType: "text",
			signalsMaxAgeMs: 240_000,
			signalsSnapshotPath: "~/.tallow/global-signals.json",
		});
	});

	it("keeps valid modePolicyOverrides map", () => {
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				modePolicyOverrides: {
					reliable: {
						complexityBias: 1,
						constraints: { minUptime: 0.99 },
					},
				},
			},
		});

		const config = loadRoutingConfig(testCwd);
		expect(config.modePolicyOverrides).toEqual({
			reliable: {
				complexityBias: 1,
				constraints: { minUptime: 0.99 },
			},
		});
	});
});
