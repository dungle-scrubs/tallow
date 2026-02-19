import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPluginSpecs } from "../sdk.js";

let cwd: string;
let tallowHome: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "tallow-sdk-cwd-"));
	tallowHome = mkdtempSync(join(tmpdir(), "tallow-sdk-home-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(tallowHome, { recursive: true, force: true });
});

describe("collectPluginSpecs trust gating", () => {
	test("ignores .pi/settings.json plugin entries", () => {
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

		const specs = collectPluginSpecs(cwd, undefined, "trusted", tallowHome);
		expect(specs).toContain("global-plugin");
		expect(specs).toContain("project-plugin");
		expect(specs).not.toContain("pi-plugin");
	});

	test("untrusted projects ignore project plugins but keep CLI plugins", () => {
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

		const specs = collectPluginSpecs(cwd, ["cli-plugin"], "untrusted", tallowHome);
		expect(specs).toContain("cli-plugin");
		expect(specs).not.toContain("project-plugin");
	});
});
