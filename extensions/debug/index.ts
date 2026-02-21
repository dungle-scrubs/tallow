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
 *   - /diagnostics commands (toggle, tail, clear, live follow)
 *   - Event hooks for all diagnostic categories
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	calculateTurnMetrics,
	formatEntries,
	formatErrors,
	formatToolTimings,
	formatTurnMetrics,
	groupErrors,
	summarizeToolTimings,
} from "./analysis.js";
import { createDebugLogger, type DebugLogger, isDebug, queryLog } from "./logger.js";

/** Map of toolCallId → start timestamp for duration tracking. */
const toolTimings = new Map<string, number>();

/** Session-level counters for the shutdown summary. */
let totalToolCalls = 0;
let totalTurns = 0;
let sessionStartTime = 0;

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
 * Registers the debug extension: CLI flag, event hooks, and /diagnostics commands.
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

		logger?.log("session", "start", {
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

	// Detailed JSONL logging for uncaught exceptions and unhandled rejections.
	// Core fatal handlers (src/fatal-errors.ts) display the user-facing banner
	// and exit; these add structured diagnostic detail when debug mode is on.
	//
	// uncaughtExceptionMonitor fires BEFORE uncaughtException listeners,
	// so JSONL logging completes before the core handler schedules exit.
	// unhandledRejection listeners run synchronously in registration order —
	// both the core handler and this one execute before process.nextTick exit.

	const onUncaughtException = (err: Error, _origin: string) => {
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
			process.on("uncaughtExceptionMonitor", onUncaughtException);
			process.on("unhandledRejection", onUnhandledRejection);
		}
	});

	pi.on("session_shutdown", async () => {
		process.removeListener("uncaughtExceptionMonitor", onUncaughtException);
		process.removeListener("unhandledRejection", onUnhandledRejection);
	});

	// ── debug_inspect tool ───────────────────────────────────────

	const DebugInspectParams = Type.Object({
		category: Type.Optional(
			Type.Union(
				[
					Type.Literal("session"),
					Type.Literal("tool"),
					Type.Literal("model"),
					Type.Literal("turn"),
					Type.Literal("agent"),
					Type.Literal("mcp"),
					Type.Literal("subagent"),
					Type.Literal("error"),
				],
				{
					description:
						"Filter by log category: session, tool, model, turn, agent, mcp, subagent, error",
				}
			)
		),
		eventType: Type.Optional(
			Type.String({
				description:
					"Filter by event type within a category (e.g. 'call', 'result', 'start', 'stop')",
			})
		),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum entries to return (default: 50, newest first)",
			})
		),
		since: Type.Optional(
			Type.String({
				description: "Only entries after this ISO timestamp or relative duration (e.g. '5m')",
			})
		),
		search: Type.Optional(
			Type.String({
				description: "Free-text search across log entry data",
			})
		),
		analysis: Type.Optional(
			Type.Union(
				[
					Type.Literal("tool_timings"),
					Type.Literal("errors"),
					Type.Literal("turn_metrics"),
					Type.Literal("raw"),
				],
				{
					description:
						"Analysis mode: 'tool_timings' for timing histograms, 'errors' for grouped errors, " +
						"'turn_metrics' for efficiency stats, 'raw' for formatted entries (default: raw)",
				}
			)
		),
	});

	/**
	 * Parses a relative duration string (e.g. "5m", "2h", "30s") into an ISO timestamp.
	 *
	 * @param since - Relative duration or ISO timestamp string
	 * @returns ISO timestamp string
	 */
	function resolveSince(since: string): string {
		// If it's already an ISO timestamp, return as-is
		if (since.includes("T") || since.includes("-")) return since;

		const match = since.match(/^(\d+)\s*(s|m|h|d)$/);
		if (!match) return since;

		const amount = parseInt(match[1], 10);
		const unit = match[2];
		const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
		const ms = amount * (multipliers[unit] ?? 0);

		return new Date(Date.now() - ms).toISOString();
	}

	pi.registerTool({
		name: "debug_inspect",
		label: "debug_inspect",
		description:
			"Read and analyze debug diagnostic logs. Returns filtered, summarized log data — " +
			"not raw JSONL. Use to diagnose errors, find slow tools, check turn efficiency, " +
			"or inspect recent events. Only available when debug mode is active.",
		parameters: DebugInspectParams,

		/**
		 * Reads and analyzes debug log entries based on filters and analysis mode.
		 *
		 * @param _toolCallId - Unique tool call identifier
		 * @param params - Query filters and analysis mode
		 * @returns Formatted analysis results or error message
		 */
		async execute(_toolCallId, params) {
			if (!logger) {
				return {
					content: [
						{
							type: "text",
							text: "Debug mode is not active. Enable it with /diagnostics-on or start tallow with --debug.",
						},
					],
					details: undefined,
				};
			}

			const logPath = getLogPath();
			const since = params.since ? resolveSince(params.since) : undefined;
			const limit = params.limit ?? 50;
			const analysisMode = params.analysis ?? "raw";

			const entries = queryLog(logPath, {
				category: params.category,
				eventType: params.eventType,
				limit: analysisMode === "raw" ? limit : undefined, // analysis modes need all data
				since,
				search: params.search,
			});

			let result: string;

			switch (analysisMode) {
				case "tool_timings":
					result = formatToolTimings(summarizeToolTimings(entries));
					break;
				case "errors":
					result = formatErrors(groupErrors(entries));
					break;
				case "turn_metrics":
					result = formatTurnMetrics(calculateTurnMetrics(entries));
					break;
				default:
					result = formatEntries(entries);
					break;
			}

			return {
				content: [{ type: "text", text: result }],
				details: undefined,
			};
		},
	});

	// ── /debug command ───────────────────────────────────────────

	pi.registerCommand("debug", {
		description: "Interactive troubleshooting — model analyzes debug logs",
		handler: async () => {
			if (!logger) {
				pi.sendMessage({
					customType: "debug",
					content:
						"Debug mode is not active. Enable with `/diagnostics-on` or start tallow with `--debug`.",
					display: true,
				});
				return;
			}

			// Inject a prompt so the model knows debugging tools are available
			pi.sendMessage({
				customType: "debug",
				content:
					"The user wants to troubleshoot. You have the `debug_inspect` tool available. " +
					"Ask what they'd like to investigate, or proactively check for errors and " +
					"slow tool calls. Use the tool's `analysis` parameter for structured summaries: " +
					"'errors', 'tool_timings', 'turn_metrics', or 'raw'.",
				display: false,
			});
		},
	});

	// ── /diagnostics commands ────────────────────────────────────
	// Separate commands — no space-separated subcommands.
	// Autocomplete can't handle `/diagnostics on`; must be `/diagnostics-on`.

	/**
	 * Resolves the debug log file path from the active logger or the default location.
	 * @returns Absolute path to the debug log
	 */
	function getLogPath(): string {
		return logger?.logPath ?? `${process.env.HOME}/.tallow/debug.log`;
	}

	/**
	 * Parses a tail line-count argument with a default fallback.
	 * @param args - Raw slash-command arguments
	 * @returns Number of lines to show (default: 20)
	 */
	function parseTailCount(args: string): number {
		const parsed = parseInt(args.trim(), 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
	}

	/**
	 * Sends the last N debug log entries into the current chat pane.
	 * @param lineCount - Number of entries to include
	 */
	function sendLocalTailOutput(lineCount: number): void {
		const lines = tailLog(getLogPath(), lineCount);
		if (lines.length === 0) {
			pi.sendMessage({
				customType: "diagnostics",
				content: "No log entries found.",
				display: true,
			});
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
			customType: "diagnostics",
			content: `Last ${lines.length} entries:\n\`\`\`\n${formatted}\n\`\`\``,
			display: true,
		});
	}

	/**
	 * Checks whether WezTerm pane control capability is available.
	 * @returns True when the wezterm_pane tool is registered
	 */
	function hasWeztermPaneCapability(): boolean {
		return pi.getAllTools().some((tool) => tool.name === "wezterm_pane");
	}

	/**
	 * Resolves the wezterm executable path from the current environment.
	 * @returns Executable path for wezterm CLI calls
	 */
	function resolveWeztermExecutable(): string {
		const executableDir = process.env.WEZTERM_EXECUTABLE_DIR;
		if (typeof executableDir === "string" && executableDir.length > 0) {
			const candidate = `${executableDir}/wezterm`;
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		return "wezterm";
	}

	/**
	 * Opens a new WezTerm pane running `tail -f` on the debug log file.
	 * @param ctx - Command context for shell execution and UI notifications
	 * @param logPath - Absolute path to the debug log file
	 * @returns True if a live-follow pane was launched successfully
	 */
	async function openLiveFollowPane(
		ctx: ExtensionCommandContext,
		logPath: string
	): Promise<boolean> {
		try {
			const args = ["cli", "split-pane"];
			if (process.env.WEZTERM_PANE) {
				args.push("--pane-id", process.env.WEZTERM_PANE);
			}
			args.push("--bottom", "--", "tail", "-f", logPath);

			const result = await pi.exec(resolveWeztermExecutable(), args, { cwd: ctx.cwd });
			if (result.code !== 0) {
				const reason = result.stderr.trim() || `wezterm exited with code ${result.code}`;
				throw new Error(reason);
			}

			ctx.ui.notify("Opened live diagnostics follow in a new WezTerm pane.", "info");
			return true;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Couldn't open live diagnostics pane (${reason}). Showing local tail instead.`,
				"warning"
			);
			return false;
		}
	}

	pi.registerCommand("diagnostics", {
		description: "Show local diagnostics tail, or open live follow in a new WezTerm pane",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const lineCount = parseTailCount(args);

			if (!hasWeztermPaneCapability() || !ctx.hasUI) {
				sendLocalTailOutput(lineCount);
				return;
			}

			const choice = await ctx.ui.select("Diagnostics output", [
				`Local tail output (last ${lineCount} entries)`,
				"Live follow in new WezTerm pane",
			]);
			if (choice === undefined) {
				return;
			}

			if (choice.startsWith("Local tail output")) {
				sendLocalTailOutput(lineCount);
				return;
			}

			const launched = await openLiveFollowPane(ctx, getLogPath());
			if (!launched) {
				sendLocalTailOutput(lineCount);
			}
		},
	});

	pi.registerCommand("diagnostics-on", {
		description: "Enable debug diagnostic logging",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (logger) {
				pi.sendMessage({
					customType: "diagnostics",
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
				customType: "diagnostics",
				content: `Debug mode enabled. Logging to ${getLogPath()}`,
				display: true,
			});
		},
	});

	pi.registerCommand("diagnostics-off", {
		description: "Disable debug diagnostic logging",
		handler: async () => {
			if (!logger) {
				pi.sendMessage({
					customType: "diagnostics",
					content: "Debug mode is not active.",
					display: true,
				});
				return;
			}
			logger.close();
			logger = null;
			globalThis.__piDebugLogger = undefined;
			process.removeListener("uncaughtException", onUncaughtException);
			process.removeListener("unhandledRejection", onUnhandledRejection);
			pi.sendMessage({ customType: "diagnostics", content: "Debug mode disabled.", display: true });
		},
	});

	pi.registerCommand("diagnostics-tail", {
		description: "Show last N debug log entries (default: 20)",
		handler: async (args: string) => {
			sendLocalTailOutput(parseTailCount(args));
		},
	});

	pi.registerCommand("diagnostics-clear", {
		description: "Truncate the debug log file",
		handler: async () => {
			if (logger) {
				logger.clear();
			}
			pi.sendMessage({ customType: "diagnostics", content: "Debug log cleared.", display: true });
		},
	});
}
