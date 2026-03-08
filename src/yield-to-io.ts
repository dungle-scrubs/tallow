/**
 * Runtime-adaptive event-loop yield that guarantees I/O polling.
 *
 * On Bun, `setImmediate` behaves like a microtask — it never enters the
 * I/O poll phase, so stdin data callbacks are starved during high-frequency
 * async loops (LLM streaming). `setTimeout(fn, 0)` forces a real timer
 * that lets the I/O phase run first.
 *
 * On Node.js, `setImmediate` has correct check-phase semantics (fires after
 * I/O polling) and avoids the 1ms minimum timer delay of `setTimeout(0)`.
 *
 * @see Plan 177 — Input blocked during streaming (Bun setImmediate)
 * @module
 */

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

/**
 * Yields to the event loop in a way that guarantees I/O polling.
 *
 * - Bun: uses `setTimeout(0)` because `setImmediate`/`Bun.sleep(0)` skip I/O
 * - Node.js: uses `setImmediate` (correct check-phase semantics)
 *
 * @returns Promise that resolves after the I/O poll phase has run
 */
export function yieldToIO(): Promise<void> {
	if (isBun) {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Schedules a callback to run after I/O polling, returning a handle
 * that can be cancelled with {@link cancelIOCallback}.
 *
 * Drop-in replacement for `setImmediate` that works correctly on Bun.
 *
 * @param callback - Function to invoke after I/O yield
 * @returns Opaque handle for cancellation via {@link cancelIOCallback}
 */
export function scheduleAfterIO(callback: () => void): ReturnType<typeof setTimeout> {
	if (isBun) {
		return setTimeout(callback, 0);
	}
	return setImmediate(callback) as unknown as ReturnType<typeof setTimeout>;
}

/**
 * Cancels a callback scheduled by {@link scheduleAfterIO}.
 *
 * @param handle - Handle returned by {@link scheduleAfterIO}
 * @returns Nothing
 */
export function cancelIOCallback(handle: ReturnType<typeof setTimeout> | undefined): void {
	if (handle === undefined) return;
	if (isBun) {
		clearTimeout(handle);
	} else {
		clearImmediate(handle as unknown as ReturnType<typeof setImmediate>);
	}
}
