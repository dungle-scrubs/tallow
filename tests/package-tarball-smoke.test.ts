/**
 * E2E: Published tarball smoke tests.
 *
 * Verifies the packed artifact installs cleanly and can load representative
 * bundled extensions without relying on repo-only paths.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Pack the current repository into a tarball.
 *
 * @returns Path to the packed tarball
 */
function packTarball(): string {
	const packDir = createTempDir("tallow-pack-");
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
	return tarballPath;
}

/**
 * Extract a tarball into a temp directory for inspection.
 *
 * @param tarballPath - Path to the tarball
 * @returns Extracted package root
 */
function extractTarball(tarballPath: string): string {
	const unpackDir = createTempDir("tallow-unpack-");
	execFileSync("tar", ["-xzf", tarballPath, "-C", unpackDir], {
		stdio: "pipe",
		timeout: 30_000,
	});
	return join(unpackDir, "package");
}

/**
 * Install the tarball as a dependency in a simulated consumer project,
 * mimicking what `bun add @dungle-scrubs/tallow` does in a real project.
 *
 * @param tarballPath - Path to the tarball
 * @returns Root of the consumer project (tallow installed in node_modules)
 */
function installAsConsumer(tarballPath: string): string {
	const consumerDir = createTempDir("tallow-consumer-");
	writeFileSync(
		join(consumerDir, "package.json"),
		JSON.stringify({ name: "test-consumer", version: "1.0.0", type: "module" })
	);
	execFileSync("bun", ["add", "--ignore-scripts", tarballPath], {
		cwd: consumerDir,
		stdio: "pipe",
		timeout: 120_000,
	});
	return consumerDir;
}

/**
 * Resolve the installed tallow package root within a consumer project.
 *
 * @param consumerDir - Root of the consumer project
 * @returns Absolute path to the installed tallow package
 */
function resolveInstalledTallow(consumerDir: string): string {
	return join(consumerDir, "node_modules", "@dungle-scrubs", "tallow");
}

/**
 * Resolve a scoped module path from a consumer project's node_modules.
 *
 * @param consumerDir - Consumer project root
 * @param scope - npm scope (e.g. "@mariozechner")
 * @param name - Package name (e.g. "pi-agent-core")
 * @param entry - Entry point relative to package root (e.g. "dist/index.js")
 * @returns Absolute path to the module entry
 */
function resolveModule(consumerDir: string, scope: string, name: string, entry: string): string {
	return join(consumerDir, "node_modules", scope, name, entry);
}

/**
 * Import representative bundled extensions via jiti using the same alias
 * strategy the runtime applies when loading source-based bundled extensions.
 * Runs against a real consumer install to validate bundled deps are resolved.
 *
 * @param consumerDir - Root of the consumer project with tallow installed
 * @returns Nothing
 */
function importBundledExtensions(consumerDir: string): void {
	const tallowRoot = resolveInstalledTallow(consumerDir);

	const jitiPath = pathToFileURL(
		resolveModule(consumerDir, "@mariozechner", "jiti", "lib/jiti.mjs")
	).href;

	// pi-tui resolves from tallow's nested node_modules (bundled fork)
	const piTuiPath = join(tallowRoot, "node_modules", "@mariozechner", "pi-tui", "dist", "index.js");

	const aliases = {
		"@mariozechner/pi-agent-core": resolveModule(
			consumerDir,
			"@mariozechner",
			"pi-agent-core",
			"dist/index.js"
		),
		"@mariozechner/pi-ai": resolveModule(consumerDir, "@mariozechner", "pi-ai", "dist/index.js"),
		"@mariozechner/pi-coding-agent": resolveModule(
			consumerDir,
			"@mariozechner",
			"pi-coding-agent",
			"dist/index.js"
		),
		"@mariozechner/pi-tui": piTuiPath,
	};

	const specifiers = [
		pathToFileURL(join(tallowRoot, "extensions", "_shared", "atomic-write.ts")).href,
		pathToFileURL(join(tallowRoot, "extensions", "health", "index.ts")).href,
		pathToFileURL(join(tallowRoot, "extensions", "prompt-suggestions", "index.ts")).href,
	];

	const script = [
		`import { createJiti } from ${JSON.stringify(jitiPath)};`,
		`const jiti = createJiti(import.meta.url, { moduleCache: false, alias: ${JSON.stringify(aliases)} });`,
		`for (const specifier of ${JSON.stringify(specifiers)}) {`,
		"  await jiti.import(specifier, { default: true });",
		"}",
	].join("\n");

	execFileSync("node", ["--input-type=module", "-e", script], {
		cwd: consumerDir,
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
	it("bundles the forked pi-tui as a bundled dependency", { timeout: 60_000 }, () => {
		const tarballPath = packTarball();
		const packageRoot = extractTarball(tarballPath);
		const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
			dependencies?: Record<string, string>;
			bundledDependencies?: string[];
		};

		// Fork is shipped via bundledDependencies, not files
		expect(packageJson.bundledDependencies).toContain("@mariozechner/pi-tui");
		expect(
			existsSync(join(packageRoot, "node_modules", "@mariozechner", "pi-tui", "package.json"))
		).toBe(true);

		// Bundled copy is the fork, not upstream
		const bundledPkg = JSON.parse(
			readFileSync(
				join(packageRoot, "node_modules", "@mariozechner", "pi-tui", "package.json"),
				"utf-8"
			)
		) as { description?: string };
		expect(bundledPkg.description).toContain("fork");

		// pi-tui is a production dependency (runtime code imports it)
		expect(packageJson.dependencies?.["@mariozechner/pi-tui"]).toBeDefined();
	});

	it("installs and loads representative bundled extensions from the packed artifact", {
		timeout: 120_000,
	}, () => {
		const tarballPath = packTarball();
		const consumerDir = installAsConsumer(tarballPath);

		// Verify the bundled fork is preserved (not replaced by upstream)
		const tallowRoot = resolveInstalledTallow(consumerDir);
		const piTuiPkg = JSON.parse(
			readFileSync(
				join(tallowRoot, "node_modules", "@mariozechner", "pi-tui", "package.json"),
				"utf-8"
			)
		) as { description?: string };
		expect(piTuiPkg.description).toContain("fork");

		importBundledExtensions(consumerDir);
	});
});
