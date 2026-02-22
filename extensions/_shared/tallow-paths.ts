import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the default tallow home directory when no runtime override is set.
 *
 * @returns Absolute path to the default ~/.tallow directory
 */
export function getDefaultTallowHomeDir(): string {
	return join(homedir(), ".tallow");
}

/**
 * Resolve the active tallow home directory.
 *
 * Priority:
 * 1. TALLOW_CODING_AGENT_DIR (tallow bootstrap)
 * 2. PI_CODING_AGENT_DIR (framework compatibility)
 * 3. ~/.tallow (default)
 *
 * @returns Absolute path to the active tallow home directory
 */
export function getTallowHomeDir(): string {
	return (
		process.env.TALLOW_CODING_AGENT_DIR ??
		process.env.PI_CODING_AGENT_DIR ??
		getDefaultTallowHomeDir()
	);
}

/**
 * Resolve a path under the active tallow home directory.
 *
 * @param segments - Path segments to append to the home directory
 * @returns Absolute path under the active tallow home directory
 */
export function getTallowPath(...segments: string[]): string {
	return join(getTallowHomeDir(), ...segments);
}

/**
 * Resolve the active global settings path.
 *
 * @returns Absolute path to settings.json in the active tallow home
 */
export function getTallowSettingsPath(): string {
	return getTallowPath("settings.json");
}
