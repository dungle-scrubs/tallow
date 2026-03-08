import { describe, expect, it } from "bun:test";
import { cancelIOCallback, scheduleAfterIO, yieldToIO } from "../yield-to-io.js";

describe("yieldToIO", () => {
	it("resolves and allows I/O callbacks to fire", async () => {
		let ioFired = false;

		// Schedule an I/O callback via setTimeout (known to work on Bun)
		setTimeout(() => {
			ioFired = true;
		}, 0);

		// yieldToIO should allow the I/O callback to fire
		await yieldToIO();
		// Give a second tick for the I/O to propagate
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(ioFired).toBe(true);
	});

	it("does not block indefinitely", async () => {
		const start = Date.now();
		await yieldToIO();
		const elapsed = Date.now() - start;

		// Should resolve in under 50ms (typically ~1ms)
		expect(elapsed).toBeLessThan(50);
	});
});

describe("scheduleAfterIO", () => {
	it("executes the callback after I/O polling", async () => {
		let called = false;
		scheduleAfterIO(() => {
			called = true;
		});

		// Callback should not fire synchronously
		expect(called).toBe(false);

		// Wait for I/O cycle
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		expect(called).toBe(true);
	});

	it("can be cancelled with cancelIOCallback", async () => {
		let called = false;
		const handle = scheduleAfterIO(() => {
			called = true;
		});

		cancelIOCallback(handle);

		// Wait long enough for the callback to have fired if not cancelled
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(called).toBe(false);
	});
});

describe("cancelIOCallback", () => {
	it("handles undefined gracefully", () => {
		// Should not throw
		cancelIOCallback(undefined);
	});
});
