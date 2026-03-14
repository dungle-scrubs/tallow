/**
 * E2E: Published tarball smoke tests.
 *
 * Verifies the packed artifact installs cleanly and can load representative
 * bundled extensions without relying on repo-only paths.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const TEMP_DIRS = new Set<string>();

/**
 * Create a temp directory that is cleaned up after the test.
 *
 * @param prefix - Temp directory name prefix
 * @returns Absolute temp directory path
 */
function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	TEMP_DIRS.add(dir);
	return dir;
}

interface PackedArtifact {
	readonly packageRoot: string;
	readonly tarballPath: string;
}

/**
 * Pack the current repository and extract the tarball into a temp directory.
 *
 * @returns Extracted package root and tarball path
 */
function packArtifact(): PackedArtifact {
	const packDir = createTempDir("tallow-pack-");
	const unpackDir = createTempDir("tallow-unpack-");
	const output = execFileSync(
		"bun",
		["pm", "pack", "--destination", packDir, "--ignore-scripts", "--quiet"],
		{
			cwd: PROJECT_ROOT,
			stdio: "pipe",
			timeout: 120_000,
		}
	)
		.toString()
		.trim();
	const tarballPath = output.split("\n").at(-1) ?? "";
	if (!tarballPath) {
		throw new Error("bun pm pack did not return a tarball path");
	}

	execFileSync("tar", ["-xzf", tarballPath, "-C", unpackDir], {
		cwd: PROJECT_ROOT,
		stdio: "pipe",
		timeout: 30_000,
	});

	return {
		packageRoot: join(unpackDir, "package"),
		tarballPath,
	};
}

/**
 * Install production dependencies for an unpacked tarball.
 *
 * @param packageRoot - Extracted tarball package root
 * @returns Nothing
 */
function installPackedArtifact(packageRoot: string): void {
	execFileSync("bun", ["install", "--production", "--ignore-scripts"], {
		cwd: packageRoot,
		stdio: "pipe",
		timeout: 120_000,
	});
}

/**
 * Jiti-import representative bundled extensions from an unpacked artifact.
 *
 * @param packageRoot - Extracted tarball package root with dependencies installed
 * @returns Nothing
 */
/**
 * Resolve a module entry from Bun's content-addressed store.
 *
 * @param packageRoot - Extracted tarball package root
 * @param prefix - `.bun` directory prefix to match
 * @param subpath - Relative file path inside the matched store directory
 * @returns Absolute file path to the requested module entry
 */
function resolveBunStoreModule(packageRoot: string, prefix: string, subpath: string): string {
	const bunDir = join(packageRoot, "node_modules", ".bun");
	const entry = readdirSync(bunDir).find((name) => name.startsWith(prefix));
	if (!entry) {
		throw new Error(`Could not find Bun store entry for ${prefix}`);
	}
	return join(bunDir, entry, subpath);
}

/**
 * Import representative bundled extensions using the same alias strategy the
 * runtime applies when loading source-based bundled extensions.
 *
 * @param packageRoot - Extracted tarball package root with dependencies installed
 * @returns Nothing
 */
function importBundledExtensions(packageRoot: string): void {
	const jitiPath = pathToFileURL(
		resolveBunStoreModule(
			packageRoot,
			"@mariozechner+jiti@",
			"node_modules/@mariozechner/jiti/lib/jiti.mjs"
		)
	).href;
	const aliases = {
		"@mariozechner/pi-agent-core": resolveBunStoreModule(
			packageRoot,
			"@mariozechner+pi-agent-core@",
			"node_modules/@mariozechner/pi-agent-core/dist/index.js"
		),
		"@mariozechner/pi-ai": resolveBunStoreModule(
			packageRoot,
			"@mariozechner+pi-ai@",
			"node_modules/@mariozechner/pi-ai/dist/index.js"
		),
		"@mariozechner/pi-coding-agent": join(
			packageRoot,
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
			"dist",
			"index.js"
		),
		"@mariozechner/pi-tui": join(packageRoot, "packages", "tallow-tui", "dist", "index.js"),
	};
	const specifiers = [
		pathToFileURL(join(packageRoot, "extensions", "_shared", "atomic-write.ts")).href,
		pathToFileURL(join(packageRoot, "extensions", "health", "index.ts")).href,
		pathToFileURL(join(packageRoot, "extensions", "prompt-suggestions", "index.ts")).href,
	];
	const script = [
		`import { createJiti } from ${JSON.stringify(jitiPath)};`,
		`const jiti = createJiti(import.meta.url, { moduleCache: false, alias: ${JSON.stringify(aliases)} });`,
		`for (const specifier of ${JSON.stringify(specifiers)}) {`,
		"  await jiti.import(specifier, { default: true });",
		"}",
	].join("\n");

	execFileSync("node", ["--input-type=module", "-e", script], {
		cwd: packageRoot,
		stdio: "pipe",
		timeout: 60_000,
	});
}

afterEach(() => {
	for (const dir of TEMP_DIRS) {
		try {
			rmSync(dir, { force: true, recursive: true });
		} catch {
			// best-effort cleanup
		}
	}
	TEMP_DIRS.clear();
});

describe("Published tarball smoke test", () => {
	it("includes the workspace package needed by the published manifest", () => {
		const { packageRoot } = packArtifact();
		const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
			files?: string[];
			overrides?: Record<string, unknown>;
		};

		expect(packageJson.files).toContain("packages/tallow-tui");
		expect(existsSync(join(packageRoot, "packages", "tallow-tui", "package.json"))).toBe(true);
		expect(packageJson.overrides?.["@mariozechner/pi-coding-agent"]).toBeObject();
	});

	it("installs and loads representative bundled extensions from the packed artifact", () => {
		const { packageRoot } = packArtifact();
		installPackedArtifact(packageRoot);
		importBundledExtensions(packageRoot);
	});
});
