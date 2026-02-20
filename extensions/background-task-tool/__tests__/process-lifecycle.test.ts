import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createProcessLifecycle } from "../process-lifecycle.js";

/**
 * Minimal spawn-compatible fake child process for lifecycle tests.
 */
class FakeLifecycleChild extends EventEmitter {
	readonly stderr = new PassThrough();
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	pid = 77_123;
	killCount = 0;
	unrefCount = 0;

	/**
	 * Simulate process kill and emit close.
	 *
	 * @returns Always true
	 */
	kill(): boolean {
		this.killCount += 1;
		this.emit("close", null);
		return true;
	}

	/**
	 * Track detach calls.
	 *
	 * @returns This child instance
	 */
	unref(): this {
		this.unrefCount += 1;
		return this;
	}
}

/**
 * Child-process fake intentionally lacking `unref`.
 */
class FakeChildWithoutUnref extends EventEmitter {
	readonly stderr = new PassThrough();
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	pid = 11_222;

	/**
	 * Simulate process kill and emit close.
	 *
	 * @returns Always true
	 */
	kill(): boolean {
		this.emit("close", null);
		return true;
	}
}

describe("process lifecycle helper", () => {
	it("captures output and resolves close events", async () => {
		const child = new FakeLifecycleChild();
		const chunks: string[] = [];
		const lifecycle = createProcessLifecycle({
			child: child as unknown as ChildProcess,
			onData: (chunk) => chunks.push(chunk.toString()),
		});

		child.stdout.write("hello");
		child.stdout.write(" world");
		child.emit("close", 0);

		const result = await lifecycle.waitForExit();
		expect(result).toEqual({ type: "close", code: 0 });
		expect(chunks.join("")).toBe("hello world");
	});

	it("detach is safe when child has no unref method", () => {
		const child = new FakeChildWithoutUnref();
		const lifecycle = createProcessLifecycle({
			child: child as unknown as ChildProcess,
		});

		expect(() => lifecycle.detach()).not.toThrow();
	});

	it("resolves timeout once and kills process", async () => {
		const child = new FakeLifecycleChild();
		const lifecycle = createProcessLifecycle({
			child: child as unknown as ChildProcess,
			timeoutMs: 5,
		});

		const result = await lifecycle.waitForExit();
		expect(result).toEqual({ type: "timeout" });
		expect(child.killCount).toBe(1);
	});

	it("resolves abort once and kills process", async () => {
		const child = new FakeLifecycleChild();
		const controller = new AbortController();
		const lifecycle = createProcessLifecycle({
			child: child as unknown as ChildProcess,
			signal: controller.signal,
		});

		controller.abort();
		const result = await lifecycle.waitForExit();
		expect(result).toEqual({ type: "aborted" });
		expect(child.killCount).toBe(1);
	});

	it("settles only once when error and close race", async () => {
		const child = new FakeLifecycleChild();
		const lifecycle = createProcessLifecycle({
			child: child as unknown as ChildProcess,
		});

		child.emit("error", new Error("boom"));
		child.emit("close", 0);

		const result = await lifecycle.waitForExit();
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.error.message).toBe("boom");
		}
	});
});
