/**
 * Debug Extension — Structured diagnostic logging for tallow internals.
 *
 * Emits JSONL to ~/.tallow/debug.log (or stderr) with tool timings,
 * extension lifecycle, model changes, subagent events, and error traces.
 *
 * Activation: --debug flag, TALLOW_DEBUG=1 env, or NODE_ENV=development.
 * Zero-cost when disabled — no file I/O, no object allocation.
 *
 * Registers:
 *   - --debug CLI flag
 *   - /diag command (status, toggle, tail, clear)
 *   - Event hooks for all diagnostic categories
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { createDebugLogger, type DebugLogger, isDebug } from "./logger.js";

/** Map of toolCallId → start timestamp for duration tracking. */
const toolTimings = new Map<string, number>();

/** Session-level counters for the shutdown summary. */
let totalToolCalls = 0;
let totalTurns = 0;
let sessionStartTime = 0;

/**
 * Formats a byte count as a human-readable string.
 * @param bytes - Raw byte count
 * @returns Formatted string (e.g. "12.3 KB")
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Safely extracts text content length from a tool result's content array.
 * @param content - Array of text/image content blocks
 * @returns Total character count of text blocks
 */
function contentLength(content: Array<{ type: string; text?: string }>): number {
	let len = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			len += block.text.length;
		}
	}
	return len;
}

/**
 * Reads the last N lines from the debug log file.
 * @param logPath - Path to the JSONL log file
 * @param n - Number of lines to return
 * @returns Array of parsed log entries (newest last)
 */
function tailLog(logPath: string, n: number): string[] {
	if (!existsSync(logPath)) return [];
	const content = readFileSync(logPath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);
	return lines.slice(-n);
}

/**
 * Registers the debug extension: CLI flag, event hooks, and /diag command.
 * @param pi - Extension API for registering handlers
 */
