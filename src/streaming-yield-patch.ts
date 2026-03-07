/**
 * Monkey-patch EventStream async iteration to yield to I/O periodically.
 *
 * During high-frequency LLM streaming (especially chatty models like GPT-5.4),
 * the EventStream's async iterator drains buffered events entirely through
 * microtask resolution. Because microtasks always run before Node.js polls
 * for I/O, stdin data events cannot fire — making the editor appear frozen.
 *
 * This patch wraps `EventStream.prototype[Symbol.asyncIterator]` so that
 * every N events it yields to the event loop via `setImmediate`, allowing
 * stdin (and other I/O) to be serviced between event processing bursts.
 *
 * @see Plan 176 — Input still blocked during streaming (Layer 2)
 * @see Plan 171 — TUI render scheduling fix (Layer 1, predecessor)
 */

const APPLY_FLAG = "__tallow_streaming_yield_patch_applied__";

/**
 * Number of events to process before yielding to I/O.
 *
 * Lower = more responsive input, slightly choppier streaming display.
 * Higher = smoother streaming, longer potential input starvation windows.
 *
 * Configurable via `TALLOW_STREAM_YIELD_INTERVAL` env var for debugging.
 *
 * Default 8: yields every ~8 tokens, giving stdin a chance to fire at
 * roughly 120Hz+ even at high token rates. Visually imperceptible.
 */
const DEFAULT_YIELD_INTERVAL = 8;

/**
 * Promise that resolves on the next check phase, after I/O polling.
 *
 * @returns Promise that yields to the event loop
 */
function yieldToIO(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Parse the yield interval from environment or return the default.
 *
 * @returns Number of events between I/O yields
 */
function getYieldInterval(): number {
	const envVal = process.env.TALLOW_STREAM_YIELD_INTERVAL;
	if (!envVal) return DEFAULT_YIELD_INTERVAL;
	const parsed = Number.parseInt(envVal, 10);
	if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_YIELD_INTERVAL;
	return parsed;
}

/**
 * Applies the streaming yield patch to EventStream from `@mariozechner/pi-ai`.
 *
 * Wraps `EventStream.prototype[Symbol.asyncIterator]` to insert periodic
 * `setImmediate` yields when draining buffered events. This breaks the
 * microtask chain that prevents stdin from being serviced during streaming.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @returns Nothing
 */
export async function applyStreamingYieldPatch(): Promise<void> {
	const globals = globalThis as Record<string, unknown>;
	if (globals[APPLY_FLAG] === true) return;

	try {
		const mod = (await import("@mariozechner/pi-ai")) as unknown as {
			EventStream?: {
				prototype?: Record<string | symbol, unknown>;
			};
		};

		const prototype = mod.EventStream?.prototype;
		if (!prototype) return;

		patchEventStreamPrototype(prototype);
		globals[APPLY_FLAG] = true;
	} catch {
		// Non-fatal: patching is a runtime optimization.
	}
}

/**
 * Patches the EventStream prototype to yield to I/O during iteration.
 *
 * @param prototype - EventStream prototype object
 * @returns Nothing
 */
export function patchEventStreamPrototype(prototype: Record<string | symbol, unknown>): void {
	const original = prototype[Symbol.asyncIterator];
	if (typeof original !== "function") return;

	const yieldInterval = getYieldInterval();

	prototype[Symbol.asyncIterator] = function (
		this: AsyncIterable<unknown>
	): AsyncIterableIterator<unknown> {
		const sourceIterator = (original as () => AsyncIterableIterator<unknown>).call(this);
		let count = 0;

		return {
			async next(): Promise<IteratorResult<unknown>> {
				const result = await sourceIterator.next();
				if (!result.done) {
					count++;
					if (count % yieldInterval === 0) {
						await yieldToIO();
					}
				}
				return result;
			},

			async return(value?: unknown): Promise<IteratorResult<unknown>> {
				return sourceIterator.return?.(value) ?? { value: undefined, done: true };
			},

			[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
				return this;
			},
		};
	};
}
