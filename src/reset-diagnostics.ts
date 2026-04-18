/**
 * Reset diagnostics capture structured reset and deferred-trigger events.
 *
 * Keeps an in-memory ring buffer for tests and optional debug inspection.
 * Production behavior stays quiet unless TALLOW_DEBUG_RESET=1 is set.
 */

const MAX_DIAGNOSTIC_EVENTS = 200;

/** Reset/deferred event emitted during session reset handling. */
export type ResetDiagnosticEvent =
	| {
			readonly kind: "deferred_cancelled";
			readonly reason: string;
			readonly source: string;
			timestamp: number;
	  }
	| {
			readonly kind: "deferred_dropped";
			readonly reason: string;
			readonly source: string;
			timestamp: number;
	  }
	| {
			readonly kind: "deferred_registered";
			readonly source: string;
			timestamp: number;
	  }
	| {
			readonly kind: "reset_complete";
			readonly reason: string;
			timestamp: number;
	  }
	| {
			readonly kind: "reset_start";
			readonly reason: string;
			timestamp: number;
	  };

/** Reset/deferred event input before timestamp attachment. */
export type ResetDiagnosticInput =
	| {
			readonly kind: "deferred_cancelled";
			readonly reason: string;
			readonly source: string;
	  }
	| {
			readonly kind: "deferred_dropped";
			readonly reason: string;
			readonly source: string;
	  }
	| {
			readonly kind: "deferred_registered";
			readonly source: string;
	  }
	| {
			readonly kind: "reset_complete";
			readonly reason: string;
	  }
	| {
			readonly kind: "reset_start";
			readonly reason: string;
	  };

const diagnostics: ResetDiagnosticEvent[] = [];

/**
 * Record one reset diagnostic event.
 *
 * @param event - Structured reset/deferred event
 * @returns Nothing
 */
export function recordResetDiagnostic(event: ResetDiagnosticInput): void {
	const entry: ResetDiagnosticEvent = { ...event, timestamp: Date.now() };
	diagnostics.push(entry);
	if (diagnostics.length > MAX_DIAGNOSTIC_EVENTS) {
		diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTIC_EVENTS);
	}
	if (process.env.TALLOW_DEBUG_RESET === "1") {
		console.error(`[reset] ${JSON.stringify(entry)}`);
	}
}

/**
 * Return a snapshot of the current reset diagnostics for tests.
 *
 * @returns Recorded reset diagnostics
 */
export function getResetDiagnosticsForTests(): readonly ResetDiagnosticEvent[] {
	return [...diagnostics];
}

/**
 * Clear captured reset diagnostics between tests.
 *
 * @returns Nothing
 */
export function resetResetDiagnosticsForTests(): void {
	diagnostics.length = 0;
}
