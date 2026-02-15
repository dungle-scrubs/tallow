/**
 * Process-level cleanup handlers for abnormal exits.
 *
 * Handles three scenarios that the TUI's graceful shutdown path doesn't cover:
 * 1. SIGTERM / SIGINT — terminal closed, container stopped, ctrl+c in non-TUI mode
 * 2. EIO on stdout/stderr — terminal disconnected (e.g., tmux pane killed)
 * 3. EPIPE on stdout/stderr — pipe reader closed
 *
 * Fires `session_shutdown` so extensions (MCP adapter, background tasks, LSP)
 * can clean up child processes before exiting.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

/** Guard against re-entrant cleanup (signal + EIO racing). */
let cleaning = false;

/** Maximum time to wait for extension cleanup before force-exiting. */
const CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Emit `session_shutdown` to extensions, then exit.
 *
 * @param session - The active agent session (may be undefined if crash is early)
 * @param exitCode - Process exit code
 */
async function cleanup(session: AgentSession | undefined, exitCode: number): Promise<never> {
	if (cleaning) {
		// Already cleaning — second signal means "force kill now"
		process.exit(exitCode);
	}
	cleaning = true;

	// Hard deadline: if cleanup hangs, force-exit after timeout
	const forceTimer = setTimeout(() => {
		process.exit(exitCode);
	}, CLEANUP_TIMEOUT_MS);
	// Don't let the timer keep the process alive if cleanup finishes first
	forceTimer.unref();

	try {
		const runner = session?.extensionRunner;
		if (runner?.hasHandlers("session_shutdown")) {
			await runner.emit({ type: "session_shutdown" });
		}
	} catch {
		// Best-effort — don't let extension errors prevent exit
	}

	process.exit(exitCode);
}

/**
 * Handle EIO/EPIPE errors on a writable stream.
 *
 * When the controlling terminal disappears (window closed, SSH dropped),
 * Node emits EIO errors on stdout/stderr writes. Without a handler the
 * process hangs because the error is unhandled but not fatal enough for
 * `uncaughtException`.
 *
 * @param stream - The writable stream (stdout or stderr)
 * @param sessionRef - Mutable ref to the current session
 */
function handleStreamError(
	stream: NodeJS.WriteStream,
	sessionRef: { current?: AgentSession }
): void {
	stream.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EIO" || err.code === "EPIPE") {
			void cleanup(sessionRef.current, 1);
		}
		// Other stream errors propagate normally (handled by uncaughtException)
	});
}

/**
 * Register process-level handlers for signals and terminal I/O errors.
 *
 * Call once after CLI argument parsing but before session creation.
 * Pass the returned ref object to `setCleanupSession()` once the session
 * is available.
 *
 * @returns A mutable ref — set `.current` to the active session once created
 */
export function registerProcessCleanup(): { current?: AgentSession } {
	const sessionRef: { current?: AgentSession } = {};

	// ── Signals ──────────────────────────────────────────────────────────────
	// SIGINT: ctrl+c (non-TUI), or parent process group signal
	// SIGTERM: `kill <pid>`, container stop, systemd, etc.
	process.on("SIGINT", () => void cleanup(sessionRef.current, 130));
	process.on("SIGTERM", () => void cleanup(sessionRef.current, 143));

	// ── Terminal I/O errors ──────────────────────────────────────────────────
	handleStreamError(process.stdout, sessionRef);
	handleStreamError(process.stderr, sessionRef);

	return sessionRef;
}
