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
	process.env.HOME = testHome;
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
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
	});

	it("reads global routing config from ~/.tallow/settings.json", () => {
		writeJson(join(testHome, ".tallow", "settings.json"), {
			routing: {
				costPreference: "eco",
				enabled: false,
				primaryType: "text",
			},
		});

		const config = loadRoutingConfig(testCwd);
		expect(config).toEqual({
			costPreference: "eco",
			enabled: false,
			primaryType: "text",
		});
	});

	it("project settings override global settings", () => {
		writeJson(join(testHome, ".tallow", "settings.json"), {
			routing: {
				costPreference: "eco",
				enabled: false,
				primaryType: "text",
			},
		});
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				costPreference: "premium",
				enabled: true,
				primaryType: "vision",
			},
		});

		const config = loadRoutingConfig(testCwd);
		expect(config).toEqual({
			costPreference: "premium",
			enabled: true,
			primaryType: "vision",
		});
	});

	it("falls back to defaults when routing values are invalid", () => {
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				costPreference: "max-performance",
				enabled: "yes",
				primaryType: "audio",
			},
		});

		const config = loadRoutingConfig(testCwd);
		expect(config).toEqual({
			costPreference: "balanced",
			enabled: true,
			primaryType: "code",
		});
	});

	it("uses global valid values when project values are invalid", () => {
		writeJson(join(testHome, ".tallow", "settings.json"), {
			routing: {
				costPreference: "eco",
				enabled: false,
				primaryType: "text",
			},
		});
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				costPreference: "invalid",
				enabled: "invalid",
				primaryType: "invalid",
			},
		});

		const config = loadRoutingConfig(testCwd);
		expect(config).toEqual({
			costPreference: "eco",
			enabled: false,
			primaryType: "text",
		});
	});
});
