/**
 * One-time migration: moves flat session files into per-cwd subdirectories.
 *
 * The pi framework expects sessions stored in per-cwd subdirectories under
 * `~/.tallow/sessions/`. Previously tallow stored all sessions flat in that
 * directory, which broke `/resume` scoping.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Encode a cwd into a safe directory name, matching the framework's
 * `getDefaultSessionDir()` encoding.
 *
 * @param cwd - Absolute working directory path
 * @returns Encoded directory name (e.g., `--Users-kevin-dev-tallow--`)
 */
export function encodeSessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * One-time migration: move flat session files into per-cwd subdirectories.
 *
 * Reads each `.jsonl` file's header line to extract the `cwd` field, then
 * moves the file into the appropriate `--<encoded-cwd>--/` subdirectory.
 * Files with missing or corrupt headers go to `--unknown--/`.
 *
 * Idempotent: no-op if no flat `.jsonl` files exist in the sessions root.
 *
 * @param sessionsDir - Root sessions directory (`~/.tallow/sessions/`)
 * @returns Number of files migrated
 */
export function migrateSessionsToPerCwdDirs(sessionsDir: string): number {
	if (!existsSync(sessionsDir)) return 0;

	const flatFiles = readdirSync(sessionsDir).filter(
		(f) => f.endsWith(".jsonl") && statSync(join(sessionsDir, f)).isFile()
	);

	if (flatFiles.length === 0) return 0;

	let migrated = 0;

	for (const file of flatFiles) {
		const filePath = join(sessionsDir, file);
		let targetDir: string;

		try {
			const content = readFileSync(filePath, "utf-8");
			const firstNewline = content.indexOf("\n");
			const headerLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
			const header = JSON.parse(headerLine);

			if (header.type === "session" && typeof header.cwd === "string" && header.cwd) {
				targetDir = join(sessionsDir, encodeSessionDirName(header.cwd));
			} else {
				targetDir = join(sessionsDir, "--unknown--");
			}
		} catch {
			targetDir = join(sessionsDir, "--unknown--");
		}

		if (!existsSync(targetDir)) {
			mkdirSync(targetDir, { recursive: true });
		}

		renameSync(filePath, join(targetDir, file));
		migrated++;
	}

	if (migrated > 0) {
		console.error(
			`Migrated ${migrated} session${migrated === 1 ? "" : "s"} to per-project directories.`
		);
	}

	return migrated;
}
