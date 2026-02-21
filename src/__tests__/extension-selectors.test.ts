import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel } from "../../test-utils/mock-model.js";
import { BUNDLED } from "../config.js";
import {
	createTallowSession,
	getBundledExtensionCatalog,
	resolveExtensionSelector,
	resolveExtensionSelectors,
} from "../sdk.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
	tempDirs.length = 0;
});

describe("bundled extension catalog", () => {
	test("includes known bundled extension IDs", () => {
		const catalog = getBundledExtensionCatalog();

		expect(catalog.length).toBeGreaterThan(0);
		expect(catalog.some((entry) => entry.id === "clear")).toBe(true);
	});
});

describe("extension selector resolver", () => {
	test("resolves bundled extension IDs to bundled paths", () => {
		const resolved = resolveExtensionSelector("clear");

		expect(resolved.source).toBe("bundled");
		expect(resolved.path).toBe(join(BUNDLED.extensions, "clear"));
	});

	test("resolves explicit filesystem paths", () => {
		const extensionDir = mkdtempSync(join(tmpdir(), "tallow-ext-selector-"));
		tempDirs.push(extensionDir);
		writeFileSync(join(extensionDir, "index.ts"), "export default function() {}\n");

		const resolved = resolveExtensionSelector(extensionDir);
		expect(resolved.source).toBe("path");
		expect(resolved.path).toBe(extensionDir);
	});

	test("preserves bare-name path compatibility for existing cwd-relative paths", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tallow-ext-selector-cwd-"));
		tempDirs.push(cwd);
		const extensionDir = join(cwd, "local-ext");
		mkdirSync(extensionDir, { recursive: true });
		writeFileSync(join(extensionDir, "index.ts"), "export default function() {}\n");

		const resolved = resolveExtensionSelector("local-ext", { cwd });
		expect(resolved.source).toBe("path");
		expect(resolved.path).toBe(extensionDir);
	});

	test("throws clear errors for unknown extension IDs", () => {
		expect(() => resolveExtensionSelector("definitely-not-real")).toThrow("Unknown extension ID");
	});

	test("deduplicates resolved extension selector arrays", () => {
		const resolved = resolveExtensionSelectors(["clear", "clear"]);
		expect(resolved).toEqual([join(BUNDLED.extensions, "clear")]);
	});
});

describe("extensionsOnly loading", () => {
	test("loads only explicitly selected extensions when extensionsOnly=true", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tallow-extensions-only-"));
		tempDirs.push(cwd);

		const tallow = await createTallowSession({
			additionalExtensions: ["clear"],
			cwd,
			extensionsOnly: true,
			model: createMockModel(),
			provider: "mock",
			apiKey: "mock-api-key",
			session: { type: "memory" },
			noBundledSkills: true,
		});

		const loadedPaths = tallow.extensions.extensions.map((extension) => extension.path);
		expect(loadedPaths).toContain(join(BUNDLED.extensions, "clear"));
		expect(loadedPaths).not.toContain(join(BUNDLED.extensions, "tool-display"));
		expect(tallow.extensionOverrides).toHaveLength(0);
		expect(tallow.resolvedPlugins).toHaveLength(0);

		const disposableSession = tallow.session as { dispose?: () => void };
		disposableSession.dispose?.();
	});
});
