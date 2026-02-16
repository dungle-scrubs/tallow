/**
 * Enhanced bash tool with tail-truncated live output.
 *
 * Wraps the built-in bash tool. Same execute logic,
 * custom rendering that caps visible output to N tail lines.
 *
 * Uses raw render functions (not Text) for renderResult so that
 * line order is explicitly controlled — summary footer always last.
 *
 * During:   last 7 lines of streaming output
 *           ... (93 above lines, 100 total, ctrl+o to expand)
 * Done:     [output lines]
 *           ✓ bash (100 lines, 3.2KB, exit 0)
 * Expanded: full output + footer
 *
 * Auto-background: commands exceeding a configurable timeout (default 30s)
 * are promoted to background tasks via the background-task-tool extension.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentToolResult,
	type BashToolDetails,
	createBashTool,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { getIcon } from "../_icons/index.js";
import { enforceExplicitPolicy, recordAudit } from "../_shared/shell-policy.js";
import { type PromotedTaskHandle, promoteToBackground } from "../background-task-tool/index.js";
import {
	formatToolVerb,
	formatTruncationIndicator,
	getToolDisplayConfig,
	renderLines,
	truncateForDisplay,
} from "../tool-display/index.js";

/** Default auto-background timeout in milliseconds (0 = disabled). */
const DEFAULT_AUTO_BG_TIMEOUT_MS = 30_000;

/**
 * Read the bashAutoBackgroundTimeout setting from ~/.tallow/settings.json.
 * Returns timeout in milliseconds (0 = disabled).
 *
 * @returns Timeout in ms, or 0 to disable
 */
function readAutoBackgroundTimeout(): number {
	try {
		const settingsPath = path.join(os.homedir(), ".tallow", "settings.json");
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { bashAutoBackgroundTimeout?: number };
		if (typeof settings.bashAutoBackgroundTimeout === "number") {
			return settings.bashAutoBackgroundTimeout;
		}
	} catch {
		/* settings file missing or malformed — use default */
	}
	return DEFAULT_AUTO_BG_TIMEOUT_MS;
}

/**
 * Read the BASH_MAINTAIN_PROJECT_WORKING_DIR setting from ~/.tallow/settings.json.
 *
 * @returns True if bash commands should always run from the project root
 */
function readMaintainProjectDir(): boolean {
	try {
		const settingsPath = path.join(os.homedir(), ".tallow", "settings.json");
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { BASH_MAINTAIN_PROJECT_WORKING_DIR?: boolean };
		return settings.BASH_MAINTAIN_PROJECT_WORKING_DIR === true;
	} catch {
		return false;
	}
}

/**
 * Shell-escape a path for safe use in `cd <path> && ...` commands.
 * Wraps in single quotes and escapes embedded single quotes.
 *
 * @param p - File path to escape
 * @returns Shell-safe quoted path
 */
