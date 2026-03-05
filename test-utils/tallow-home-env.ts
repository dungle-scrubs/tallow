let envMutationQueue: Promise<void> = Promise.resolve();

/**
 * Run an async operation with `TALLOW_HOME` set exclusively for that operation.
 *
 * Tests run concurrently in Bun workers. Mutating process-wide env vars without
 * serialization causes cross-test races where sessions inherit the wrong home.
 *
 * @param home - TALLOW_HOME value for the wrapped operation
 * @param run - Async operation to execute while TALLOW_HOME is set
 * @returns Result from the wrapped operation
 */
export async function withExclusiveTallowHome<T>(home: string, run: () => Promise<T>): Promise<T> {
	let releaseQueue: (() => void) | undefined;
	const current = new Promise<void>((resolve) => {
		releaseQueue = resolve;
	});
	const previousQueue = envMutationQueue;
	envMutationQueue = previousQueue.then(() => current);
	await previousQueue;

	const originalHome = process.env.TALLOW_HOME;
	process.env.TALLOW_HOME = home;

	try {
		return await run();
	} finally {
		if (originalHome !== undefined) {
			process.env.TALLOW_HOME = originalHome;
		} else {
			delete process.env.TALLOW_HOME;
		}
		releaseQueue?.();
	}
}
