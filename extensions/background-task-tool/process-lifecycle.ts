import type { ChildProcess } from "node:child_process";

/** Result emitted when a managed child process completes or is interrupted. */
export type ProcessLifecycleResult =
	| { type: "close"; code: number | null }
	| { type: "error"; error: Error }
	| { type: "aborted" }
	| { type: "timeout" };

/** Options for process lifecycle management. */
export interface ProcessLifecycleOptions {
	readonly child: ChildProcess;
	readonly onAbort?: () => void;
	readonly onData?: (chunk: Buffer) => void;
	readonly onTimeout?: () => void;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

/** Handle for interacting with a managed process lifecycle. */
export interface ProcessLifecycleHandle {
	/** Detach the child from the parent event loop when supported. */
	detach(): void;
	/** Await process completion/termination outcome. */
	waitForExit(): Promise<ProcessLifecycleResult>;
}

/**
 * Normalize unknown error-like values into Error instances.
 *
 * @param value - Unknown thrown or emitted error value
 * @returns Normalized Error instance
 */
function toError(value: unknown): Error {
	if (value instanceof Error) {
		return value;
	}
	if (typeof value === "string") {
		return new Error(value);
	}
	return new Error(String(value));
}

/**
 * Normalize stream chunks to Buffer values.
 *
 * @param chunk - Stream chunk value
 * @returns Buffer representation of the chunk
 */
function toBuffer(chunk: Buffer | string): Buffer {
	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/**
 * Manage child process lifecycle events with deterministic single settlement.
 *
 * Handles stream wiring, timeout/abort transitions, and listener cleanup.
 * The first terminal event wins; later events are ignored.
 *
 * @param options - Lifecycle options and callbacks
 * @returns Lifecycle handle for detach + completion await
 */
export function createProcessLifecycle(options: ProcessLifecycleOptions): ProcessLifecycleHandle {
	const { child, onAbort, onData, onTimeout, signal, timeoutMs } = options;

	let settled = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	let resolveWait: (result: ProcessLifecycleResult) => void;

	const onStdout = (chunk: Buffer | string) => {
		onData?.(toBuffer(chunk));
	};
	const onStderr = (chunk: Buffer | string) => {
		onData?.(toBuffer(chunk));
	};

	const removeDataListeners = () => {
		child.stdout?.removeListener("data", onStdout);
		child.stderr?.removeListener("data", onStderr);
	};

	const cleanup = () => {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
			timeoutHandle = undefined;
		}
		if (signal && abortHandler) {
			signal.removeEventListener("abort", abortHandler);
		}
		removeDataListeners();
		child.removeListener("close", closeHandler);
		child.removeListener("error", errorHandler);
	};

	const settle = (result: ProcessLifecycleResult): void => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		resolveWait(result);
	};

	const closeHandler = (code: number | null) => {
		settle({ type: "close", code });
	};
	const errorHandler = (error: unknown) => {
		settle({ type: "error", error: toError(error) });
	};

	const abortHandler = () => {
		onAbort?.();
		settle({ type: "aborted" });
		try {
			child.kill("SIGTERM");
		} catch {
			// Process may already be gone.
		}
	};

	const waitForExit = new Promise<ProcessLifecycleResult>((resolve) => {
		resolveWait = resolve;
	});

	child.stdout?.on("data", onStdout);
	child.stderr?.on("data", onStderr);
	child.on("close", closeHandler);
	child.on("error", errorHandler);

	if (signal?.aborted) {
		abortHandler();
	} else if (signal) {
		signal.addEventListener("abort", abortHandler);
	}

	if (typeof timeoutMs === "number" && timeoutMs > 0) {
		timeoutHandle = setTimeout(() => {
			onTimeout?.();
			settle({ type: "timeout" });
			try {
				child.kill("SIGTERM");
			} catch {
				// Process may already be gone.
			}
		}, timeoutMs);
	}

	const exitedWithCode = typeof child.exitCode === "number";
	const exitedBySignal = child.signalCode != null;
	if (exitedWithCode || exitedBySignal) {
		settle({ type: "close", code: exitedWithCode ? child.exitCode : null });
	}

	return {
		detach(): void {
			if (typeof child.unref === "function") {
				child.unref();
			}
		},
		waitForExit(): Promise<ProcessLifecycleResult> {
			return waitForExit;
		},
	};
}
