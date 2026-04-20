import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionHeader } from "@mariozechner/pi-coding-agent";
import { getDefaultTallowHomeDir, getTallowHomeDir } from "../_shared/tallow-paths.js";

/**
 * Encode a cwd into the per-project session directory name used by tallow.
 *
 * @param cwd - Absolute working directory path
 * @returns Encoded directory name (for example `--Users-kevin-dev-tallow--`)
 */
function encodeSessionDirName(cwd: string): string {
	const withoutLeadingSlash = cwd.startsWith("/") || cwd.startsWith("\\") ? cwd.slice(1) : cwd;
	const safeName = withoutLeadingSlash
		.replaceAll("/", "-")
		.replaceAll("\\", "-")
		.replaceAll(":", "-");
	return `--${safeName}--`;
}

/**
 * Read additional tallow home directories from the maintainer's work-dir config.
 *
 * @returns Extra configured tallow home directories
 */
function readConfiguredHomeDirs(): string[] {
	const workDirsPath = join(homedir(), ".config", "tallow-work-dirs");

	try {
		const content = readFileSync(workDirsPath, "utf-8");
		return content
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"))
			.map((line) => {
				const colonIndex = line.indexOf(":");
				return colonIndex === -1 ? "" : line.slice(colonIndex + 1).trim();
			})
			.filter((configDir) => configDir.length > 0);
	} catch {
		// Missing or unreadable work-dir config means there are no extra homes to scan.
		return [];
	}
}

/**
 * Build the set of tallow homes that should be searched for session files.
 *
 * @param homeDirs - Optional explicit home directories (used by tests to avoid scanning real homes)
 * @returns Unique tallow home directories to inspect
 */
function resolveHomeDirs(homeDirs?: readonly string[]): Set<string> {
	if (homeDirs) {
		return new Set(homeDirs);
	}

	return new Set<string>([
		getDefaultTallowHomeDir(),
		getTallowHomeDir(),
		...readConfiguredHomeDirs(),
	]);
}

/**
 * Discover every session directory that can contain sessions for a specific cwd.
 *
 * Tallow can store sessions under the default home, the active runtime home,
 * and any per-project homes listed in `~/.config/tallow-work-dirs`.
 *
 * @param cwd - Working directory whose session subdirectory should be resolved
 * @param homeDirs - Optional explicit home directories (used by tests to avoid scanning real homes)
 * @returns Existing session directory paths across all known tallow homes
 */
function discoverSessionDirsForCwd(cwd: string, homeDirs?: readonly string[]): string[] {
	const dirName = encodeSessionDirName(cwd);
	const dirs = new Set<string>();

	for (const home of resolveHomeDirs(homeDirs)) {
		const sessionsDir = join(home, "sessions", dirName);
		if (existsSync(sessionsDir)) {
			dirs.add(sessionsDir);
		}
	}

	return [...dirs];
}

/**
 * Read the session id from a JSONL session file.
 *
 * The conventional filename already contains the id, but parsing the header is
 * more robust for renamed or migrated session files.
 *
 * @param filePath - Absolute path to the session JSONL file
 * @returns Session id when readable and valid, otherwise null
 */
function readSessionId(filePath: string): string | null {
	try {
		const content = readFileSync(filePath, "utf-8");
		const firstNewline = content.indexOf("\n");
		const headerLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
		const header = JSON.parse(headerLine) as SessionHeader;
		if (header.type !== "session") return null;
		return typeof header.id === "string" && header.id.length > 0 ? header.id : null;
	} catch {
		return null;
	}
}

/**
 * List every live session id for the current cwd across all known tallow homes.
 *
 * @param cwd - Working directory whose sessions should be considered live
 * @param homeDirs - Optional explicit home directories to scan instead of runtime discovery
 * @returns Set of live session ids
 */
export function listLiveSessionIdsForCwd(cwd: string, homeDirs?: readonly string[]): Set<string> {
	const ids = new Set<string>();

	for (const sessionsDir of discoverSessionDirsForCwd(cwd, homeDirs)) {
		let files: string[];
		try {
			files = readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			const sessionId = readSessionId(join(sessionsDir, file));
			if (sessionId) {
				ids.add(sessionId);
			}
		}
	}

	return ids;
}