export function shellEscapePath(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

/** Project root captured at session start, used by BASH_MAINTAIN_PROJECT_WORKING_DIR. */
let projectCwd: string | null = null;

/**
 * Strip non-display OSC escape sequences from bash output.
 *
 * Programs like nvim-treesitter emit OSC 1337 (iTerm2 SetUserVar) or other
 * application-specific OSC sequences that pi-tui's visibleWidth() doesn't
 * recognise. It only strips OSC 8 hyperlinks, so unrecognised sequences get
 * counted as visible characters, causing "exceeds terminal width" crashes.
 *
 * We strip all OSC sequences EXCEPT OSC 8 (hyperlinks) which pi-tui handles.
 * Handles both terminated (\x07 or \x1b\\) and unterminated sequences —
 * programs like bun test emit bare \x1b]1337;SetUserVar=... without a terminator.
 *
 * @param line - Raw output line from bash
 * @returns Line with non-display OSC sequences removed
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences requires control chars
const NON_DISPLAY_OSC_RE = /\x1b\](?!8;;)[^\x07\x1b]*(?:\x07|\x1b\\)?/g;

/** @internal */
export function stripNonDisplayOsc(line: string): string {
	if (!line.includes("\u001b]")) return line;
	return line.replace(NON_DISPLAY_OSC_RE, "");
}

/**
 * Detect whether a line already contains ANSI escape sequences.
 *
 * We only need a lightweight check for CSI/OSC prefixes because bash output
 * from tools like git diff includes those directly in each affected line.
 *
 * @param line - Output line from bash
 * @returns True when ANSI escape sequences are already present
 */
function hasAnsiEscape(line: string): boolean {
	return line.includes("\u001b[") || line.includes("\u001b]");
}

/**
 * Keep existing ANSI-colored output untouched.
 *
 * Many commands (like git diff) already include color/reset sequences.
 * Wrapping those lines again with theme colors can create nested escape
 * state that leaks styling between rows.
 *
 * Strips non-display OSC sequences first so visibleWidth() counts correctly.
 *
 * @param line - Output line from bash
 * @param dim - Theme dim color function
 * @returns Safely styled line for display
 */
/** @internal */
export function styleBashLine(line: string, dim: (value: string) => string): string {
	const clean = stripNonDisplayOsc(line);
	return hasAnsiEscape(clean) ? clean : dim(clean);
}

/**
 * Extract exit code from bash error content.
 *
 * @param content - Tool result content array
 * @returns Exit code when present, otherwise null
 */
function getExitCodeFromContent(content: Array<{ type: string; text?: string }>): number | null {
	const textPart = content.find((part) => part.type === "text")?.text ?? "";
	const match = textPart.match(/Command exited with code (\d+)/);
	if (!match) return null;
	return Number(match[1]);
}

/**
 * Extract exit code from a bash output/error string.
 *
 * @param text - Output or error message text
 * @returns Exit code if found, 0 for clean output, null if unparseable
 */
export function extractExitCode(text: string): number | null {
	const match = text.match(/Command exited with code (\d+)/);
	if (match) return Number(match[1]);
	return text.length > 0 ? 0 : null;
}

/**
 * Handle bash tool errors. Exit code 1 is treated as normal (grep, diff, test).
 *
 * @param err - Error thrown by baseBashTool.execute
 * @returns Tool result for recoverable errors
 * @throws Re-throws non-recoverable errors
 */
function handleBashError(err: unknown): AgentToolResult<BashToolDetails | undefined> {
	const msg = err instanceof Error ? err.message : String(err);
	const exitMatch = msg.match(/Command exited with code (\d+)/);
	if (exitMatch && Number(exitMatch[1]) === 1) {
		return { content: [{ type: "text" as const, text: msg }], details: undefined };
	}
	throw err;
}

/** Maximum number of output tail lines shown in the working message. */
const PROGRESS_TAIL_LINES = 3;

/** Maximum character width per progress line before truncation. */
const PROGRESS_LINE_WIDTH = 60;

/** Minimum interval between working message updates (milliseconds). */
const PROGRESS_DEBOUNCE_MS = 100;

/** Visual prefix for output lines in the progress message. */
const PROGRESS_LINE_PREFIX = "│ ";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences
const ANSI_STRIP_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

/**
 * Strip all ANSI escape sequences for clean progress message display.
 *
 * @param text - Text that may contain ANSI escape codes
 * @returns Text with all ANSI sequences removed
 */
/** @internal */
export function stripAllAnsi(text: string): string {
	return text.replace(ANSI_STRIP_RE, "");
}

/**
 * Extract the last N non-empty lines from output text.
 *
 * @param text - Full output text
 * @param maxLines - Maximum number of lines to return
 * @returns Array of the last non-empty lines
 */
/** @internal */
export function extractTailLines(text: string, maxLines: number): string[] {
	const lines = text.split("\n");
	const nonEmpty = lines.filter((line) => line.trim().length > 0);
	return nonEmpty.slice(-maxLines);
}

/**
 * Format a progress message with command preview and latest output tail.
 * Shows the command being run and the last few lines of output beneath it,
 * each prefixed with a visual separator.
 *
 * @param preview - Truncated command preview string
 * @param tailLines - Last N lines of output
 * @param maxWidth - Maximum width per output line before truncation
 * @returns Formatted multi-line progress message for setWorkingMessage
 */
/** @internal */
export function formatProgressMessage(
	preview: string,
	tailLines: string[],
	maxWidth: number
): string {
	let msg = `Running: ${preview}`;
	for (const line of tailLines) {
		const clean = stripAllAnsi(line).trim();
		if (clean.length === 0) continue;
		const truncated = clean.length > maxWidth ? `${clean.slice(0, maxWidth - 1)}…` : clean;
		msg += `\n  ${PROGRESS_LINE_PREFIX}${truncated}`;
	}
	return msg;
}

/** Whether ripgrep (rg) is available on the system. Detected once at init. */
let hasRipgrep = false;

/**
 * Check if ripgrep is installed by running `which rg`.
 *
 * @returns True if rg is found on PATH
 */
function detectRipgrep(): boolean {
	try {
		execSync("which rg", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export default function bashLive(pi: ExtensionAPI): void {
	const baseBashTool = createBashTool(process.cwd());
	const displayConfig = getToolDisplayConfig("bash");

	// Capture project root for BASH_MAINTAIN_PROJECT_WORKING_DIR
	projectCwd = process.cwd();

	// Detect ripgrep availability
	hasRipgrep = detectRipgrep();

	pi.on("session_start", async (_event, ctx) => {
		if (!hasRipgrep) {
			ctx.ui.notify(
				"ripgrep not found — install it for faster search (brew install ripgrep)",
				"warning"
			);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (hasRipgrep) {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\nripgrep (rg) is installed on this system. Prefer `rg` over `grep` in bash commands — it is faster, respects .gitignore, and skips binary files by default.",
			};
		}
	});

	pi.registerTool({
		name: "bash",
		label: baseBashTool.label,
		description: baseBashTool.description,
		parameters: baseBashTool.parameters,

		renderCall(args, theme) {
			const cmd = args.command ?? "";
			const firstLine = cmd.split("\n")[0];
			const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
			const multiLine = cmd.includes("\n") ? theme.fg("dim", " (multiline)") : "";
			const verb = formatToolVerb("bash", false);
			return new Text(
				theme.fg("toolTitle", theme.bold(`${verb} `)) + theme.fg("muted", preview) + multiLine,
				0,
				0
			);
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// BASH_MAINTAIN_PROJECT_WORKING_DIR: force commands to run from project root
			if (readMaintainProjectDir() && projectCwd) {
				if (fs.existsSync(projectCwd)) {
					params = { ...params, command: `cd ${shellEscapePath(projectCwd)} && ${params.command}` };
				} else {
					// Project directory deleted — disable for remaining session
					projectCwd = null;
					return {
						content: [
							{
								type: "text" as const,
								text: `BASH_MAINTAIN_PROJECT_WORKING_DIR: project directory no longer exists. Setting disabled for this session.`,
							},
						],
						details: undefined,
						isError: true,
					};
				}
			}

			const cmd = params.command ?? "";
			const firstLine = cmd.split("\n")[0];
			const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
			ctx.ui.setWorkingMessage(`Running: ${preview}`);

			// Progress: surface output tail in the working message area
			let lastProgressTime = 0;
			let progressTimeout: ReturnType<typeof setTimeout> | null = null;

			/**
			 * Debounced update of the working message with the latest output tail.
			 *
			 * @param text - Full output text so far
			 */
			const updateProgress = (text: string): void => {
				const now = Date.now();
				const doUpdate = (): void => {
					lastProgressTime = Date.now();
					const tail = extractTailLines(text, PROGRESS_TAIL_LINES);
					ctx.ui.setWorkingMessage(formatProgressMessage(preview, tail, PROGRESS_LINE_WIDTH));
				};
				if (now - lastProgressTime >= PROGRESS_DEBOUNCE_MS) {
					if (progressTimeout) {
						clearTimeout(progressTimeout);
						progressTimeout = null;
					}
					doUpdate();
				} else if (!progressTimeout) {
					progressTimeout = setTimeout(
						() => {
							progressTimeout = null;
							doUpdate();
						},
						PROGRESS_DEBOUNCE_MS - (now - lastProgressTime)
					);
				}
			};

			/** Clear any pending progress update timeout. */
			const clearProgressTimeout = (): void => {
				if (progressTimeout) {
					clearTimeout(progressTimeout);
					progressTimeout = null;
				}
			};

			/**
			 * Wraps onUpdate to surface output progress in the working message.
			 *
			 * @param partialResult - Partial tool result from bash execution
			 */
			const progressOnUpdate: typeof onUpdate = (partialResult) => {
				onUpdate?.(partialResult);
				const text = partialResult?.content?.find((c: { type: string }) => c.type === "text") as
					| { text: string }
					| undefined;
				if (text?.text) updateProgress(text.text);
			};

			const autoTimeout = readAutoBackgroundTimeout();

			// Fast path: auto-background disabled or user-provided timeout shorter
			if (autoTimeout <= 0 || (params.timeout && params.timeout * 1000 <= autoTimeout)) {
				try {
					return await baseBashTool.execute(toolCallId, params, signal, progressOnUpdate);
				} catch (err) {
					return handleBashError(err);
				} finally {
					clearProgressTimeout();
					ctx.ui.setWorkingMessage();
				}
			}

			// Auto-background path: race execution against timeout
			const startTime = Date.now();
			const ownAbort = new AbortController();

			// Forward parent abort signal to our controller
			if (signal) {
				if (signal.aborted) ownAbort.abort();
				else signal.addEventListener("abort", () => ownAbort.abort(), { once: true });
			}

			// Intercept onUpdate to capture partial output for handoff
			let promotedHandle: PromotedTaskHandle | null = null;
			let capturedOutput = "";

			/**
			 * Wrapping onUpdate so we can redirect output to the background task
			 * after promotion, instead of sending it to the (already-returned) tool result.
			 */
			const wrappedOnUpdate: typeof onUpdate = (partialResult) => {
				const text = partialResult?.content?.find((c: { type: string }) => c.type === "text") as
					| { text: string }
					| undefined;
				if (text?.text) capturedOutput = text.text;

				if (promotedHandle) {
					// After promotion, feed output to background task buffer
					if (text?.text) promotedHandle.replaceOutput(text.text);
				} else {
					onUpdate?.(partialResult);
					// Update progress message while still in foreground
					if (text?.text) updateProgress(text.text);
				}
			};

			// Start bash execution
			const bashPromise = baseBashTool
				.execute(toolCallId, params, ownAbort.signal, wrappedOnUpdate)
				.then((result) => ({ type: "completed" as const, result }))
				.catch((err) => ({ type: "error" as const, err }));

			// Start timeout race
			const timeoutPromise = new Promise<{ type: "timeout" }>((resolve) => {
				const timer = setTimeout(() => resolve({ type: "timeout" as const }), autoTimeout);
				// Cancel timer if bash finishes first (avoid timer leak)
				bashPromise.then(
					() => clearTimeout(timer),
					() => clearTimeout(timer)
				);
			});

			const winner = await Promise.race([bashPromise, timeoutPromise]);
			clearProgressTimeout();
			ctx.ui.setWorkingMessage();

			if (winner.type === "completed") {
				return winner.result;
			}

			if (winner.type === "error") {
				return handleBashError(winner.err);
			}

			// Command exceeded timeout — promote to background
			promotedHandle = promoteToBackground({
				command: cmd,
				cwd: ctx.cwd,
				startTime,
				initialOutput: capturedOutput,
				abortController: ownAbort,
			});

			// Continue capturing output in background until bash completes
			bashPromise.then((outcome) => {
				if (!promotedHandle) return;
				if (outcome.type === "completed") {
					const text = outcome.result.content?.find((c: { type: string }) => c.type === "text") as
						| { text: string }
						| undefined;
					if (text?.text) promotedHandle.replaceOutput(text.text);
					const exitCode = extractExitCode(text?.text ?? "");
					promotedHandle.complete(exitCode);
				} else {
					const msg = outcome.err instanceof Error ? outcome.err.message : String(outcome.err);
					promotedHandle.replaceOutput(msg);
					const exitCode = extractExitCode(msg) ?? 1;
					promotedHandle.complete(exitCode);
				}
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Command auto-backgrounded after ${autoTimeout / 1000}s.\n\nTask ID: ${promotedHandle.id}\nCommand: ${cmd}\n\nThe command is still running in the background.\nUse task_status("${promotedHandle.id}") to check if it's done.\nUse task_output("${promotedHandle.id}") to retrieve the output.\nUse task_kill("${promotedHandle.id}") to stop it.`,
					},
				],
				details: {
					autoBackgrounded: true,
					taskId: promotedHandle.id,
				} as unknown as BashToolDetails,
			};
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const textContent = result.content.find((c: { type: string }) => c.type === "text") as
				| { text: string }
				| undefined;
			const text = textContent?.text ?? "";
			const details = result.details as
				| BashToolDetails
				| { autoBackgrounded: true; taskId: string }
				| undefined;

			// Auto-backgrounded: show compact status with task ID
			if (details && "autoBackgrounded" in details) {
				const icon = getIcon("in_progress");
				let rendered = `${theme.fg("warning", icon)} ${theme.fg("accent", "Auto-backgrounded")} → ${theme.fg("dim", `task_output("${details.taskId}")`)}`;
				if (expanded) {
					rendered += `\n${theme.fg("muted", text)}`;
				}
				return new Text(rendered, 0, 0);
			}

			// During execution: show tail-truncated live output
			if (isPartial) {
				if (!text) return renderLines([theme.fg("muted", "...")]);

				const { visible, truncated, totalLines, hiddenLines } = truncateForDisplay(
					text,
					displayConfig
				);

				const lines: string[] = [];
				if (truncated) {
					lines.push(formatTruncationIndicator(displayConfig, totalLines, hiddenLines, theme));
				}
				for (const line of visible.split("\n")) {
					lines.push(styleBashLine(line, (value) => theme.fg("dim", value)));
				}
				return renderLines(lines);
			}

			// Done: build exit status summary
			const lineCount = text.split("\n").length;
			const sizeKb = (text.length / 1024).toFixed(1);

			const exitMatch = text.match(/Command exited with code (\d+)/);
			const exitCode = exitMatch ? Number(exitMatch[1]) : 0;

			// Exit 0–1: normal (grep no-match, diff, test false, etc.)
			const statusIcon = exitCode <= 1 ? getIcon("success") : getIcon("error");
			const statusColor = exitCode <= 1 ? "muted" : "error";
			const verb = formatToolVerb("bash", true);
			const summary = `${statusIcon} ${verb} (${lineCount} lines, ${sizeKb}KB, exit ${exitCode})`;
			const fullPathSuffix = details?.fullOutputPath
				? theme.fg("dim", ` → ${details.fullOutputPath}`)
				: "";

			// Expanded: show all output with wrapping, footer last
			if (expanded) {
				const lines: string[] = [];
				for (const line of text.split("\n")) {
					lines.push(styleBashLine(line, (value) => theme.fg("dim", value)));
				}
				lines.push(theme.fg(statusColor, summary) + fullPathSuffix);
				return renderLines(lines, { wrap: true });
			}

			// Collapsed: show tail-truncated output, footer last
			const { visible, truncated, totalLines, hiddenLines } = truncateForDisplay(
				text,
				displayConfig
			);

			const lines: string[] = [];
			if (truncated) {
				lines.push(formatTruncationIndicator(displayConfig, totalLines, hiddenLines, theme));
			}
			for (const line of visible.split("\n")) {
				lines.push(styleBashLine(line, (value) => theme.fg("dim", value)));
			}
			lines.push(theme.fg(statusColor, summary) + fullPathSuffix);
			return renderLines(lines);
		},
	});

	// Enforce shell policy for bash tool calls — denies denylist hits outright
	// and prompts for confirmation on high-risk commands in interactive mode.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const command = (event.input as { command?: string }).command;
		if (!command) return;

		return enforceExplicitPolicy(command, "bash", ctx.cwd, ctx.hasUI, (msg) =>
			ctx.ui.confirm("Shell Policy", msg)
		);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: string }).command?.trim();
		if (!command) return;

		recordAudit({
			timestamp: Date.now(),
			command,
			source: "bash",
			trustLevel: "explicit",
			cwd: ctx.cwd,
			outcome: event.isError ? "failed" : "executed",
			exitCode: event.isError
				? getExitCodeFromContent(event.content as Array<{ type: string; text?: string }>)
				: 0,
		});
	});
}
