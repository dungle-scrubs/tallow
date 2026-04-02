import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	getStaleBuildGroups,
	isPathInside,
	isSourceCheckout,
	resolveStablePath,
} from "./runtime-provenance.js";

/** Environment flag that disables automatic local rebuilds. */
export const TALLOW_DISABLE_AUTO_REBUILD_ENV = "TALLOW_DISABLE_AUTO_REBUILD";

/** Environment flag that prevents rebuild/restart loops within one launch. */
export const TALLOW_AUTO_REBUILD_ATTEMPTED_ENV = "TALLOW_AUTO_REBUILD_ATTEMPTED";

/** Stale-build assessment when automatic rebuild is skipped. */
export interface CliAutoRebuildSkip {
	readonly kind: "skip";
	readonly reason:
		| "already_attempted"
		| "auto_rebuild_disabled"
		| "fresh"
		| "missing_entrypoint"
		| "non_dist_entrypoint"
		| "published_install";
	readonly staleGroups: readonly string[];
}

/** Stale-build assessment when automatic rebuild should run. */
export interface CliAutoRebuildRun {
	readonly kind: "rebuild";
	readonly staleGroups: readonly string[];
}

/** Union result for automatic rebuild assessment. */
export type CliAutoRebuildAssessment = CliAutoRebuildRun | CliAutoRebuildSkip;

/** Options for stale-build assessment and restart behavior. */
export interface CliAutoRebuildOptions {
	/** argv vector for the current process. Defaults to process.argv. */
	readonly argv?: readonly string[];
	/** Environment variables for the current process. Defaults to process.env. */
	readonly env?: NodeJS.ProcessEnv;
	/** Node executable used for restart. Defaults to process.execPath. */
	readonly execPath?: string;
	/** Package root directory to inspect. */
	readonly packageDir: string;
}

/**
 * Assess whether the current CLI launch should rebuild the local checkout.
 *
 * Automatic rebuilds only apply when all of the following are true:
 * - the package root is a source checkout
 * - the active CLI entrypoint resolves inside the package `dist/` directory
 * - at least one known build group is stale
 * - the user has not disabled rebuilds or already retried once
 *
 * @param options - Current-process inspection options
 * @returns Rebuild decision with skip reason or stale group names
 */
export function assessCliAutoRebuild(options: CliAutoRebuildOptions): CliAutoRebuildAssessment {
	const env = options.env ?? process.env;
	if (env[TALLOW_DISABLE_AUTO_REBUILD_ENV] === "1") {
		return {
			kind: "skip",
			reason: "auto_rebuild_disabled",
			staleGroups: [],
		};
	}

	if (env[TALLOW_AUTO_REBUILD_ATTEMPTED_ENV] === "1") {
		return {
			kind: "skip",
			reason: "already_attempted",
			staleGroups: [],
		};
	}

	if (!isSourceCheckout(options.packageDir)) {
		return {
			kind: "skip",
			reason: "published_install",
			staleGroups: [],
		};
	}

	const entrypoint = options.argv?.[1] ?? process.argv[1];
	if (!entrypoint) {
		return {
			kind: "skip",
			reason: "missing_entrypoint",
			staleGroups: [],
		};
	}

	const resolvedEntrypoint = resolveStablePath(entrypoint);
	const distDir = join(resolveStablePath(options.packageDir), "dist");
	if (!isPathInside(resolvedEntrypoint, distDir)) {
		return {
			kind: "skip",
			reason: "non_dist_entrypoint",
			staleGroups: [],
		};
	}

	const staleGroups = getStaleBuildGroups(options.packageDir);
	if (staleGroups.length === 0) {
		return {
			kind: "skip",
			reason: "fresh",
			staleGroups: [],
		};
	}

	return {
		kind: "rebuild",
		staleGroups,
	};
}

/**
 * Rebuild the local checkout when the active CLI is running stale `dist/` code.
 *
 * On successful rebuild this function restarts the current CLI process with the
 * same arguments, then exits the current process with the restarted child's
 * status code.
 *
 * @param options - Current-process inspection and restart options
 * @returns Nothing when no rebuild is needed; otherwise this process exits
 */
export function maybeAutoRebuildCurrentCli(options: CliAutoRebuildOptions): void {
	const assessment = assessCliAutoRebuild(options);
	if (assessment.kind !== "rebuild") {
		return;
	}

	const staleLabel = assessment.staleGroups.join(", ");
	console.error(
		`\x1b[2m↻ Detected stale local tallow build (${staleLabel}); running bun run build...\x1b[0m`
	);

	// ── Install stale dependencies before building ──────────────────────
	// When bun.lock or package.json is newer than node_modules, the
	// installed packages are likely out of date (e.g. after `git pull`).
	// Running `bun install` first prevents build failures from missing or
	// changed upstream APIs.
	if (areDependenciesStale(options.packageDir)) {
		console.error("\x1b[2m↻ Dependencies appear stale; running bun install...\x1b[0m");
		try {
			execFileSync("bun", ["install", "--frozen-lockfile"], {
				cwd: options.packageDir,
				stdio: "inherit",
			});
		} catch {
			// frozen-lockfile can fail when lockfile is out of sync with
			// package.json — fall back to a regular install
			try {
				execFileSync("bun", ["install"], {
					cwd: options.packageDir,
					stdio: "inherit",
				});
			} catch {
				console.error("\x1b[33m⚠ bun install failed; attempting build anyway...\x1b[0m");
			}
		}
	}

	try {
		execFileSync("bun", ["run", "build"], {
			cwd: options.packageDir,
			stdio: "inherit",
		});
	} catch {
		console.error(
			"\x1b[33m⚠ Automatic rebuild failed; continuing with the previous dist output.\x1b[0m"
		);
		return;
	}

	console.error("\x1b[2m↻ Rebuild complete; restarting tallow...\x1b[0m");

	const argv = options.argv ?? process.argv;
	const env = {
		...(options.env ?? process.env),
		[TALLOW_AUTO_REBUILD_ATTEMPTED_ENV]: "1",
	};
	const restart = spawnSync(options.execPath ?? process.execPath, argv.slice(1), {
		env,
		stdio: "inherit",
	});

	if (restart.error) {
		throw restart.error;
	}

	process.exit(restart.status ?? 1);
}

/**
 * Check whether installed node_modules are stale relative to the lockfile.
 *
 * Compares the mtime of `bun.lock` and `package.json` against the mtime of
 * `node_modules/.bun` (bun's install marker directory). When either manifest
 * file is newer than the marker, dependencies likely need reinstalling.
 *
 * @param packageDir - Package root directory containing bun.lock and node_modules
 * @returns True when dependencies appear stale and `bun install` should run
 */
function areDependenciesStale(packageDir: string): boolean {
	const markerPath = join(packageDir, "node_modules", ".bun");
	if (!existsSync(markerPath)) {
		// No node_modules/.bun means deps were never installed with bun
		return existsSync(join(packageDir, "package.json"));
	}

	let markerMtimeMs: number;
	try {
		markerMtimeMs = statSync(markerPath).mtimeMs;
	} catch {
		return true;
	}

	for (const manifest of ["bun.lock", "package.json"]) {
		const manifestPath = join(packageDir, manifest);
		try {
			if (statSync(manifestPath).mtimeMs > markerMtimeMs) {
				return true;
			}
		} catch {
			// Missing manifest — skip
		}
	}

	return false;
}
