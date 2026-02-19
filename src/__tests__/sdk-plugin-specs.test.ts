import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cwd: string;
let tallowHome: string;
let originalTallowHome: string | undefined;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "tallow-sdk-cwd-"));
	tallowHome = mkdtempSync(join(tmpdir(), "tallow-sdk-home-"));
	originalTallowHome = process.env.TALLOW_HOME;
	process.env.TALLOW_HOME = tallowHome;
});

afterEach(() => {
	if (originalTallowHome !== undefined) process.env.TALLOW_HOME = originalTallowHome;
	else delete process.env.TALLOW_HOME;

	rmSync(cwd, { recursive: true, force: true });
	rmSync(tallowHome, { recursive: true, force: true });
});

/**
 * Dynamically import sdk.ts after TALLOW_HOME is set for test isolation.
 *
 * @returns collectPluginSpecs function from sdk module
 */
async function loadCollectPluginSpecs(): Promise<
	(
		cwd: string,
		cliPlugins: string[] | undefined,
		trustStatus: "trusted" | "untrusted" | "stale_fingerprint"
	) => string[]
> {
	const mod = await import(`../sdk.js?cachebust=${Date.now()}`);
	return mod.collectPluginSpecs as (
		cwd: string,
		cliPlugins: string[] | undefined,
		trustStatus: "trusted" | "untrusted" | "stale_fingerprint"
	) => string[];
}

describe("collectPluginSpecs trust gating", () => {
	test("ignores .pi/settings.json plugin entries", async () => {
		mkdirSync(join(tallowHome), { recursive: true });
		writeFileSync(
			join(tallowHome, "settings.json"),
			JSON.stringify({ plugins: ["global-plugin"] })
		);
		mkdirSync(join(cwd, ".tallow"), { recursive: true });
		writeFileSync(
			join(cwd, ".tallow", "settings.json"),
			JSON.stringify({ plugins: ["project-plugin"] })
		);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ plugins: ["pi-plugin"] }));

		const collectPluginSpecs = await loadCollectPluginSpecs();
		const specs = collectPluginSpecs(cwd, undefined, "trusted");
		expect(specs).toContain("global-plugin");
		expect(specs).toContain("project-plugin");
		expect(specs).not.toContain("pi-plugin");
	});

	test("untrusted projects ignore project plugins but keep CLI plugins", async () => {
		mkdirSync(join(tallowHome), { recursive: true });
		writeFileSync(
			join(tallowHome, "settings.json"),
			JSON.stringify({ plugins: ["global-plugin"] })
		);
		mkdirSync(join(cwd, ".tallow"), { recursive: true });
		writeFileSync(
			join(cwd, ".tallow", "settings.json"),
			JSON.stringify({ plugins: ["project-plugin"] })
		);

		const collectPluginSpecs = await loadCollectPluginSpecs();
		const specs = collectPluginSpecs(cwd, ["cli-plugin"], "untrusted");
		expect(specs).toContain("cli-plugin");
		expect(specs).not.toContain("project-plugin");
	});
});
