/** Prefix used for machine-readable startup timing lines in stderr output. */
export const STARTUP_TIMING_PREFIX = "TALLOW_STARTUP_TIMING";

/** Env var controlling startup timing emission. */
const STARTUP_TIMING_ENV = "TALLOW_STARTUP_TIMING";

/** String values that disable startup timing when set in the env var. */
const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * Check whether startup timing instrumentation is enabled.
 *
 * @returns True when timing output should be emitted
 */
export function isStartupTimingEnabled(): boolean {
	const raw = process.env[STARTUP_TIMING_ENV];
	if (!raw) return false;
	return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Round milliseconds for concise, stable output.
 *
 * @param milliseconds - Raw elapsed duration
 * @returns Duration rounded to 3 decimal places
 */
function roundMilliseconds(milliseconds: number): number {
	return Math.round(milliseconds * 1000) / 1000;
}

/**
 * Emit a startup timing sample to stderr.
 *
 * Format:
 * `TALLOW_STARTUP_TIMING {"metric":"...","milliseconds":...}`
 *
 * @param metric - Metric key
 * @param milliseconds - Duration in milliseconds
 * @param metadata - Additional JSON-safe metadata
 * @returns Nothing
 */
export function emitStartupTiming(
	metric: string,
	milliseconds: number,
	metadata: Record<string, unknown> = {}
): void {
	if (!isStartupTimingEnabled()) {
		return;
	}

	const payload = {
		metric,
		milliseconds: roundMilliseconds(milliseconds),
		ts: new Date().toISOString(),
		...metadata,
	};

	process.stderr.write(`${STARTUP_TIMING_PREFIX} ${JSON.stringify(payload)}\n`);
}
