import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { discoverPluginPromptSourcesFromEnv } from "../index.js";

let tmpRoot: string | null = null;

afterEach(() => {
	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
		tmpRoot = null;
	}
});

describe("discoverPluginPromptSourcesFromEnv", () => {
	it("returns empty list for empty env input", () => {
		expect(discoverPluginPromptSourcesFromEnv("")).toEqual([]);
		expect(discoverPluginPromptSourcesFromEnv(undefined)).toEqual([]);
	});

	it("parses plugin commands dirs and infers namespaces", () => {
		tmpRoot = mkdtempSync(join(tmpdir(), "command-prompt-plugin-sources-"));
		const a = join(tmpRoot, "plugin-a", "commands");
		const b = join(tmpRoot, "plugin-b", "commands");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });

		const value = `${a}${delimiter}${b}`;
		const sources = discoverPluginPromptSourcesFromEnv(value);

		expect(sources).toHaveLength(2);
		expect(sources[0]).toEqual({ namespace: "plugin-a", promptsDirs: [resolve(a)] });
		expect(sources[1]).toEqual({ namespace: "plugin-b", promptsDirs: [resolve(b)] });
	});

	it("deduplicates and skips missing directories", () => {
		tmpRoot = mkdtempSync(join(tmpdir(), "command-prompt-plugin-sources-"));
		const a = join(tmpRoot, "plugin-a", "commands");
		const missing = join(tmpRoot, "missing", "commands");
		mkdirSync(a, { recursive: true });

		const value = `${a}${delimiter}${missing}${delimiter}${a}`;
		const sources = discoverPluginPromptSourcesFromEnv(value);

		expect(sources).toHaveLength(1);
		expect(sources[0]).toEqual({ namespace: "plugin-a", promptsDirs: [resolve(a)] });
	});
});
