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

export default function bashLive(pi: ExtensionAPI): void {
	const baseBashTool = createBashTool(process.cwd());
	const displayConfig = getToolDisplayConfig("bash");

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
			return new Text(
				theme.fg("toolTitle", theme.bold("bash ")) + theme.fg("muted", preview) + multiLine,
				0,
				0
			);
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cmd = params.command ?? "";
			const firstLine = cmd.split("\n")[0];
			const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
			ctx.ui.setWorkingMessage(`Running: ${preview}`);

			const autoTimeout = readAutoBackgroundTimeout();

			// Fast path: auto-background disabled or user-provided timeout shorter
			if (autoTimeout <= 0 || (params.timeout && params.timeout * 1000 <= autoTimeout)) {
				try {
					return await baseBashTool.execute(toolCallId, params, signal, onUpdate);
				} catch (err) {
					return handleBashError(err);
				} finally {
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
			const summary = `${statusIcon} bash (${lineCount} lines, ${sizeKb}KB, exit ${exitCode})`;
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
