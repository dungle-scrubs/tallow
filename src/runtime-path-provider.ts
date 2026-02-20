import { join } from "node:path";

/** Runtime path provider for home-scoped tallow directories and files. */
export interface RuntimePathProvider {
	/** Resolve the active tallow home directory. */
	getHomeDir(): string;
	/** Resolve the run directory under home. */
	getRunDir(): string;
	/** Resolve the legacy global PID file path (run/pids.json). */
	getLegacyPidFilePath(): string;
	/** Resolve the session PID directory path (run/pids). */
	getSessionPidDir(): string;
	/** Resolve the trust directory path (trust). */
	getTrustDir(): string;
	/** Resolve the project trust store path (trust/projects.json). */
	getProjectTrustStorePath(): string;
}

/** Callback used to resolve the active runtime home directory. */
export type RuntimeHomeResolver = () => string;

/**
 * Resolve and validate runtime home values from a resolver callback.
 *
 * @param resolveHomeDir - Runtime home resolver callback
 * @returns Non-empty home directory path
 * @throws {Error} When resolver returns an empty value
 */
function requireHomeDir(resolveHomeDir: RuntimeHomeResolver): string {
	const homeDir = resolveHomeDir();
	if (!homeDir || homeDir.trim() === "") {
		throw new Error("Runtime path provider requires a non-empty home directory");
	}
	return homeDir;
}

/**
 * Create a runtime path provider backed by a home-directory resolver.
 *
 * @param resolveHomeDir - Callback resolving the current home directory
 * @returns Runtime path provider
 */
export function createRuntimePathProvider(
	resolveHomeDir: RuntimeHomeResolver
): RuntimePathProvider {
	return {
		getHomeDir(): string {
			return requireHomeDir(resolveHomeDir);
		},
		getRunDir(): string {
			return join(requireHomeDir(resolveHomeDir), "run");
		},
		getLegacyPidFilePath(): string {
			return join(requireHomeDir(resolveHomeDir), "run", "pids.json");
		},
		getSessionPidDir(): string {
			return join(requireHomeDir(resolveHomeDir), "run", "pids");
		},
		getTrustDir(): string {
			return join(requireHomeDir(resolveHomeDir), "trust");
		},
		getProjectTrustStorePath(): string {
			return join(requireHomeDir(resolveHomeDir), "trust", "projects.json");
		},
	};
}

/**
 * Create a runtime path provider pinned to a static home directory.
 *
 * Useful for tests that need deterministic path isolation.
 *
 * @param homeDir - Home directory path
 * @returns Runtime path provider with fixed home root
 */
export function createStaticRuntimePathProvider(homeDir: string): RuntimePathProvider {
	return createRuntimePathProvider(() => homeDir);
}
