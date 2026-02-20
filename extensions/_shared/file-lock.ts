import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Options for synchronous file-lock acquisition. */
export interface FileLockOptions {
	/** Human-readable lock label used in error messages. */
	readonly label?: string;
	/** Maximum acquisition attempts before timing out. */
	readonly maxRetries?: number;
	/** Base retry delay in milliseconds. */
	readonly retryBaseMs?: number;
	/** Per-attempt jitter range in milliseconds. */
	readonly retryJitterMs?: number;
	/** Optional stale-lock threshold (ms). Older locks may be reclaimed. */
	readonly staleMs?: number;
}

/**
 * Synchronously sleep for a bounded number of milliseconds.
 *
 * @param ms - Duration in milliseconds
 * @returns Nothing
 */
function sleepSync(ms: number): void {
	const delay = Math.max(0, Math.trunc(ms));
	if (delay === 0) return;
	const shared = new SharedArrayBuffer(4);
	const view = new Int32Array(shared);
	Atomics.wait(view, 0, 0, delay);
}

/**
 * Return true when a lock file is older than the stale threshold.
 *
 * @param lockPath - Lock file path
 * @param staleMs - Stale threshold in milliseconds
 * @returns True when lock appears stale
 */
function isStaleLock(lockPath: string, staleMs: number): boolean {
	try {
		const stats = statSync(lockPath);
		return Date.now() - stats.mtimeMs > staleMs;
	} catch {
		return false;
	}
}

/**
 * Acquire an exclusive lock file and return a release callback.
 *
 * Uses `open(path, "wx")` for atomic lock acquisition. Retries on `EEXIST`
 * with bounded backoff+jitter. Optional stale handling can reclaim locks older
 * than `staleMs`.
 *
 * @param lockPath - Absolute path to lock file
 * @param options - Optional acquisition/retry configuration
 * @returns Release callback to remove the lock file
 * @throws {Error} When lock acquisition times out or fails unexpectedly
 */
export function acquireFileLock(lockPath: string, options?: FileLockOptions): () => void {
	const label = options?.label ?? "file lock";
	const maxRetries = options?.maxRetries ?? 12;
	const retryBaseMs = options?.retryBaseMs ?? 5;
	const retryJitterMs = options?.retryJitterMs ?? 5;
	const staleMs = options?.staleMs;
	const lockDir = dirname(lockPath);

	if (!existsSync(lockDir)) {
		mkdirSync(lockDir, { recursive: true });
	}

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			const fd = openSync(lockPath, "wx");
			closeSync(fd);
			return () => {
				try {
					unlinkSync(lockPath);
				} catch {
					/* lock already removed */
				}
			};
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") {
				throw err;
			}

			if (typeof staleMs === "number" && staleMs > 0 && isStaleLock(lockPath, staleMs)) {
				try {
					unlinkSync(lockPath);
					continue;
				} catch {
					// Another process may have reclaimed/replaced it; fall through to retry delay.
				}
			}

			const jitter = Math.floor(Math.random() * retryJitterMs);
			sleepSync(retryBaseMs + attempt + jitter);
		}
	}

	throw new Error(`${label} busy: ${lockPath}`);
}
