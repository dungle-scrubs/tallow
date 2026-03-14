import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Resolve a tallow runtime module from either the source tree or built dist.
 *
 * Source files are preferred so extension tests share the same module state as
 * core tests when running inside the repository. Published packages fall back
 * to `dist/`, because `src/` is not shipped.
 *
 * @param moduleName - Runtime module basename with `.js` extension
 * @returns File URL for the best available runtime module
 */
export function resolveRuntimeModuleUrl(moduleName: string): string {
	const runtimeDir = dirname(fileURLToPath(import.meta.url));
	const sourcePath = join(runtimeDir, "..", "src", moduleName.replace(/\.js$/u, ".ts"));
	if (existsSync(sourcePath)) {
		return pathToFileURL(sourcePath).href;
	}

	return pathToFileURL(join(runtimeDir, "..", "dist", moduleName)).href;
}
