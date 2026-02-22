/** Prefix used for machine-readable startup timing lines in stderr output. */
const STARTUP_TIMING_PREFIX = "TALLOW_STARTUP_TIMING";

/** Env var controlling startup timing emission. */
const STARTUP_TIMING_ENV = "TALLOW_STARTUP_TIMING";

/** String values that disable startup timing when set in the env var. */
const DISABLED_TIMING_VALUES = new Set(["0", "false", "off", "no"]);

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
}

/** One-time lazy initializer with in-flight dedupe. */
export interface LazyInitializer<TContext> {
	/**
	 * Run initialization if needed.
	 *
	 * - First caller executes initialize().
	 * - Concurrent callers await the same in-flight promise.
	 * - After success, all callers resolve immediately.
	 * - After failure, future callers retry.
	 *
	 * @param input - Trigger + context payload for initialization
	 * @returns Promise resolved when initialization is complete
	 */
	ensureInitialized(input: LazyInitInput<TContext>): Promise<void>;
	/**
	 * Reset completion state so the next ensureInitialized() call reruns init.
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
 * Create a race-safe lazy initializer with one-time execution semantics.
 *
 * @param options - Initializer configuration
 * @returns Lazy initializer controller
 */
export function createLazyInitializer<TContext>(
	options: LazyInitializerOptions<TContext>
): LazyInitializer<TContext> {
	let initialized = false;
	let inFlight: Promise<void> | null = null;

	const runInitialization = async (input: LazyInitInput<TContext>): Promise<void> => {
		const startedAtMs = performance.now();
		try {
			await options.initialize(input);
			initialized = true;
			emitLazyInitTiming(options.name, input.trigger, performance.now() - startedAtMs, "ok");
		} catch (error) {
			const normalized = toError(error);
			initialized = false;
			emitLazyInitTiming(
				options.name,
				input.trigger,
				performance.now() - startedAtMs,
				"error",
				normalized
			);
			throw normalized;
		}
	};

	return {
		ensureInitialized(input: LazyInitInput<TContext>): Promise<void> {
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
		},
		isInitialized(): boolean {
			return initialized;
		},
	};
}
