import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

interface FakeChildProcessOptions {
	readonly onKill?: () => void;
}

/**
 * Spawn-compatible fake child process for deterministic tests.
 */
export class FakeChildProcess extends EventEmitter {
	readonly stderr = new PassThrough();
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();

	private killed = false;

	constructor(private readonly options?: FakeChildProcessOptions) {
		super();
	}

	/**
	 * Simulate process termination.
	 *
	 * @param _signal - Optional signal (ignored in fake implementation)
	 * @returns Always true
	 */
	kill(_signal?: NodeJS.Signals | number): boolean {
		if (this.killed) {
			return true;
		}
		this.killed = true;
		this.options?.onKill?.();
		this.emit("exit", null);
		this.emit("close", 0);
		return true;
	}

	/**
	 * Compatibility no-op matching Node child process API.
	 *
	 * @returns This instance
	 */
	ref(): this {
		return this;
	}

	/**
	 * Compatibility no-op matching Node child process API.
	 *
	 * @returns This instance
	 */
	unref(): this {
		return this;
	}

	/**
	 * Emit a close event with a specific exit code.
	 *
	 * @param code - Exit code for the close event
	 * @returns Nothing
	 */
	emitClose(code: number): void {
		this.emit("close", code);
	}

	/**
	 * Emit an error event with a normalized Error value.
	 *
	 * @param error - Error-like value to emit
	 * @returns Nothing
	 */
	emitError(error: unknown): void {
		const normalized =
			error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
		this.emit("error", normalized);
	}
}
