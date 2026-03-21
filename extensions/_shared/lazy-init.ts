/** Prefix used for machine-readable startup timing lines in stderr output. */
const STARTUP_TIMING_PREFIX = "TALLOW_STARTUP_TIMING";

/** Env var controlling startup timing emission. */
const STARTUP_TIMING_ENV = "TALLOW_STARTUP_TIMING";

/** String values that disable startup timing when set in the env var. */
const DISABLED_TIMING_VALUES = new Set(["0", "false", "off", "no"]);

/** Maximum backoff delay in milliseconds regardless of failure count. */
const MAX_BACKOFF_MS = 30_000;

/** Initialization outcome used in timing metadata. */
type LazyInitStatus = "ok" | "error";

/** Input payload for a lazy initializer run. */
export interface LazyInitInput<TContext> {
	readonly trigger: string;
	readonly context: TContext;
}

/** Configuration for creating a lazy initializer. */
export interface LazyInitializerOptions<TContext> {
	/** Human-readable extension name used in timing logs. */
	readonly name: string;
	/** One-time async initializer invoked on first use. */
	readonly initialize: (input: LazyInitInput<TContext>) => Promise<void>;
	/**
	 * Maximum number of consecutive failures before the initializer is permanently
	 * failed. Once exhausted, `ensureInitialized()` rejects immediately without
	 * attempting initialization again. Defaults to 3.
	 */
	readonly maxRetries?: number;
	/**
	 * Base delay in milliseconds used for exponential backoff between retries.
	 * When a retry is attempted, the remaining portion of `retryBackoffMs * 2^(failureCount - 1)`
	 * (capped at 30 seconds) is waited before running `initialize`. Defaults to 1000.
	 */
	readonly retryBackoffMs?: number;
}

/** One-time lazy initializer with in-flight dedupe and circuit-breaker. */
export interface LazyInitializer<TContext> {
	/**
	 * Run initialization if needed.
	 *
	 * - First caller executes initialize().
	 * - Concurrent callers await the same in-flight promise.
	 * - After success, all callers resolve immediately.
	 * - After failure, future callers retry (respecting backoff).
	 * - After `maxRetries` consecutive failures, rejects immediately with the last
	 *   error and makes no further attempts until `reset()` is called.
	 *
	 * @param input - Trigger + context payload for initialization
	 * @returns Promise resolved when initialization is complete
	 */
	ensureInitialized(input: LazyInitInput<TContext>): Promise<void>;
	/**
	 * Reset completion state so the next ensureInitialized() call reruns init.
	 * Also resets the consecutive failure counter, the backoff clock, and any
	 * permanent failure state, allowing retries to begin again from scratch.
	 * Does not cancel an in-flight initialization.
	 *
	 * @returns Nothing
	 */
	reset(): void;
	/**
	 * Check whether initialization has completed successfully.
	 *
	 * @returns True when initialized
	 */
	isInitialized(): boolean;
	/**
	 * Check whether the initializer has permanently failed after exhausting all
	 * retries. When true, `ensureInitialized()` rejects immediately without making
	 * any further initialization attempts. Call `reset()` to clear this state.
	 *
	 * @returns True when permanently failed
	 */
	isPermanentlyFailed(): boolean;
}

/**
 * Check whether startup timing instrumentation is enabled.
 *
 * @returns True when timing output should be emitted
 */
