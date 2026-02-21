import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RoutingConfig } from "../model-router.js";
import { loadMatrixOverrides, loadRoutingSignalsSnapshot } from "../model-router.js";

let originalHome: string | undefined;
let testCwd = "";
let testHome = "";

/**
 * Write JSON to a path, creating parent directories when needed.
 *
 * @param filePath - Destination file path
 * @param value - JSON value to write
 * @returns Nothing
 */
function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Build a minimal routing config for loader tests.
 *
 * @param overrides - Partial config overrides
 * @returns Routing config
 */
function buildRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
	return {
		costPreference: "balanced",
		enabled: true,
		mode: "balanced",
		primaryType: "code",
		signalsMaxAgeMs: 300_000,
		...overrides,
	};
}

beforeEach(() => {
	testCwd = mkdtempSync(join(tmpdir(), "tallow-routing-loaders-cwd-"));
	testHome = mkdtempSync(join(tmpdir(), "tallow-routing-loaders-home-"));
	originalHome = process.env.HOME;
	process.env.HOME = testHome;
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	rmSync(testCwd, { force: true, recursive: true });
	rmSync(testHome, { force: true, recursive: true });
});

describe("routing data loaders", () => {
	it("loads matrix overrides from wrapped JSON payload", () => {
		writeJson(join(testCwd, ".tallow", "overrides.json"), {
			matrixOverrides: {
				"claude-sonnet-4-5": { code: 5, text: 4 },
			},
		});

		const config = buildRoutingConfig({ matrixOverridesPath: "./.tallow/overrides.json" });
		const matrixOverrides = loadMatrixOverrides(testCwd, config);
		expect(matrixOverrides).toEqual({
			"claude-sonnet-4-5": { code: 5, text: 4 },
		});
	});

	it("returns undefined for invalid matrix override payloads", () => {
		writeJson(join(testCwd, ".tallow", "overrides.json"), {
			matrixOverrides: "invalid",
		});

		const config = buildRoutingConfig({ matrixOverridesPath: "./.tallow/overrides.json" });
		const matrixOverrides = loadMatrixOverrides(testCwd, config);
		expect(matrixOverrides).toBeUndefined();
	});

	it("loads fresh routing signals snapshots", () => {
		writeJson(join(testCwd, ".tallow", "signals.json"), {
			generatedAtMs: Date.now(),
			routes: {
				"anthropic/claude-sonnet-4-5-20250514": {
					latencyP90Ms: 500,
					observedAtMs: Date.now(),
					uptime: 0.99,
				},
			},
		});

		const config = buildRoutingConfig({ signalsSnapshotPath: "./.tallow/signals.json" });
		const signals = loadRoutingSignalsSnapshot(testCwd, config);
		expect(signals).toMatchObject({
			routes: {
				"anthropic/claude-sonnet-4-5-20250514": {
					latencyP90Ms: 500,
					uptime: 0.99,
				},
			},
		});
	});

	it("drops stale routing signals snapshots", () => {
		writeJson(join(testCwd, ".tallow", "signals.json"), {
			generatedAtMs: Date.now() - 600_000,
			routes: {
				"anthropic/claude-sonnet-4-5-20250514": {
					latencyP90Ms: 500,
					observedAtMs: Date.now() - 600_000,
				},
			},
		});

		const config = buildRoutingConfig({
			signalsMaxAgeMs: 1_000,
			signalsSnapshotPath: "./.tallow/signals.json",
		});
		const signals = loadRoutingSignalsSnapshot(testCwd, config);
		expect(signals).toBeUndefined();
	});
});
