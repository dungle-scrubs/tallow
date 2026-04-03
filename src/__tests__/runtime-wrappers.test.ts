import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Copy the minimal runtime-wrapper fixture into an isolated temp directory.
 *
 * The fixture intentionally omits `src/` so wrapper imports must resolve via
 * the published-package layout (`runtime/` + `dist/`) instead of source files.
 *
 * @returns Absolute path to the temporary fixture root
 */
function createRuntimeWrapperFixture(): string {
	const fixtureDir = mkdtempSync(join(tmpdir(), "tallow-runtime-wrapper-"));
	mkdirSync(join(fixtureDir, "dist"), { recursive: true });
	mkdirSync(join(fixtureDir, "runtime"), { recursive: true });
	writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ type: "module" }));

	copyFileSync("runtime/resolve-module.ts", join(fixtureDir, "runtime", "resolve-module.ts"));
	copyFileSync("runtime/pid-schema.ts", join(fixtureDir, "runtime", "pid-schema.ts"));
	copyFileSync(
		"runtime/model-metadata-overrides.ts",
		join(fixtureDir, "runtime", "model-metadata-overrides.ts")
	);
	copyFileSync("dist/pid-schema.js", join(fixtureDir, "dist", "pid-schema.js"));
	copyFileSync(
		"dist/model-metadata-overrides.js",
		join(fixtureDir, "dist", "model-metadata-overrides.js")
	);

	return fixtureDir;
}

describe("runtime wrappers", () => {
	it("loads pid-schema wrapper without a src directory", async () => {
		const fixtureDir = createRuntimeWrapperFixture();
		const moduleUrl = pathToFileURL(join(fixtureDir, "runtime", "pid-schema.ts")).href;
		const mod = await import(moduleUrl);

		expect(typeof mod.isPidEntry).toBe("function");
		expect(typeof mod.isSessionOwner).toBe("function");
		expect(typeof mod.toOwnerKey).toBe("function");
		expect(mod.isPidEntry({ command: "bun", pid: 1, startedAt: Date.now() })).toBe(true);
	});

	it("loads model-metadata-overrides wrapper without a src directory", async () => {
		const fixtureDir = createRuntimeWrapperFixture();
		const moduleUrl = pathToFileURL(
			join(fixtureDir, "runtime", "model-metadata-overrides.ts")
		).href;
		const mod = await import(moduleUrl);

		expect(typeof mod.applyKnownModelMetadataOverrides).toBe("function");
		expect(mod.applyKnownModelMetadataOverrides({ getAll: () => [] })).toBe(0);
	});
});
