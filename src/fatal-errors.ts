/**
 * Unconditional fatal error handlers for uncaught exceptions and
 * unhandled promise rejections. Registered at CLI startup — before
 * any session or extension initialization — so crashes are always
 * visible to the user regardless of debug mode.
 *
 * The debug extension layers detailed JSONL logging on top via
 * `uncaughtExceptionMonitor` (for exceptions) and its own
 * `unhandledRejection` listener (for rejections).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TALLOW_HOME } from "./config.js";

/** Persistent crash log — always written, independent of debug mode. */
const CRASH_LOG = join(TALLOW_HOME, "crash.log");

/** Guard against recursive or duplicate fatal error handling. */
let handled = false;

/** Terminal I/O error codes emitted when a TTY or pipe disappears. */
const TERMINAL_IO_ERROR_CODES = new Set(["EIO", "EPIPE"]);

/**
 * Get the terminal I/O code reported by an error, if any.
 *
 * @param error - The error to classify
 * @returns The terminal I/O code, or undefined for unrelated errors
 */
function getTerminalIoErrorCode(error: Error): "EIO" | "EPIPE" | undefined {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EIO" || code === "EPIPE") return code;

	const match = /^(?:read|write) (EIO|EPIPE)$/.exec(error.message);
	return match?.[1] as "EIO" | "EPIPE" | undefined;
}

/**
 * Determine whether an error only reports a disconnected terminal or pipe.
 *
 * @param error - The error to classify
 * @returns True when the error is an expected terminal I/O disconnect
 */
function isTerminalIoError(error: Error): boolean {
	const code = getTerminalIoErrorCode(error);
	return Boolean(code && TERMINAL_IO_ERROR_CODES.has(code));
}

/**
 * Write to a process stream without recursively crashing on terminal I/O errors.
 *
 * @param stream - The stream to write to
 * @param data - The bytes or text to write
 * @returns True when the write was attempted without a synchronous throw
 */
function safeWrite(stream: NodeJS.WriteStream, data: string): boolean {
	try {
		stream.write(data);
		return true;
	} catch (err) {
		if (err instanceof Error && isTerminalIoError(err)) return false;
		throw err;
	}
}

/**
 * Append a timestamped crash entry to the persistent crash log.
 *
 * @param type - Error classification (e.g., "uncaught_exception")
 * @param error - The error that caused the crash
 */
function writeCrashLog(type: string, error: Error): void {
	try {
		mkdirSync(TALLOW_HOME, { recursive: true });
		const entry = [
			`[${new Date().toISOString()}] ${type}`,
			`Message: ${error.message}`,
			`Stack:\n${error.stack ?? "(no stack trace)"}`,
			"---\n",
		].join("\n");
		appendFileSync(CRASH_LOG, entry);
	} catch {
		// Best-effort — nothing we can do if the filesystem is broken
	}
}

/**
 * Display a visible fatal error banner on stderr.
 *
 * Restores terminal state first (leaves alternate screen, shows cursor)
 * so the message is visible even when the TUI is running.
 *
 * @param type - Human-readable error type (e.g., "Uncaught exception")
 * @param error - The error that caused the crash
 */
function displayFatalBanner(type: string, error: Error): void {
	// Restore terminal so the banner is visible after TUI alternate screen
	if (process.stdout.isTTY) {
		safeWrite(process.stdout, "\x1b[?1049l\x1b[?25h");
	}

	const message = error.message.length > 500 ? `${error.message.slice(0, 500)}…` : error.message;

	// Extract first stack frame (file:line) for quick context
	const stackLine = error.stack
		?.split("\n")
		.find((l) => l.trimStart().startsWith("at "))
		?.trim();

	const lines = [
		"",
		`\x1b[41;97m FATAL \x1b[0m \x1b[1;31m${type}\x1b[0m`,
		"",
		`  ${message}`,
		...(stackLine ? [`  \x1b[2m${stackLine}\x1b[0m`] : []),
		"",
		`  \x1b[2mCrash log: ${CRASH_LOG}\x1b[0m`,
		`  \x1b[2mRun /diagnostics-on for detailed debug logs\x1b[0m`,
		"",
	];

	safeWrite(process.stderr, lines.join("\n"));
}

/**
 * Display a short disconnect notice without using alternate-screen recovery.
 *
 * @param error - The terminal I/O error that forced shutdown
 */
function displayTerminalIoNotice(error: Error): void {
	safeWrite(process.stderr, `\nTerminal I/O disconnected (${error.message}); exiting.\n`);
}

/**
 * Handle a fatal error: write crash log, display banner, schedule exit.
 *
 * Uses `process.nextTick` for exit so other registered listeners
 * (e.g., the debug extension's JSONL logger) run before the process
 * terminates.
 *
 * @param type - Human-readable error type
 * @param error - The fatal error
 */
function handleFatal(type: string, error: Error): void {
	if (handled) return;
	handled = true;

	const terminalIoCode = getTerminalIoErrorCode(error);
	if (terminalIoCode === "EPIPE") {
		writeCrashLog("Ignored EPIPE", error);
		handled = false;
		return;
	}
	if (terminalIoCode === "EIO") {
		writeCrashLog("Terminal I/O disconnected", error);
		displayTerminalIoNotice(error);
		process.nextTick(() => process.exit(1));
		return;
	}

	writeCrashLog(type, error);
	displayFatalBanner(type, error);

	// nextTick allows other synchronous listeners (debug JSONL logging)
	// to complete before exit. All uncaughtException / unhandledRejection
	// listeners run synchronously in registration order, then nextTick fires.
	process.nextTick(() => process.exit(1));
}

/**
 * Register unconditional process-level handlers for uncaught exceptions
 * and unhandled promise rejections.
 *
 * Call once at CLI startup, before session or extension initialization.
 * Safe to call multiple times — only the first invocation registers handlers.
 *
 * @returns The crash log path (for testing or display purposes)
 */
export function registerFatalErrorHandlers(): string {
	process.on("uncaughtException", (err: Error) => {
		handleFatal("Uncaught exception", err);
	});

	process.on("unhandledRejection", (reason: unknown) => {
		const err = reason instanceof Error ? reason : new Error(String(reason));
		handleFatal("Unhandled promise rejection", err);
	});

	return CRASH_LOG;
}
