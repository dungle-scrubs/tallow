let sessionRunQueue: Promise<void> = Promise.resolve();

/**
 * Serialize prompt executions across test sessions.
 *
 * Some integration tests rely on global channels and process-level state that
 * can race when multiple sessions run prompts concurrently in parallel workers.
 * Running prompts one-at-a-time keeps event sequencing deterministic.
 *
 * @param run - Async prompt execution block
 * @returns Result from the prompt block
 */
export async function withExclusiveSessionRun<T>(run: () => Promise<T>): Promise<T> {
	let releaseQueue: (() => void) | undefined;
	const current = new Promise<void>((resolve) => {
		releaseQueue = resolve;
	});
	const previousQueue = sessionRunQueue;
	sessionRunQueue = previousQueue.then(() => current);
	await previousQueue;
	try {
		return await run();
	} finally {
		releaseQueue?.();
	}
}
