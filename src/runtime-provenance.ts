import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Supported runtime installation modes for the active CLI. */
export type RuntimeInstallMode = "linked_local_checkout" | "published_package" | "source_checkout";

/** Freshness states for the active runtime build outputs. */
export type RuntimeBuildFreshness = "fresh" | "stale" | "unknown";

/** Full provenance details for the active tallow runtime. */
export interface RuntimeProvenance {
	readonly buildFreshness: RuntimeBuildFreshness;
	readonly executablePath: string | null;
	readonly executableRealpath: string | null;
	readonly installMode: RuntimeInstallMode;
	readonly packageDir: string;
	readonly packageRealpath: string;
	readonly staleGroups: readonly string[];
}

/** Options for resolving runtime provenance. */
export interface RuntimeProvenanceOptions {
	/** argv vector for the current process. Defaults to process.argv. */
	readonly argv?: readonly string[];
	/** Package root directory to inspect. */
	readonly packageDir: string;
}

/** Named source/output build groups checked for staleness. */
const BUILD_GROUPS = [
	{
		inputPaths: [
			"extensions",
			"package.json",
			"schemas",
			"skills",
			"src",
			"templates",
			"themes",
			"tsconfig.build.json",
		],
		name: "core",
		outputPath: "dist",
	},
	{
		inputPaths: [
			join("packages", "tallow-tui", "package.json"),
			join("packages", "tallow-tui", "src"),
			join("packages", "tallow-tui", "tsconfig.build.json"),
		],
		name: "tallow-tui",
		outputPath: join("packages", "tallow-tui", "dist"),
	},
] as const;

/**
 * Resolve a stable absolute path, preferring the filesystem realpath.
 *
 * @param value - Path to normalize
 * @returns Absolute realpath when available, else resolved absolute path
 */
export function resolveStablePath(value: string): string {
	try {
		return realpathSync(value);
	} catch {
		return resolve(value);
	}
}

/**
 * Return whether a path lives inside a directory tree.
 *
 * @param childPath - Candidate child path
 * @param parentPath - Candidate parent directory
 * @returns True when the child path is equal to or nested under the parent
 */
export function isPathInside(childPath: string, parentPath: string): boolean {
	const relativePath = relative(parentPath, childPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Return whether the current package directory is a source checkout.
 *
 * @param packageDir - Package root to inspect
 * @returns True when the package root contains a `.git` directory
 */
export function isSourceCheckout(packageDir: string): boolean {
	return existsSync(join(packageDir, ".git"));
}

/**
 * Recursively collect the newest mtime for a file tree.
 *
 * @param path - File or directory to inspect
 * @returns Latest mtime in milliseconds, or null when the path is missing
 */
function getNewestMtimeMs(path: string): number | null {
	if (!existsSync(path)) {
		return null;
	}

	const stat = statSync(path);
	if (!stat.isDirectory()) {
		return stat.mtimeMs;
	}

	let newestMtimeMs: number | null = null;
	const stack = [path];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}

		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			const entryStat = statSync(fullPath);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			newestMtimeMs =
				newestMtimeMs === null ? entryStat.mtimeMs : Math.max(newestMtimeMs, entryStat.mtimeMs);
		}
	}

	return newestMtimeMs;
}

/**
 * Return the newest mtime across a set of paths relative to the package root.
 *
 * @param packageDir - Package root containing the target paths
 * @param relativePaths - Relative files or directories to inspect
 * @returns Latest mtime in milliseconds, or null when none of the paths exist
 */
function getNewestGroupInputMtimeMs(
	packageDir: string,
	relativePaths: readonly string[]
): number | null {
	let newestMtimeMs: number | null = null;

	for (const relativePath of relativePaths) {
		const candidate = getNewestMtimeMs(join(packageDir, relativePath));
		if (candidate === null) {
			continue;
		}
		newestMtimeMs = newestMtimeMs === null ? candidate : Math.max(newestMtimeMs, candidate);
	}

	return newestMtimeMs;
}

/**
 * Return the names of build groups whose outputs are older than their inputs.
 *
 * @param packageDir - Package root containing build inputs and outputs
 * @returns Ordered list of stale build-group names
 */
export function getStaleBuildGroups(packageDir: string): string[] {
	const staleGroups: string[] = [];

	for (const group of BUILD_GROUPS) {
		const newestInputMtimeMs = getNewestGroupInputMtimeMs(packageDir, group.inputPaths);
		if (newestInputMtimeMs === null) {
			continue;
		}

		const newestOutputMtimeMs = getNewestMtimeMs(join(packageDir, group.outputPath));
		if (newestOutputMtimeMs === null || newestInputMtimeMs > newestOutputMtimeMs) {
			staleGroups.push(group.name);
		}
	}

	return staleGroups;
}

/**
 * Resolve runtime provenance for the active tallow process.
 *
 * @param options - Current-process inspection options
 * @returns Provenance details for the active runtime
 */
export function resolveRuntimeProvenance(options: RuntimeProvenanceOptions): RuntimeProvenance {
	const packageDir = resolve(options.packageDir);
	const packageRealpath = resolveStablePath(packageDir);
	const executablePath = options.argv?.[1] ?? process.argv[1] ?? null;
	const executableAbsolutePath = executablePath ? resolve(executablePath) : null;
	const executableRealpath = executablePath ? resolveStablePath(executablePath) : null;

	const installMode = !isSourceCheckout(packageRealpath)
		? "published_package"
		: executableAbsolutePath !== null &&
				executableRealpath !== null &&
				!isPathInside(executableAbsolutePath, packageDir) &&
				isPathInside(executableRealpath, packageRealpath)
			? "linked_local_checkout"
			: "source_checkout";

	const staleGroups =
		installMode === "published_package" ? [] : getStaleBuildGroups(packageRealpath);
	const buildFreshness =
		installMode === "published_package" ? "unknown" : staleGroups.length > 0 ? "stale" : "fresh";

	return {
		buildFreshness,
		executablePath: executableAbsolutePath,
		executableRealpath,
		installMode,
		packageDir,
		packageRealpath,
		staleGroups,
	};
}