function isStartupTimingEnabled(): boolean {
	const raw = process.env[STARTUP_TIMING_ENV];
	if (!raw) return false;
	return !DISABLED_TIMING_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Round milliseconds for concise, stable output.
 *
 * @param milliseconds - Raw elapsed duration
 * @returns Milliseconds rounded to 3 decimal places
 */
function roundMilliseconds(milliseconds: number): number {
	return Math.round(milliseconds * 1000) / 1000;
}

/**
 * Convert an unknown thrown value into an Error instance.
 *
 * @param value - Unknown thrown value
 * @returns Error instance with best-effort message
 */
function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * Emit a startup timing sample for lazy extension initialization.
 *
 * @param extension - Extension name
 * @param trigger - Trigger source for initialization
 * @param milliseconds - Elapsed initialization time
 * @param status - Success/error status
 * @param error - Optional error for failure metadata
 * @returns Nothing
 */
function emitLazyInitTiming(
	extension: string,
	trigger: string,
	milliseconds: number,
	status: LazyInitStatus,
	error?: Error
): void {
	if (!isStartupTimingEnabled()) {
		return;
	}

	const payload: Record<string, unknown> = {
		metric: "extension_lazy_init",
		extension,
		trigger,
		status,
		milliseconds: roundMilliseconds(milliseconds),
		ts: new Date().toISOString(),
	};

	if (error) {
		payload.error = error.message;
	}

	process.stderr.write(`${STARTUP_TIMING_PREFIX} ${JSON.stringify(payload)}\n`);
}

/**
 * Create a race-safe lazy initializer with one-time execution semantics,
 * exponential backoff between retries, and a circuit-breaker that permanently
 * fails after `maxRetries` consecutive failures.
 *
 * Each call to `ensureInitialized` is a single attempt. On failure the promise
 * rejects immediately, but the next caller will wait out the remaining backoff
 * window before running `initialize` again.
 *
 * @param options - Initializer configuration
 * @returns Lazy initializer controller
 */
export function createLazyInitializer<TContext>(
	options: LazyInitializerOptions<TContext>
): LazyInitializer<TContext> {
	const maxRetries = options.maxRetries ?? 3;
	const retryBackoffMs = options.retryBackoffMs ?? 1000;

	let initialized = false;
	let inFlight: Promise<void> | null = null;
	let failureCount = 0;
	let permanentError: Error | null = null;
	/** Timestamp (via performance.now) of the most recent failure, or null. */
	let lastFailureTimeMs: number | null = null;

	/**
	 * Compute how many milliseconds remain in the current backoff window.
	 * Returns 0 when no backoff is needed (first call or backoff already elapsed).
	 *
	 * @returns Remaining backoff delay in milliseconds
	 */
	const remainingBackoffMs = (): number => {
		if (failureCount === 0 || lastFailureTimeMs === null) return 0;
		const totalBackoff = Math.min(retryBackoffMs * 2 ** (failureCount - 1), MAX_BACKOFF_MS);
		const elapsed = performance.now() - lastFailureTimeMs;
		return Math.max(0, totalBackoff - elapsed);
	};

	/**
	 * Execute one initialization attempt. Waits out any remaining backoff from
	 * the previous failure before calling `initialize`. Timing is measured over
	 * the `initialize` call only (backoff wait is excluded). On success, resets
	 * the failure counter. On failure, increments it and sets `permanentError`
	 * once `maxRetries` is exhausted.
	 *
	 * @param input - Trigger + context payload
	 * @returns Promise that resolves on success or rejects with a normalized Error
	 */
	const runInitialization = async (input: LazyInitInput<TContext>): Promise<void> => {
		// Wait out remaining backoff from the previous failure before attempting.
		const backoff = remainingBackoffMs();
		if (backoff > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, backoff));
		}

		const startedAtMs = performance.now();
		try {
			await options.initialize(input);
			initialized = true;
			failureCount = 0;
			lastFailureTimeMs = null;
			emitLazyInitTiming(options.name, input.trigger, performance.now() - startedAtMs, "ok");
		} catch (error) {
			const normalized = toError(error);
			initialized = false;
			failureCount++;
			lastFailureTimeMs = performance.now();
			emitLazyInitTiming(
				options.name,
				input.trigger,
				performance.now() - startedAtMs,
				"error",
				normalized
			);
			if (failureCount >= maxRetries) {
				permanentError = normalized;
			}
			throw normalized;
		}
	};

	return {
		ensureInitialized(input: LazyInitInput<TContext>): Promise<void> {
			if (permanentError) {
				return Promise.reject(permanentError);
			}
			if (initialized) {
				return Promise.resolve();
			}
			if (inFlight) {
				return inFlight;
			}

			inFlight = runInitialization(input).finally(() => {
				inFlight = null;
			});
			return inFlight;
		},
		reset(): void {
			initialized = false;
			failureCount = 0;
			permanentError = null;
			lastFailureTimeMs = null;
		},
		isInitialized(): boolean {
			return initialized;
		},
		isPermanentlyFailed(): boolean {
			return permanentError !== null;
		},
	};
}