export default function (pi: ExtensionAPI) {
	let logger: DebugLogger | null = null;

	// ── CLI Flag ─────────────────────────────────────────────────

	pi.registerFlag("debug", {
		description: "Enable debug diagnostic logging",
		type: "boolean",
		default: false,
	});

	// ── Session Lifecycle ────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Reset counters
		totalToolCalls = 0;
		totalTurns = 0;
		sessionStartTime = performance.now();

		// Resolve debug activation: CLI flag > env var > dev detection
		const flagActive = pi.getFlag("debug") === true;
		const shouldActivate = flagActive || isDebug();

		if (!shouldActivate) return;

		// Reuse existing logger on reload, or create new
		if (globalThis.__piDebugLogger) {
			logger = globalThis.__piDebugLogger as DebugLogger;
		} else {
			const sessionId = ctx.sessionManager.getSessionId();
			logger = createDebugLogger(sessionId);
		}

		logger!.log("session", "start", {
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
			tools: pi.getActiveTools(),
		});

		// ── EventBus hooks (cross-extension events) ──────────

		const G = globalThis as Record<string, unknown>;
		if (G.__debugEventCleanup) {
			(G.__debugEventCleanup as () => void)();
		}

		const unsubs: Array<() => void> = [];

		unsubs.push(
			pi.events.on("subagent_start", (data) => {
				const evt = data as {
					agent_id: string;
					agent_type: string;
					task: string;
					background: boolean;
				};
				logger?.log("subagent", "start", {
					agentId: evt.agent_id,
					agentType: evt.agent_type,
					task: evt.task,
					background: evt.background,
				});
			})
		);

		unsubs.push(
			pi.events.on("subagent_stop", (data) => {
				const evt = data as {
					agent_id: string;
					agent_type: string;
					exit_code: number;
					result: string;
					background: boolean;
				};
				logger?.log("subagent", "stop", {
					agentId: evt.agent_id,
					agentType: evt.agent_type,
					exitCode: evt.exit_code,
					result: evt.result,
					background: evt.background,
				});
			})
		);

		unsubs.push(
			pi.events.on("hooks:merge", (data) => {
				const matchers = data as Array<{ piEvent: string; matcher?: string }>;
				logger?.log("session", "hooks_merge", {
					matcherCount: matchers.length,
					events: matchers.map((m) => m.piEvent),
				});
			})
		);

		G.__debugEventCleanup = () => {
			for (const unsub of unsubs) unsub();
		};
	});

	pi.on("session_shutdown", async () => {
		if (!logger) return;

		const durationMs = Math.round(performance.now() - sessionStartTime);
		logger.log("session", "shutdown", {
			durationMs,
			totalToolCalls,
			totalTurns,
		});

		logger.close();
		logger = null;
		globalThis.__piDebugLogger = undefined;

		// Clean up event listeners
		const G = globalThis as Record<string, unknown>;
		if (G.__debugEventCleanup) {
			(G.__debugEventCleanup as () => void)();
			delete G.__debugEventCleanup;
		}
	});

	// ── Agent Events ─────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (!logger) return;

		const promptChars = event.systemPrompt.length;
		// Rough token estimate: ~4 chars per token
		const estimatedTokens = Math.round(promptChars / 4);

		logger.log("agent", "before_start", {
			promptChars,
			estimatedTokens,
			promptPreview: event.prompt,
			systemPromptPreview: event.systemPrompt,
		});
	});

	pi.on("agent_end", async (event) => {
		if (!logger) return;

		logger.log("agent", "end", {
			messageCount: event.messages.length,
		});
	});

	// ── Turn Events ──────────────────────────────────────────────

	pi.on("turn_start", async (event) => {
		if (!logger) return;

		totalTurns++;
		logger.log("turn", "start", {
			turnIndex: event.turnIndex,
		});
	});

	pi.on("turn_end", async (event) => {
		if (!logger) return;

		logger.log("turn", "end", {
			turnIndex: event.turnIndex,
			toolResultCount: event.toolResults.length,
		});
	});

	// ── Tool Events ──────────────────────────────────────────────

	pi.on("tool_call", async (event) => {
		if (!logger) return;

		totalToolCalls++;
		toolTimings.set(event.toolCallId, performance.now());

		logger.log("tool", "call", {
			toolCallId: event.toolCallId,
			name: event.toolName,
			args: event.input as Record<string, unknown>,
		});
	});

	pi.on("tool_result", async (event) => {
		if (!logger) return;

		const startTime = toolTimings.get(event.toolCallId);
		const durationMs = startTime !== undefined ? Math.round(performance.now() - startTime) : null;
		toolTimings.delete(event.toolCallId);

		logger.log("tool", "result", {
			toolCallId: event.toolCallId,
			name: event.toolName,
			durationMs,
			ok: !event.isError,
			contentLength: contentLength(event.content as Array<{ type: string; text?: string }>),
		});
	});

	// ── Model Events ─────────────────────────────────────────────

	pi.on("model_select", async (event) => {
		if (!logger) return;

		logger.log("model", "select", {
			provider: event.model.provider,
			modelId: event.model.id,
			previousProvider: event.previousModel?.provider ?? null,
			previousModelId: event.previousModel?.id ?? null,
			source: event.source,
		});
	});

	// ── Error Handlers ───────────────────────────────────────────

	// Capture uncaught exceptions and unhandled rejections when debug is active.
	// These are logged then re-thrown — debug mode should not swallow errors.

	const onUncaughtException = (err: Error) => {
		logger?.log("error", "uncaught_exception", {
			message: err.message,
			stack: err.stack,
		});
	};

	const onUnhandledRejection = (reason: unknown) => {
		const err = reason instanceof Error ? reason : new Error(String(reason));
		logger?.log("error", "unhandled_rejection", {
			message: err.message,
			stack: err.stack,
		});
	};

	// Register/deregister process-level handlers based on logger lifecycle
	pi.on("session_start", async () => {
		if (logger) {
			process.on("uncaughtException", onUncaughtException);
			process.on("unhandledRejection", onUnhandledRejection);
		}
	});

	pi.on("session_shutdown", async () => {
		process.removeListener("uncaughtException", onUncaughtException);
		process.removeListener("unhandledRejection", onUnhandledRejection);
	});

	// ── /diag commands ───────────────────────────────────────────
	// Separate commands — no space-separated subcommands.
	// Autocomplete can't handle `/diag on`; must be `/diag-on`.

	/**
	 * Resolves the debug log file path from the active logger or the default location.
	 * @returns Absolute path to the debug log
	 */
	function getLogPath(): string {
		return logger?.logPath ?? `${process.env.HOME}/.tallow/debug.log`;
	}

	pi.registerCommand("diag", {
		description: "Show debug mode status, log path, size, and recent entries",
		handler: async () => {
			const logPath = getLogPath();
			const active = logger !== null;
			const logExists = existsSync(logPath);
			const logSize = logExists ? formatBytes(statSync(logPath).size) : "N/A";
			const recentLines = tailLog(logPath, 5);
			const recent =
				recentLines.length > 0
					? recentLines
							.map((line) => {
								try {
									const entry = JSON.parse(line);
									return `  ${entry.cat}/${entry.evt}`;
								} catch {
									return `  ${line.slice(0, 60)}`;
								}
							})
							.join("\n")
					: "  (empty)";

			const status = [
				`Debug mode: ${active ? "ON" : "OFF"}`,
				`Log file: ${logPath}`,
				`Log size: ${logSize}`,
				`Recent entries:\n${recent}`,
				"",
				"Commands: /diag-on, /diag-off, /diag-tail, /diag-clear",
			].join("\n");

			pi.sendMessage({ customType: "diag", content: status, display: true });
		},
	});

	pi.registerCommand("diag-on", {
		description: "Enable debug diagnostic logging",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (logger) {
				pi.sendMessage({
					customType: "diag",
					content: "Debug mode is already active.",
					display: true,
				});
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			logger = createDebugLogger(sessionId);
			process.on("uncaughtException", onUncaughtException);
			process.on("unhandledRejection", onUnhandledRejection);
			pi.sendMessage({
				customType: "diag",
				content: `Debug mode enabled. Logging to ${getLogPath()}`,
				display: true,
			});
		},
	});

	pi.registerCommand("diag-off", {
		description: "Disable debug diagnostic logging",
		handler: async () => {
			if (!logger) {
				pi.sendMessage({ customType: "diag", content: "Debug mode is not active.", display: true });
				return;
			}
			logger.close();
			logger = null;
			globalThis.__piDebugLogger = undefined;
			process.removeListener("uncaughtException", onUncaughtException);
			process.removeListener("unhandledRejection", onUnhandledRejection);
			pi.sendMessage({ customType: "diag", content: "Debug mode disabled.", display: true });
		},
	});

	pi.registerCommand("diag-tail", {
		description: "Show last N debug log entries (default: 20)",
		handler: async (args: string) => {
			const n = parseInt(args.trim(), 10) || 20;
			const lines = tailLog(getLogPath(), n);
			if (lines.length === 0) {
				pi.sendMessage({ customType: "diag", content: "No log entries found.", display: true });
				return;
			}
			const formatted = lines
				.map((line) => {
					try {
						const entry = JSON.parse(line);
						return `[${entry.ts}] ${entry.cat}/${entry.evt}: ${JSON.stringify(entry.data)}`;
					} catch {
						return line;
					}
				})
				.join("\n");
			pi.sendMessage({
				customType: "diag",
				content: `Last ${lines.length} entries:\n\`\`\`\n${formatted}\n\`\`\``,
				display: true,
			});
		},
	});

	pi.registerCommand("diag-clear", {
		description: "Truncate the debug log file",
		handler: async () => {
			if (logger) {
				logger.clear();
			}
			pi.sendMessage({ customType: "diag", content: "Debug log cleared.", display: true });
		},
	});
}
