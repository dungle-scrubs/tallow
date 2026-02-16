import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Options for atomic file writes.
 */
interface AtomicWriteOptions {
	/** File encoding (defaults to "utf-8"). */
	encoding?: BufferEncoding;
	/** File permission mode (e.g., 0o600 for restricted access). */
	mode?: number;
	/** Whether to fsync the temp file before rename for durability. */
	fsync?: boolean;
	/** Whether to create a `.bak` backup of the existing file before overwriting. */
	backup?: boolean;
}

/**
 * Generate a short random suffix for temp file names.
 *
 * @returns 8-character hex string
 */
function randomSuffix(): string {
	return Math.random().toString(16).slice(2, 10);
}

/**
 * Atomically write data to a file using write-tmp-then-rename.
 *
 * Creates a temp file in the same directory as the target (ensuring same
 * filesystem for atomic rename), writes data to it, optionally fsyncs,
 * then renames over the target. If anything fails, the temp file is
 * cleaned up and the original file is untouched.
 *
 * @param filePath - Target file path
 * @param data - Content to write
 * @param options - Encoding, mode, fsync, and backup options
 * @throws {Error} When the write or rename fails (after cleanup)
 */
export function atomicWriteFileSync(
	filePath: string,
	data: string | Buffer,
	options?: AtomicWriteOptions
): void {
	const dir = dirname(filePath);
	const base = basename(filePath);
	const tmpPath = join(dir, `.${base}.${randomSuffix()}.tmp`);
	const encoding = options?.encoding ?? "utf-8";

	// Backup existing file before overwriting
	if (options?.backup && existsSync(filePath)) {
		backupFileSync(filePath);
	}

	try {
		writeFileSync(tmpPath, data, { encoding, mode: options?.mode });

		if (options?.fsync) {
			const fd = openSync(tmpPath, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}

		renameSync(tmpPath, filePath);
	} catch (err) {
		// Clean up temp file on failure
		try {
			unlinkSync(tmpPath);
		} catch {
			// Temp file may not exist if writeFileSync failed before creating it
		}
		throw err;
	}
}

/**
 * Create a `.bak` copy of a file. Overwrites any existing backup.
 * The backup itself is written atomically.
 *
 * @param filePath - File to back up
 */
function backupFileSync(filePath: string): void {
	const bakPath = `${filePath}.bak`;
	const tmpBak = `${bakPath}.${randomSuffix()}.tmp`;

	try {
		copyFileSync(filePath, tmpBak);
		renameSync(tmpBak, bakPath);
	} catch {
		try {
			unlinkSync(tmpBak);
		} catch {
			// Best-effort cleanup
		}
		// Don't fail the main write if backup fails
	}
}

/**
 * Attempt to restore a file from its `.bak` backup.
 *
 * Call this on startup when a config file is missing or corrupt.
 * Returns true if restoration succeeded, false if no backup existed
 * or the backup was also corrupt.
 *
 * @param filePath - Target file path to restore
 * @param validate - Optional validator (e.g., JSON.parse) to verify backup integrity
 * @returns Whether the file was successfully restored
 */
export function restoreFromBackup(filePath: string, validate?: (content: string) => void): boolean {
	const bakPath = `${filePath}.bak`;

	if (!existsSync(bakPath)) return false;

	try {
		const content = readFileSync(bakPath, "utf-8");

		// If a validator is provided, verify the backup is valid
		if (validate) {
			validate(content);
		}

		// Atomically restore (no backup of the backup)
		atomicWriteFileSync(filePath, content);
		return true;
	} catch {
		return false;
	}
}
