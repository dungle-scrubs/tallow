import { describe, expect, it } from "bun:test";
import { patchEventStreamPrototype } from "../streaming-yield-patch.js";

/**
 * Minimal EventStream mock that reproduces the upstream iteration pattern.
 *
 * When queue has buffered items, the async iterator yields them immediately
 * (via microtask resolution). This is the pattern that causes stdin starvation
 * when events arrive in bursts during LLM streaming.
 */
class FakeEventStream {
	private queue: unknown[] = [];
	private waiting: Array<(result: IteratorResult<unknown>) => void> = [];
	private done = false;

	/**
	 * Push an event to the stream. Delivers to a waiting consumer or buffers.
	 *
	 * @param event - Event to push
	 * @returns Nothing
	 */
	push(event: unknown): void {
		if (this.done) return;
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/**
	 * Mark the stream as complete.
	 *
	 * @returns Nothing
	 */
	end(): void {
		this.done = true;
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift();
			waiter?.({ value: undefined, done: true });
		}
	}

	/**
	 * Async iterator that drains the queue, matching upstream EventStream behavior.
	 *
	 * @returns Async iterator over stream events
	 */
	async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift();
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<unknown>>((resolve) =>
					this.waiting.push(resolve)
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}
}

/**
 * Yield until the next I/O phase.
 *
 * Uses `setTimeout(0)` because on Bun `setImmediate` never enters the
 * I/O poll phase. This matches the yield mechanism used by the patched code.
 *
 * @returns Promise that resolves after I/O polling
 */
function flushIO(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("patchEventStreamPrototype", () => {
	it("yields to I/O every N events when draining buffered queue", async () => {
		// Use a small interval for testing
		const originalEnv = process.env.TALLOW_STREAM_YIELD_INTERVAL;
		process.env.TALLOW_STREAM_YIELD_INTERVAL = "4";

		try {
			const proto = FakeEventStream.prototype as Record<string | symbol, unknown>;
			patchEventStreamPrototype(proto);

			const stream = new FakeEventStream();

			// Pre-buffer 12 events (simulates burst of LLM tokens)
			for (let i = 0; i < 12; i++) {
				stream.push({ type: "message_update", index: i });
			}
			stream.end();

			// Track when I/O callbacks fire relative to event processing
			let ioYieldCount = 0;
			const eventIndices: number[] = [];

			// Set up I/O yield detection: schedule a setTimeout(0) that
			// will fire whenever the event loop enters the I/O poll phase.
			// On Bun, setImmediate never triggers I/O, so we must use setTimeout.
			const detectYields = (): void => {
				setTimeout(() => {
					ioYieldCount++;
					// Keep detecting until stream is fully consumed
					if (eventIndices.length < 12) detectYields();
				}, 0);
			};
			detectYields();

			// Consume all events
			for await (const event of stream) {
				eventIndices.push((event as { index: number }).index);
			}

			// All 12 events should have been consumed
			expect(eventIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

			// Wait for any remaining I/O callbacks
			await flushIO();
			await flushIO();

			// With interval=4 and 12 events, we expect yields at events 4, 8, 12 = 3 yields.
			// The I/O yield detector should have fired at least during those windows.
			expect(ioYieldCount).toBeGreaterThanOrEqual(2);
		} finally {
			process.env.TALLOW_STREAM_YIELD_INTERVAL = originalEnv;
		}
	});

	it("does not delay events when queue drains one at a time", async () => {
		const originalEnv = process.env.TALLOW_STREAM_YIELD_INTERVAL;
		process.env.TALLOW_STREAM_YIELD_INTERVAL = "4";

		try {
			const proto = FakeEventStream.prototype as Record<string | symbol, unknown>;
			patchEventStreamPrototype(proto);

			const stream = new FakeEventStream();
			const events: number[] = [];

			// Consumer starts waiting before any events arrive
			const consumer = (async () => {
				for await (const event of stream) {
					events.push((event as { index: number }).index);
				}
			})();

			// Push events one at a time with I/O yields between them
			for (let i = 0; i < 6; i++) {
				stream.push({ type: "message_update", index: i });
				await flushIO();
			}
			stream.end();
			await consumer;

			// All events consumed
			expect(events).toEqual([0, 1, 2, 3, 4, 5]);
		} finally {
			process.env.TALLOW_STREAM_YIELD_INTERVAL = originalEnv;
		}
	});

	it("preserves event ordering", async () => {
		const originalEnv = process.env.TALLOW_STREAM_YIELD_INTERVAL;
		process.env.TALLOW_STREAM_YIELD_INTERVAL = "2";

		try {
			const proto = FakeEventStream.prototype as Record<string | symbol, unknown>;
			patchEventStreamPrototype(proto);

			const stream = new FakeEventStream();

			// Buffer events of different types
			stream.push({ type: "message_start", i: 0 });
			stream.push({ type: "message_update", i: 1 });
			stream.push({ type: "message_update", i: 2 });
			stream.push({ type: "tool_execution_start", i: 3 });
			stream.push({ type: "message_end", i: 4 });
			stream.end();

			const order: number[] = [];
			for await (const event of stream) {
				order.push((event as { i: number }).i);
			}

			expect(order).toEqual([0, 1, 2, 3, 4]);
		} finally {
			process.env.TALLOW_STREAM_YIELD_INTERVAL = originalEnv;
		}
	});

	it("return() on the patched iterator terminates cleanly", async () => {
		const originalEnv = process.env.TALLOW_STREAM_YIELD_INTERVAL;
		process.env.TALLOW_STREAM_YIELD_INTERVAL = "4";

		try {
			const proto = FakeEventStream.prototype as Record<string | symbol, unknown>;
			patchEventStreamPrototype(proto);

			const stream = new FakeEventStream();
			stream.push({ i: 0 });
			stream.push({ i: 1 });
			stream.push({ i: 2 });

			const events: number[] = [];
			for await (const event of stream) {
				events.push((event as { i: number }).i);
				if (events.length === 2) break; // triggers return()
			}

			expect(events).toEqual([0, 1]);
		} finally {
			process.env.TALLOW_STREAM_YIELD_INTERVAL = originalEnv;
		}
	});
});
