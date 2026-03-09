import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	assessCliAutoRebuild,
	TALLOW_AUTO_REBUILD_ATTEMPTED_ENV,
	TALLOW_DISABLE_AUTO_REBUILD_ENV,
} from "../cli-auto-rebuild.js";
import { getStaleBuildGroups, resolveRuntimeProvenance } from "../runtime-provenance.js";

const tempDirs: string[] = [];

/**
 * Create a temporary package directory for auto-rebuild tests.
 *
 * @returns Temporary package root path
 */
function makePackageDir(): string {
	const packageDir = mkdtempSync(join(tmpdir(), "tallow-auto-rebuild-"));
	tempDirs.push(packageDir);
	return packageDir;
}

/**
 * Write a file fixture and apply a deterministic mtime.
 *
 * @param packageDir - Package root containing the fixture
 * @param relativePath - Path to write relative to the package root
 * @param mtimeMs - Desired mtime in milliseconds
 * @returns Absolute file path
 */
function writeFixture(packageDir: string, relativePath: string, mtimeMs: number): string {
	const fullPath = join(packageDir, relativePath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, `${relativePath}\n`);
	const timestamp = new Date(mtimeMs);
	utimesSync(fullPath, timestamp, timestamp);
	return fullPath;
}

/**
 * Mark a package directory as a source checkout.
 *
 * @param packageDir - Package root to mutate
 * @returns Nothing
 */
function markAsSourceCheckout(packageDir: string): void {
	mkdirSync(join(packageDir, ".git"), { recursive: true });
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
	tempDirs.length = 0;
});

describe("getStaleBuildGroups", () => {
	test("marks the core build stale when src is newer than dist", () => {
		const packageDir = makePackageDir();
		writeFixture(packageDir, "src/cli.ts", 2_000);
		writeFixture(packageDir, "dist/cli.js", 1_000);
		writeFixture(packageDir, "packages/tallow-tui/src/tui.ts", 1_000);
		writeFixture(packageDir, "packages/tallow-tui/dist/tui.js", 2_000);

		expect(getStaleBuildGroups(packageDir)).toEqual(["core"]);
	});

	test("marks the tallow-tui build stale when fork sources are newer than dist", () => {
		const packageDir = makePackageDir();
		writeFixture(packageDir, "src/cli.ts", 1_000);
		writeFixture(packageDir, "dist/cli.js", 2_000);
		writeFixture(packageDir, "packages/tallow-tui/src/tui.ts", 3_000);
		writeFixture(packageDir, "packages/tallow-tui/dist/tui.js", 2_000);

		expect(getStaleBuildGroups(packageDir)).toEqual(["tallow-tui"]);
	});
});

describe("resolveRuntimeProvenance", () => {
	test("reports linked local checkouts when a symlinked entrypoint resolves into the repo", () => {
		const packageDir = makePackageDir();
		markAsSourceCheckout(packageDir);
		writeFixture(packageDir, "src/cli.ts", 1_000);
		const entrypoint = writeFixture(packageDir, "dist/cli.js", 2_000);
		const linkedBinDir = mkdtempSync(join(tmpdir(), "tallow-linked-bin-"));
		tempDirs.push(linkedBinDir);
		const linkedEntrypoint = join(linkedBinDir, "tallow");
		symlinkSync(entrypoint, linkedEntrypoint);

		const provenance = resolveRuntimeProvenance({
			argv: ["node", linkedEntrypoint],
			packageDir,
		});

		expect(provenance.buildFreshness).toBe("fresh");
		expect(provenance.installMode).toBe("linked_local_checkout");
		expect(provenance.packageDir).toBe(packageDir);
		expect(provenance.staleGroups).toEqual([]);
		expect(provenance.executablePath).toBe(linkedEntrypoint);
		expect(provenance.executableRealpath?.endsWith("/dist/cli.js")).toBe(true);
	});

	test("reports source checkouts when launched directly from the repo", () => {
		const packageDir = makePackageDir();
		markAsSourceCheckout(packageDir);
		const entrypoint = writeFixture(packageDir, "dist/cli.js", 2_000);
		writeFixture(packageDir, "src/cli.ts", 1_000);

		const provenance = resolveRuntimeProvenance({
			argv: ["node", entrypoint],
			packageDir,
		});

		expect(provenance.buildFreshness).toBe("fresh");
		expect(provenance.installMode).toBe("source_checkout");
		expect(provenance.staleGroups).toEqual([]);
	});

	test("reports published installs as freshness unknown", () => {
		const packageDir = makePackageDir();
		const entrypoint = writeFixture(packageDir, "dist/cli.js", 1_000);
		writeFixture(packageDir, "src/cli.ts", 2_000);

		expect(
			resolveRuntimeProvenance({
				argv: ["node", entrypoint],
				packageDir,
			})
		).toMatchObject({
			buildFreshness: "unknown",
			installMode: "published_package",
			staleGroups: [],
		});
	});

	test("reports stale build groups for source checkouts", () => {
		const packageDir = makePackageDir();
		markAsSourceCheckout(packageDir);
		const entrypoint = writeFixture(packageDir, "dist/cli.js", 1_000);
		writeFixture(packageDir, "src/cli.ts", 2_000);

		const provenance = resolveRuntimeProvenance({
			argv: ["node", entrypoint],
			packageDir,
		});

		expect(provenance.buildFreshness).toBe("stale");
		expect(provenance.installMode).toBe("source_checkout");
		expect(provenance.staleGroups).toEqual(["core"]);
	});
});

describe("assessCliAutoRebuild", () => {
	test("requests rebuild for stale source-checkout dist launches", () => {
		const packageDir = makePackageDir();
		markAsSourceCheckout(packageDir);
		const entrypoint = writeFixture(packageDir, "dist/cli.js", 1_000);
		writeFixture(packageDir, "src/cli.ts", 2_000);
		writeFixture(packageDir, "packages/tallow-tui/src/tui.ts", 1_000);
		writeFixture(packageDir, "packages/tallow-tui/dist/tui.js", 2_000);

		expect(
			assessCliAutoRebuild({
				argv: ["node", entrypoint],
				packageDir,
			})
		).toEqual({
			kind: "rebuild",
			staleGroups: ["core"],
		});
	});

	test("skips rebuild for published installs", () => {
		const packageDir = makePackageDir();
		const entrypoint = writeFixture(packageDir, "dist/cli.js", 1_000);
		writeFixture(packageDir, "src/cli.ts", 2_000);

		expect(
			assessCliAutoRebuild({
				argv: ["node", entrypoint],
				packageDir,
			})
		).toEqual({
			kind: "skip",
			reason: "published_install",
			staleGroups: [],
		});
	});

	test("skips rebuild when the active entrypoint is outside dist", () => {
		const packageDir = makePackageDir();
		markAsSourceCheckout(packageDir);
		const entrypoint = writeFixture(packageDir, "scripts/dev.js", 1_000);
		writeFixture(packageDir, "src/cli.ts", 2_000);
		writeFixture(packageDir, "dist/cli.js", 1_000);

		expect(
			assessCliAutoRebuild({
				argv: ["node", entrypoint],
				packageDir,
			})
		).toEqual({
			kind: "skip",
			reason: "non_dist_entrypoint",
			staleGroups: [],
		});
	});

	test("skips rebuild when auto rebuild is disabled", () => {
		const packageDir = makePackageDir();
		markAsSourceCheckout(packageDir);
		const entrypoint = writeFixture(packageDir, "dist/cli.js", 1_000);
		writeFixture(packageDir, "src/cli.ts", 2_000);

		expect(
			assessCliAutoRebuild({
				argv: ["node", entrypoint],
				env: { [TALLOW_DISABLE_AUTO_REBUILD_ENV]: "1" },
				packageDir,
			})
		).toEqual({
			kind: "skip",
			reason: "auto_rebuild_disabled",
			staleGroups: [],
		});
	});

	test("skips rebuild after one attempted restart", () => {
		const packageDir = makePackageDir();
		markAsSourceCheckout(packageDir);
		const entrypoint = writeFixture(packageDir, "dist/cli.js", 1_000);
		writeFixture(packageDir, "src/cli.ts", 2_000);

		expect(
			assessCliAutoRebuild({
				argv: ["node", entrypoint],
				env: { [TALLOW_AUTO_REBUILD_ATTEMPTED_ENV]: "1" },
				packageDir,
			})
		).toEqual({
			kind: "skip",
			reason: "already_attempted",
			staleGroups: [],
		});
	});
});
