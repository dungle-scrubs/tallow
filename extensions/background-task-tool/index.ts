/**
 * Background Tasks Extension for Pi
 *
 * Enables running bash commands in the background.
 *
 * Features:
 * - `bg_bash` tool: Run commands in background, returns task ID immediately
 * - `task_output` tool: Retrieve output from a background task
 * - `task_status` tool: Check if a task is running or completed
 * - `/bg` command: List and manage background tasks
 * - Status widget shows running background tasks
 *
 * Usage:
 *   Ask the agent to "run npm test in the background"
 *   Or use the bg_bash tool directly with a command
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	keyHint,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	Key,
	Loader,
	matchesKey,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon, getSpinner } from "../_icons/index.js";
import { extractPreview, isInlineResultsEnabled } from "../_shared/inline-preview.js";
import {
	emitInteropEvent,
	INTEROP_API_CHANNELS,
	INTEROP_EVENT_NAMES,
	type InteropBackgroundTaskView,
	onInteropEvent,
} from "../_shared/interop-events.js";
import { registerPid, unregisterPid } from "../_shared/pid-registry.js";
import { enforceExplicitPolicy, recordAudit } from "../_shared/shell-policy.js";
import { getTallowSettingsPath } from "../_shared/tallow-paths.js";
import {
	appendSection,
	dimProcessOutputLine,
	formatPresentationText,
	formatSectionDivider,
	renderLines,
} from "../tool-display/index.js";
import { createProcessLifecycle } from "./process-lifecycle.js";

/** Spawn implementation used by bg_bash (overridable in tests). */
let spawnProcess: typeof spawn = spawn;

// ANSI escape codes for Catppuccin Macchiato colors (medium-dark variant)
// Crust bg: #181926, Mauve: #c6a0f6, Text: #cad3f5
const BG_DARK_GRAY = "\x1b[48;2;24;25;38m"; // Catppuccin Macchiato crust #181926
const FG_PURPLE = "\x1b[38;2;198;160;246m"; // Catppuccin Macchiato mauve #c6a0f6
const FG_PURPLE_MUTED = "\x1b[38;2;165;173;203m"; // Catppuccin Macchiato subtext0 #a5adcb
const FG_LIGHT_GREEN = "\x1b[38;2;166;218;149m"; // Catppuccin Macchiato green #a6da95
const FG_LIGHT_RED = "\x1b[38;2;237;135;150m"; // Catppuccin Macchiato red #ed8796
const FG_WHITE = "\x1b[38;2;202;211;245m"; // Catppuccin Macchiato text #cad3f5
const RESET_ALL = "\x1b[0m";

/**
 * Applies dark blue background with light text to a line, padding to full width.
 * @param line - Line content to style
 * @param width - Total width to pad to
 * @returns Styled line with ANSI escape codes
 */
function withDarkBlueBg(line: string, width: number): string {
	const visLen = visibleWidth(line);
	const padding = " ".repeat(Math.max(0, width - visLen));
	// Reset any existing colors, then apply dark blue bg + white text
	return `${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}${line}${padding}${RESET_ALL}`;
}

/**
 * Apply shared process-output styling while preserving pre-colored ANSI lines.
 *
 * @param theme - Active UI theme
 * @param line - Raw output line
 * @returns Safely styled process-output line
 */
export function styleBackgroundOutputLine(theme: Theme, line: string): string {
	return dimProcessOutputLine(line, (value) =>
		formatPresentationText(theme, "process_output", value)
	);
}

interface BackgroundTask {
	id: string;
	command: string;
	cwd: string;
	startTime: number;
	endTime?: number;
	exitCode?: number | null;
	output: string[];
	outputBytes: number;
	process: ChildProcess | null;
	status: "running" | "completed" | "failed" | "killed";
}

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB max buffered output per task
const MAX_TASKS = 20; // Max concurrent/recent tasks

/** Reference to pi events bus, set when the extension initializes. */
let piEventsRef: ExtensionAPI["events"] | null = null;

/** Reference to pi extension API, for sendMessage from async close handlers. */
let piRef: ExtensionAPI | null = null;

/**
 * Abort controllers for promoted tasks (bash → background handoff).
 * Regular bg_bash tasks use ChildProcess.kill(); promoted tasks use AbortController.
 */
const promotedAbortControllers = new Map<string, AbortController>();

// TUI reference captured at session_start for Loader in renderResult
let tuiRef: TUI | null = null;

// Persistent Loader instances per streaming task (avoids leaking intervals)
const activeLoaders = new Map<string, InstanceType<typeof Loader>>();

// In-memory task registry (published via typed interop events)
const tasks = new Map<string, BackgroundTask>();
let taskCounter = 0;
let interopStateRequestCleanup: (() => void) | undefined;

/**
 * Build a serializable background task snapshot for cross-extension consumers.
 *
 * @returns Array of task views in insertion order
 */
function buildBackgroundTaskSnapshot(): InteropBackgroundTaskView[] {
	return [...tasks.values()].map((task) => ({
		command: task.command,
		id: task.id,
		startTime: task.startTime,
		status: task.status,
	}));
}

/**
 * Publish the current background task snapshot over the interop event bus.
 *
 * @param events - Shared extension event bus
 * @returns void
 */
function publishBackgroundTaskSnapshot(events: ExtensionAPI["events"]): void {
	emitInteropEvent(events, INTEROP_EVENT_NAMES.backgroundTasksSnapshot, {
		tasks: buildBackgroundTaskSnapshot(),
	});
}

/**
 * Generates a unique task ID combining counter and timestamp.
 * @returns Unique task identifier string
 */
function generateTaskId(): string {
	taskCounter++;
	return `bg_${taskCounter}_${Date.now().toString(36)}`;
}

/**
 * Removes oldest completed tasks when task count exceeds MAX_TASKS.
 */
function cleanupOldTasks(): void {
	if (tasks.size <= MAX_TASKS) return;

	// Remove oldest completed tasks
	const completed = [...tasks.entries()]
		.filter(([_, t]) => t.status !== "running")
		.sort((a, b) => (a[1].endTime || 0) - (b[1].endTime || 0));

	while (tasks.size > MAX_TASKS && completed.length > 0) {
		const entry = completed.shift();
		if (entry) tasks.delete(entry[0]);
	}
}

// ── Promoted Task API ────────────────────────────────────────────────────────

/**
 * Override bg_bash spawn implementation for tests.
 *
 * @internal
 * @param implementation - Custom spawn implementation (or undefined to restore default)
 * @returns Nothing
 */
export function setBackgroundTaskSpawnForTests(implementation?: typeof spawn): void {
	spawnProcess = implementation ?? spawn;
}

/** Handle for updating a task that was promoted from bash to background. */
export interface PromotedTaskHandle {
	/** The background task ID. */
	readonly id: string;
	/** Replace the task's entire output buffer (bash streams full text, not deltas). */
	replaceOutput(text: string): void;
	/** Mark the task as completed with the given exit code. */
	complete(exitCode: number | null): void;
}

/**
 * Promote a running bash command to a tracked background task.
 *
 * Called by bash-tool-enhanced when a command exceeds the auto-background
 * timeout. Creates a BackgroundTask entry in the shared registry so that
 * task_status, task_output, and task_kill all work on it.
 *
 * @param opts.command - The shell command string
 * @param opts.cwd - Working directory where the command was started
 * @param opts.startTime - Timestamp (ms) when the command originally started
 * @param opts.initialOutput - Output captured before promotion
 * @param opts.abortController - Controller to abort the underlying bash execution
 * @returns Handle for streaming updates and marking completion
 */
export function promoteToBackground(opts: {
	command: string;
	cwd: string;
	startTime: number;
	initialOutput: string;
	abortController: AbortController;
}): PromotedTaskHandle {
	const taskId = generateTaskId();
	const task: BackgroundTask = {
		id: taskId,
		command: opts.command,
		cwd: opts.cwd,
		startTime: opts.startTime,
		output: opts.initialOutput ? [opts.initialOutput] : [],
		outputBytes: opts.initialOutput?.length ?? 0,
		process: null,
		status: "running",
	};

	promotedAbortControllers.set(taskId, opts.abortController);
	tasks.set(taskId, task);
	cleanupOldTasks();

	if (piEventsRef) publishBackgroundTaskSnapshot(piEventsRef);

	return {
		id: taskId,
		replaceOutput(text: string) {
			task.output = [text];
			task.outputBytes = text.length;
		},
		complete(exitCode: number | null) {
			task.endTime = Date.now();
			task.exitCode = exitCode;
			task.status = exitCode === 0 ? "completed" : "failed";
			promotedAbortControllers.delete(taskId);
			if (piEventsRef) publishBackgroundTaskSnapshot(piEventsRef);
			// Post inline result for promoted tasks (bash → background handoff)
			if (piRef && isInlineResultsEnabled()) {
				const duration = formatDuration((task.endTime ?? Date.now()) - task.startTime);
				const output = task.output.join("");
				const preview = extractPreview(output, 3, 80);
				piRef.sendMessage({
					customType: "background-task-complete",
					content: `Task ${task.id} ${task.status} (${duration})`,
					display: true,
					details: {
						taskId: task.id,
						command: task.command,
						exitCode: task.exitCode ?? null,
						duration,
						preview,
						status: task.status as "completed" | "failed",
						timestamp: Date.now(),
					} satisfies BgTaskCompleteDetails,
				});
			}
		},
	};
}

/**
 * Formats milliseconds into human-readable duration (e.g., "5s", "2m 30s", "1h 15m").
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (minutes < 60) return `${minutes}m ${secs}s`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return `${hours}h ${mins}m`;
}

/**
 * Truncates a command string with ellipsis if it exceeds max length.
 * @param cmd - Command string to truncate
 * @param maxLen - Maximum length (default 40)
 * @returns Truncated command or original if short enough
 */
export function truncateCommand(cmd: string, maxLen = 40): string {
	if (cmd.length <= maxLen) return cmd;
	return `${cmd.substring(0, maxLen - 3)}...`;
}

// ── Exported detection patterns (testable) ───────────────────────────────────

/**
 * Regex detecting a backgrounding `&` in a shell command.
 * Matches single `&` not preceded by `&` (excludes `&&`) and not followed by `>` (excludes `&>`).
 */
export const BACKGROUND_AMPERSAND_PATTERN = /(?<!&)&(?!>)(?!&)(\s*$|\s*\n|\s*;|\s*\)|\s+[a-zA-Z])/;

/** Regex detecting heredoc markers — used to exempt `&` inside heredocs. */
export const HEREDOC_PATTERN = /<<[-]?\s*['"]?\w+['"]?/;

/** Pattern/reason pairs for commands likely to hang. */
export const HANG_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /docker exec[^|]*node -e/,
		reason: "docker exec with inline node script may hang if connections aren't closed",
	},
	{
		pattern: /docker exec[^|]*python -c/,
		reason: "docker exec with inline python script may hang if connections aren't closed",
	},
	{
		pattern: /docker exec[^|]*-it\s/,
		reason: "docker exec with interactive flag will hang",
	},
	{
		pattern: /docker exec[^|]*--interactive/,
		reason: "docker exec with --interactive will hang",
	},
	{
		pattern: /\bpsql\b[^|]*-c\s+["']/,
		reason: "psql with inline query may hang on connection issues",
	},
	{
		pattern: /\bmysql\b[^|]*-e\s+["']/,
		reason: "mysql with inline query may hang on connection issues",
	},
	{
		pattern: /\bnc\b[^|]*-l/,
		reason: "netcat listen mode will hang waiting for connections",
	},
	{
		pattern: /\btail\b[^|]*-f/,
		reason: "tail -f will run forever - use bg_bash",
	},
	{
		pattern: /\bwatch\b\s/,
		reason: "watch command runs forever - use bg_bash",
	},
];

/**
 * Detect if a command uses `&` for backgrounding (which hangs in pi).
 *
 * @param command - Shell command string
 * @returns True if the command backgrounds a process with `&`
 */
export function detectsBackgroundAmpersand(command: string): boolean {
	const hasAmpersand = BACKGROUND_AMPERSAND_PATTERN.test(command);
	const hasHeredoc = HEREDOC_PATTERN.test(command);
	return hasAmpersand && !hasHeredoc;
}

/**
 * Check if a command matches any known hang pattern.
 *
 * @param command - Shell command string
 * @returns The matching reason if found, or null
 */
export function detectsHangPattern(command: string): string | null {
	for (const { pattern, reason } of HANG_PATTERNS) {
		if (pattern.test(command)) return reason;
	}
	return null;
}

/**
 * Registers background task tools (bg_bash, task_output, task_status, task_kill) and /bg command.
 * @param pi - Extension API for registering tools and commands
 */
/** Details for inline background-task-complete messages. */
interface BgTaskCompleteDetails {
	readonly taskId: string;
	readonly command: string;
	readonly exitCode: number | null;
	readonly duration: string;
	readonly preview: string[];
	readonly status: "completed" | "failed" | "killed";
	readonly timestamp: number;
}

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
	piEventsRef = pi.events;
	piRef = pi;

	// Register inline result renderer for fire-and-forget task completions
	pi.registerMessageRenderer<BgTaskCompleteDetails>(
		"background-task-complete",
		(message, _options, theme) => {
			const d = message.details;
			if (!d) return undefined;

			const statusRole =
				d.status === "completed"
					? "status_success"
					: d.status === "killed"
						? "status_warning"
						: "status_error";
			const icon = d.status === "completed" ? getIcon("success") : getIcon("error");
			const label = d.status === "completed" ? "completed" : d.status;
			const lines: string[] = [];
			appendSection(lines, [
				formatPresentationText(theme, statusRole, `${icon} ⚙ Task ${d.taskId} ${label}`) +
					` ${formatPresentationText(theme, "meta", `(exit ${d.exitCode ?? "?"}, ${d.duration})`)}`,
			]);
			appendSection(lines, [formatSectionDivider(theme, "Preview")], { blankBefore: true });
			if (d.preview.length > 0) {
				appendSection(
					lines,
					d.preview.map((line) => `  ${styleBackgroundOutputLine(theme, line)}`)
				);
			} else {
				appendSection(lines, [formatPresentationText(theme, "meta", "  (no output)")]);
			}
			appendSection(
				lines,
				[
					formatPresentationText(
						theme,
						"hint",
						`Use task_output("${d.taskId}") to view full output`
					),
				],
				{ blankBefore: true }
			);

			return renderLines(lines, { wrap: true });
		}
	);

	/**
	 * Post an inline notification when a fire-and-forget task completes.
	 *
	 * Checks the inlineAgentResults setting before posting.
	 * Only fires for fire-and-forget tasks (background: true).
	 *
	 * @param task - Completed background task
	 * @returns void
	 */
	function postInlineResult(task: BackgroundTask): void {
		if (!piRef || !isInlineResultsEnabled()) return;
		// Skip killed tasks
		if (task.status === "killed") return;

		const duration = formatDuration((task.endTime ?? Date.now()) - task.startTime);
		const output = task.output.join("");
		const preview = extractPreview(output, 3, 80);

		piRef.sendMessage({
			customType: "background-task-complete",
			content: `Task ${task.id} ${task.status} (${duration})`,
			display: true,
			details: {
				taskId: task.id,
				command: task.command,
				exitCode: task.exitCode ?? null,
				duration,
				preview,
				status: task.status as "completed" | "failed",
				timestamp: Date.now(),
			} satisfies BgTaskCompleteDetails,
		});
	}

	/**
	 * Updates the status bar indicator for running background tasks.
	 * @param ctx - Extension context for UI access
	 */
	function updateWidget(ctx: ExtensionContext): void {
		// Guard: ctx.ui may be undefined if context is stale (e.g., from async callback after shutdown)
		if (!ctx?.ui) return;

		const running = [...tasks.values()].filter((t) => t.status === "running");

		if (running.length === 0) {
			ctx.ui.setStatus("bg-tasks", undefined);
			return;
		}

		// Status bar only - widget is rendered by tasks extension
		ctx.ui.setStatus("bg-tasks", `${FG_PURPLE}⚙ ${running.length} bg${RESET_ALL}`);
	}

	/**
	 * Sync background-task state to both local UI and cross-extension event consumers.
	 *
	 * @param ctx - Extension context for widget updates
	 * @returns void
	 */
	function syncTaskState(ctx: ExtensionContext): void {
		updateWidget(ctx);
		publishBackgroundTaskSnapshot(pi.events);
	}

	interopStateRequestCleanup?.();
	interopStateRequestCleanup = onInteropEvent(pi.events, INTEROP_EVENT_NAMES.stateRequest, () => {
		publishBackgroundTaskSnapshot(pi.events);
	});

	// Expose promoteToBackground to other extensions via event bus.
	// This avoids cross-extension static imports that break under jiti's
	// moduleCache:false (each extension gets its own module instance).
	const publishPromoteApi = () => {
		pi.events.emit(INTEROP_API_CHANNELS.promoteToBackgroundApi, { promote: promoteToBackground });
	};
	publishPromoteApi();
	pi.events.on(INTEROP_API_CHANNELS.promoteToBackgroundApiRequest, publishPromoteApi);

	// Tool: Run bash in background
	pi.registerTool({
		name: "bg_bash",
		label: "bg_bash",
		description:
			"Run a bash command in the background. By default, streams live output and waits for completion. Set background=true for fire-and-forget daemons/servers.\n\nWHEN TO USE:\n- Starting daemons or servers (with background: true)\n- Long-running builds or tests (default: streams output)\n- Any process you want to run independently\n\nWARNING: Never use bash tool with & to background processes - it will hang. Use bg_bash instead.",
		parameters: Type.Object({
			command: Type.String({
				description: "Bash command to run in background",
			}),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds (optional, default: no timeout)",
				})
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"If true, return immediately without streaming output. Use for daemons/servers.",
				})
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const taskId = generateTaskId();
			const cwd = ctx.cwd;
			const fireAndForget = params.background === true;

			const task: BackgroundTask = {
				id: taskId,
				command: params.command,
				cwd,
				startTime: Date.now(),
				output: [],
				outputBytes: 0,
				process: null,
				status: "running",
			};

			// Spawn the process
			const shell = process.env.SHELL || "/bin/bash";
			const child = spawnProcess(shell, ["-c", params.command], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});

			task.process = child;
			tasks.set(taskId, task);
			cleanupOldTasks();

			// Track PID for orphan cleanup if parent is killed (SIGKILL, OOM, crash)
			if (child.pid != null) {
				registerPid(child.pid, params.command);
			}

			// Buffer output (and stream if not fire-and-forget)
			const onData = (data: Buffer) => {
				// Guard: ignore data arriving after task is no longer running
				if (task.status !== "running") return;

				if (task.outputBytes < MAX_OUTPUT_BYTES) {
					const text = data.toString();
					task.output.push(text);
					task.outputBytes += data.length;

					if (task.outputBytes >= MAX_OUTPUT_BYTES) {
						task.output.push("\n[Output truncated - max buffer size reached]\n");
					}
				}

				// Stream live updates to the TUI
				if (!fireAndForget) {
					const output = task.output.join("");
					onUpdate?.({
						content: [{ type: "text", text: output || "(no output yet)" }],
						details: { taskId },
					});
				}
			};

			const lifecycle = createProcessLifecycle({
				child,
				onAbort: () => {
					task.endTime = Date.now();
					task.status = "killed";
					task.output.push("\n[Killed: aborted by user]\n");
					if (child.pid != null) unregisterPid(child.pid);
					task.process = null;
					syncTaskState(ctx);
				},
				onData,
				onTimeout: () => {
					task.endTime = Date.now();
					task.status = "killed";
					task.output.push(`\n[Killed: timeout after ${params.timeout}s]\n`);
					if (child.pid != null) unregisterPid(child.pid);
					task.process = null;
					syncTaskState(ctx);
				},
				signal: fireAndForget ? undefined : signal,
				timeoutMs: params.timeout && params.timeout > 0 ? params.timeout * 1000 : undefined,
			});

			const applyLifecycleResult = (result: {
				type: "close" | "error" | "aborted" | "timeout";
				code?: number | null;
				error?: Error;
			}) => {
				task.endTime = task.endTime ?? Date.now();
				task.process = null;

				switch (result.type) {
					case "close": {
						task.exitCode = result.code ?? null;
						if (task.status === "running") {
							task.status = result.code === 0 ? "completed" : "failed";
						}
						break;
					}
					case "error": {
						task.exitCode = null;
						if (task.status === "running") {
							task.status = "failed";
						}
						task.output.push(`\nError: ${result.error?.message ?? "Unknown error"}\n`);
						break;
					}
					case "aborted":
					case "timeout": {
						task.exitCode = null;
						if (task.status === "running") {
							task.status = "killed";
						}
						break;
					}
				}

				if (child.pid != null) {
					unregisterPid(child.pid);
				}
				syncTaskState(ctx);
			};

			// Fire-and-forget: return immediately
			if (fireAndForget) {
				void lifecycle.waitForExit().then((result) => {
					applyLifecycleResult({
						...(result.type === "close" ? { code: result.code } : {}),
						...(result.type === "error" ? { error: result.error } : {}),
						type: result.type,
					});
					postInlineResult(task);
				});
				lifecycle.detach();
				syncTaskState(ctx);

				return {
					details: { taskId, command: params.command, fireAndForget: true },
					content: [
						{
							type: "text",
							text: `Background task started (fire-and-forget).\nTask ID: ${taskId}\nCommand: ${params.command}\nUse task_output("${taskId}") to check later.`,
						},
					],
				};
			}

			// Streaming mode: wait for process to complete
			syncTaskState(ctx);

			const lifecycleResult = await lifecycle.waitForExit();
			applyLifecycleResult({
				...(lifecycleResult.type === "close" ? { code: lifecycleResult.code } : {}),
				...(lifecycleResult.type === "error" ? { error: lifecycleResult.error } : {}),
				type: lifecycleResult.type,
			});

			// Stop and clean up the persistent Loader for this task
			const loader = activeLoaders.get(taskId);
			if (loader) {
				loader.stop();
				activeLoaders.delete(taskId);
			}

			const output = task.output.join("");
			const duration = formatDuration((task.endTime || Date.now()) - task.startTime);

			return {
				details: {
					taskId,
					command: params.command,
					status: task.status,
					duration,
					exitCode: task.exitCode,
					output,
				},
				content: [
					{
						type: "text",
						text: output || "(no output)",
					},
				],
			};
		},

		renderCall(args, theme) {
			const cmd = truncateCommand(args.command as string, 60);
			const bg = args.background ? formatPresentationText(theme, "meta", " (detached)") : "";
			return new Text(
				formatPresentationText(theme, "title", "bg_bash ") +
					formatPresentationText(theme, "action", cmd) +
					bg,
				0,
				0
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as
				| {
						fireAndForget?: boolean;
						taskId?: string;
						status?: string;
						duration?: string;
						exitCode?: number | null;
				  }
				| undefined;

			// Fire-and-forget: compact one-liner
			if (details?.fireAndForget) {
				return renderLines([
					formatPresentationText(theme, "status_success", "⚙ Started (detached)"),
				]);
			}

			const COLLAPSED_LINES = 10;
			const EXPANDED_LINES = 50;

			// Extract output (available during streaming via onUpdate and after completion)
			const text = result.content[0];
			const output = text?.type === "text" ? text.text : "";

			// While running: show streamed output + loader spinner at bottom
			if (isPartial) {
				const container = new Container();

				if (output) {
					const allLines = output.split("\n").filter((l: string) => l.length > 0);
					const maxLines = COLLAPSED_LINES;
					const truncated = allLines.length > maxLines;
					const tail = truncated ? allLines.slice(-maxLines) : allLines;
					const lines: string[] = [];
					if (truncated) {
						appendSection(lines, [
							formatPresentationText(
								theme,
								"meta",
								`... ${allLines.length - maxLines} more lines above`
							),
						]);
					}
					appendSection(
						lines,
						tail.map((line) => styleBackgroundOutputLine(theme, line))
					);
					container.addChild(renderLines(lines, { wrap: true }));
				}

				// Reuse persistent Loader (one per task, avoids leaking intervals)
				const tid = details?.taskId ?? "__bg_default";
				let loader = activeLoaders.get(tid);
				if (!loader && tuiRef) {
					loader = new Loader(
						tuiRef,
						(s) => theme.fg("warning", s),
						(s) => theme.fg("muted", s),
						"Running..."
					);
					(loader as unknown as Record<string, string[]>).frames = getSpinner();
					activeLoaders.set(tid, loader);
				}
				if (loader) {
					container.addChild(loader);
				} else {
					container.addChild(
						new Text(formatPresentationText(theme, "status_warning", "Running..."), 0, 0)
					);
				}

				return container;
			}

			// Completed: show output
			if (!output) return renderLines([formatPresentationText(theme, "meta", "(no output)")]);

			const allLines = output.split("\n").filter((l: string) => l.length > 0);
			const maxLines = expanded ? EXPANDED_LINES : COLLAPSED_LINES;
			const truncated = allLines.length > maxLines;
			const tail = truncated ? allLines.slice(-maxLines) : allLines;
			const lines: string[] = [];

			if (truncated) {
				appendSection(lines, [
					formatPresentationText(
						theme,
						"meta",
						`... ${allLines.length - maxLines} more lines above`
					),
				]);
			}
			appendSection(
				lines,
				tail.map((line) => styleBackgroundOutputLine(theme, line))
			);
			if (truncated && !expanded) {
				appendSection(lines, [
					`${formatPresentationText(theme, "meta", `... ${allLines.length - maxLines} more lines`)} ${formatPresentationText(theme, "hint", keyHint("expandTools", "to expand"))}`,
				]);
			}

			if (details?.status) {
				const statusIcon =
					details.status === "completed"
						? getIcon("success")
						: details.status === "running"
							? getIcon("in_progress")
							: getIcon("error");
				const statusRole =
					details.status === "completed"
						? "status_success"
						: details.status === "running"
							? "status_warning"
							: "status_error";
				const statusMetaParts: string[] = [];
				if (details.exitCode !== null && details.exitCode !== undefined) {
					statusMetaParts.push(`exit ${details.exitCode}`);
				}
				if (details.duration) statusMetaParts.push(details.duration);
				const statusMeta = statusMetaParts.length > 0 ? ` (${statusMetaParts.join(", ")})` : "";
				appendSection(
					lines,
					[
						formatPresentationText(theme, statusRole, `${statusIcon} bg_bash ${details.status}`) +
							formatPresentationText(theme, "meta", statusMeta),
					],
					{ blankBefore: true }
				);
			}

			return renderLines(lines, { wrap: expanded });
		},
	});

	// Tool: Get task output
	pi.registerTool({
		name: "task_output",
		label: "task_output",
		description:
			"Retrieve the output from a background task. Can be called while task is still running to get partial output.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID returned by bg_bash" }),
			tail: Type.Optional(Type.Number({ description: "Only return last N lines (optional)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = tasks.get(params.taskId);

			if (!task) {
				return {
					details: { error: true },
					content: [
						{
							type: "text",
							text: `Task not found: ${params.taskId}\n\nAvailable tasks:\n${[...tasks.keys()].join("\n") || "(none)"}`,
						},
					],
				};
			}

			let output = task.output.join("");

			if (params.tail && params.tail > 0) {
				const lines = output.split("\n");
				output = lines.slice(-params.tail).join("\n");
			}

			const duration = formatDuration((task.endTime || Date.now()) - task.startTime);
			const statusLine =
				task.status === "running"
					? `Status: running (${duration})`
					: `Status: ${task.status} (exit code: ${task.exitCode}, duration: ${duration})`;

			return {
				details: {
					taskId: params.taskId,
					command: task.command,
					status: task.status,
					exitCode: task.exitCode,
					duration,
					outputLines: output.split("\n").length,
					outputBytes: task.outputBytes,
					output,
				},
				content: [
					{
						type: "text",
						text: `Task: ${params.taskId}\nCommand: ${task.command}\n${statusLine}\n\n--- Output ---\n${output || "(no output yet)"}`,
					},
				],
			};
		},

		renderCall(args, theme) {
			const taskId = args.taskId as string;
			const task = tasks.get(taskId);
			const cmd = task ? truncateCommand(task.command, 40) : "";
			let text =
				formatPresentationText(theme, "title", "task_output ") +
				formatPresentationText(theme, "identity", taskId);
			if (cmd) text += ` ${formatPresentationText(theme, "meta", cmd)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const COLLAPSED_LINES = 10;
			const EXPANDED_LINES = 50;

			const details = result.details as
				| {
						taskId?: string;
						command?: string;
						status?: string;
						exitCode?: number | null;
						duration?: string;
						outputLines?: number;
						outputBytes?: number;
						output?: string;
						error?: boolean;
				  }
				| undefined;

			// Error case — show full text
			if (details?.error) {
				const text = result.content[0];
				return renderLines([
					formatPresentationText(
						theme,
						"status_error",
						text?.type === "text" ? text.text : "Error"
					),
				]);
			}

			const status = details?.status ?? "unknown";
			const duration = details?.duration ?? "";

			// Status icon
			let icon: string;
			let statusRole: "status_success" | "status_warning" | "status_error";
			switch (status) {
				case "running":
					icon = getIcon("in_progress");
					statusRole = "status_warning";
					break;
				case "completed":
					icon = getIcon("success");
					statusRole = "status_success";
					break;
				default:
					icon = getIcon("error");
					statusRole = "status_error";
			}

			const lines: string[] = [];
			appendSection(lines, [
				formatPresentationText(theme, statusRole, `${icon} ${status}`) +
					formatPresentationText(theme, "meta", ` (${duration})`),
			]);

			// Show output tail (always — collapsed=10 lines, expanded=50)
			if (details?.output) {
				const allLines = details.output.split("\n").filter((l) => l.length > 0);
				const maxLines = expanded ? EXPANDED_LINES : COLLAPSED_LINES;
				const truncated = allLines.length > maxLines;
				const tail = truncated ? allLines.slice(-maxLines) : allLines;

				appendSection(lines, [formatSectionDivider(theme, "Output")], { blankBefore: true });
				if (truncated) {
					appendSection(lines, [
						formatPresentationText(
							theme,
							"meta",
							`  ... ${allLines.length - maxLines} more lines above`
						),
					]);
				}
				appendSection(
					lines,
					tail.map((line) => `  ${styleBackgroundOutputLine(theme, line)}`)
				);

				if (!expanded && truncated) {
					appendSection(lines, [
						formatPresentationText(theme, "hint", keyHint("expandTools", "to show more")),
					]);
				}
			} else {
				appendSection(lines, [formatPresentationText(theme, "meta", "(no output yet)")], {
					blankBefore: true,
				});
			}

			return renderLines(lines, { wrap: expanded });
		},
	});

	// Tool: Check task status
	pi.registerTool({
		name: "task_status",
		label: "task_status",
		description: "Check if a background task is still running or has completed.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID returned by bg_bash" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = tasks.get(params.taskId);

			if (!task) {
				return {
					details: { error: true },
					content: [
						{
							type: "text",
							text: `Task not found: ${params.taskId}`,
						},
					],
				};
			}

			const duration = formatDuration((task.endTime || Date.now()) - task.startTime);

			return {
				details: {
					taskId: task.id,
					status: task.status,
					exitCode: task.exitCode,
					duration,
				},
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								taskId: task.id,
								command: task.command,
								status: task.status,
								exitCode: task.exitCode,
								duration,
								outputBytes: task.outputBytes,
							},
							null,
							2
						),
					},
				],
			};
		},

		renderCall(args, theme) {
			return new Text(
				formatPresentationText(theme, "title", "task_status ") +
					formatPresentationText(theme, "identity", args.taskId as string),
				0,
				0
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as
				| { status?: string; duration?: string; error?: boolean }
				| undefined;
			if (details?.error) {
				const text = result.content[0];
				return renderLines([
					formatPresentationText(
						theme,
						"status_error",
						text?.type === "text" ? text.text : "Not found"
					),
				]);
			}
			const status = details?.status ?? "unknown";
			const duration = details?.duration ?? "";
			const icon =
				status === "running"
					? getIcon("in_progress")
					: status === "completed"
						? getIcon("success")
						: getIcon("error");
			const statusRole: "status_success" | "status_warning" | "status_error" =
				status === "completed"
					? "status_success"
					: status === "running"
						? "status_warning"
						: "status_error";
			return renderLines([
				formatPresentationText(theme, statusRole, `${icon} ${status}`) +
					formatPresentationText(theme, "meta", ` (${duration})`),
			]);
		},
	});

	// Tool: Kill a background task
	pi.registerTool({
		name: "task_kill",
		label: "task_kill",
		description: "Kill a running background task.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to kill" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = tasks.get(params.taskId);

			if (!task) {
				return {
					details: { error: true },
					content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
				};
			}

			if (task.status !== "running") {
				return {
					details: { error: true },
					content: [
						{
							type: "text",
							text: `Task ${params.taskId} is not running (status: ${task.status})`,
						},
					],
				};
			}

			// Kill via ChildProcess (regular bg_bash) or AbortController (promoted from bash)
			if (task.process) {
				if (task.process.pid != null) unregisterPid(task.process.pid);
				task.process.kill("SIGTERM");
			} else {
				const abort = promotedAbortControllers.get(params.taskId);
				if (abort) {
					abort.abort();
					promotedAbortControllers.delete(params.taskId);
				}
			}
			task.status = "killed";
			task.endTime = Date.now();
			task.output.push("\n[Killed by user]\n");

			syncTaskState(ctx);

			return {
				details: { taskId: params.taskId, killed: true },
				content: [{ type: "text", text: `Killed task ${params.taskId}` }],
			};
		},

		renderCall(args, theme) {
			return new Text(
				formatPresentationText(theme, "title", "task_kill ") +
					formatPresentationText(theme, "status_error", args.taskId as string),
				0,
				0
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { killed?: boolean; error?: boolean } | undefined;
			if (details?.error) {
				const text = result.content[0];
				return renderLines([
					formatPresentationText(
						theme,
						"status_error",
						text?.type === "text" ? text.text : "Error"
					),
				]);
			}
			return renderLines([
				formatPresentationText(theme, "status_warning", `${getIcon("error")} Killed`),
			]);
		},
	});

	// Command: /bg - List and manage background tasks with interactive viewer
	pi.registerCommand("bg", {
		description: "List and manage background tasks (interactive viewer)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";
			const rest = parts.slice(1).join(" ");

			// Quick subcommands
			if (subcommand === "kill" && rest) {
				const task = tasks.get(rest);
				if (!task) {
					ctx.ui.notify(`Task not found: ${rest}`, "error");
					return;
				}
				if (task.status !== "running") {
					ctx.ui.notify(`Task ${rest} is not running`, "error");
					return;
				}
				if (task.process) {
					if (task.process.pid != null) unregisterPid(task.process.pid);
					task.process.kill("SIGTERM");
				} else {
					const abort = promotedAbortControllers.get(rest);
					if (abort) {
						abort.abort();
						promotedAbortControllers.delete(rest);
					}
				}
				task.status = "killed";
				task.endTime = Date.now();
				syncTaskState(ctx);
				ctx.ui.notify(`Killed task ${rest}`, "info");
				return;
			}

			if (subcommand === "clear") {
				const completed = [...tasks.entries()].filter(([_, t]) => t.status !== "running");
				for (const [id] of completed) {
					tasks.delete(id);
				}
				syncTaskState(ctx);
				ctx.ui.notify(`Cleared ${completed.length} completed tasks`, "info");
				return;
			}

			// No tasks? Show message
			if (tasks.size === 0) {
				ctx.ui.notify(
					"No background tasks.\n\n" +
						"To run a command in background, ask the agent to use bg_bash,\n" +
						"or say 'run [command] in the background'.",
					"info"
				);
				return;
			}

			// Hide the widget and status BEFORE opening the viewer (avoid duplication)
			ctx.ui.setWidget("bg-tasks", undefined);
			ctx.ui.setStatus("bg-tasks", undefined);

			// Interactive task viewer
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				type ViewMode = "list" | "output";
				let mode: ViewMode = "list";
				let selectedIndex = 0;
				let selectedTaskId: string | null = null;
				let scrollOffset = 0;
				let cachedLines: string[] | undefined;
				let refreshInterval: NodeJS.Timeout | null = null;

				// Start auto-refresh for live output
				refreshInterval = setInterval(() => {
					cachedLines = undefined;
					tui.requestRender();
				}, 500);

				function getTaskList(): BackgroundTask[] {
					return [...tasks.values()].sort((a, b) => b.startTime - a.startTime);
				}

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function cleanup() {
					if (refreshInterval) {
						clearInterval(refreshInterval);
						refreshInterval = null;
					}
					// Restore the widget when closing the viewer
					syncTaskState(ctx);
				}

				function handleInput(data: string) {
					const taskList = getTaskList();

					if (mode === "list") {
						// List mode navigation
						if (matchesKey(data, Key.up)) {
							selectedIndex = Math.max(0, selectedIndex - 1);
							refresh();
							return true;
						}
						if (matchesKey(data, Key.down)) {
							selectedIndex = Math.min(taskList.length - 1, selectedIndex + 1);
							refresh();
							return true;
						}
						if (matchesKey(data, Key.enter)) {
							if (taskList.length > 0) {
								selectedTaskId = taskList[selectedIndex].id;
								mode = "output";
								scrollOffset = 0;
								refresh();
							}
							return true;
						}
						if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
							cleanup();
							done();
							return true;
						}
						// Kill with 'k' or 'x'
						if ((data === "k" || data === "x") && taskList.length > 0) {
							const task = taskList[selectedIndex];
							if (task.status === "running") {
								if (task.process) {
									if (task.process.pid != null) unregisterPid(task.process.pid);
									task.process.kill("SIGTERM");
								} else {
									const abort = promotedAbortControllers.get(task.id);
									if (abort) {
										abort.abort();
										promotedAbortControllers.delete(task.id);
									}
								}
								task.status = "killed";
								task.endTime = Date.now();
								publishBackgroundTaskSnapshot(pi.events);
								refresh();
							}
							return true;
						}
					} else if (mode === "output") {
						// Output view navigation
						if (
							matchesKey(data, Key.escape) ||
							matchesKey(data, "q") ||
							matchesKey(data, Key.left)
						) {
							mode = "list";
							selectedTaskId = null;
							refresh();
							return true;
						}
						if (matchesKey(data, Key.up)) {
							scrollOffset = Math.max(0, scrollOffset - 1);
							refresh();
							return true;
						}
						if (matchesKey(data, Key.down)) {
							scrollOffset++;
							refresh();
							return true;
						}
						if (matchesKey(data, Key.pageUp)) {
							scrollOffset = Math.max(0, scrollOffset - 10);
							refresh();
							return true;
						}
						if (matchesKey(data, Key.pageDown)) {
							scrollOffset += 10;
							refresh();
							return true;
						}
						// Kill with 'k' or 'x'
						if ((data === "k" || data === "x") && selectedTaskId) {
							const task = tasks.get(selectedTaskId);
							if (task && task.status === "running") {
								if (task.process) {
									if (task.process.pid != null) unregisterPid(task.process.pid);
									task.process.kill("SIGTERM");
								} else {
									const abort = promotedAbortControllers.get(selectedTaskId);
									if (abort) {
										abort.abort();
										promotedAbortControllers.delete(selectedTaskId);
									}
								}
								task.status = "killed";
								task.endTime = Date.now();
								publishBackgroundTaskSnapshot(pi.events);
								refresh();
							}
							return true;
						}
						// 'g' to go to top, 'G' to go to bottom
						if (data === "g") {
							scrollOffset = 0;
							refresh();
							return true;
						}
						if (data === "G") {
							scrollOffset = 99_999; // Will be clamped in render
							refresh();
							return true;
						}
					}
					return true;
				}

				function render(width: number): string[] {
					if (cachedLines && cachedLines.length > 0) return cachedLines;

					const rawLines: string[] = [];
					const height = tui.terminal.rows - 4; // Leave room for header/footer
					const taskList = getTaskList();

					if (mode === "list") {
						// Header - light blue on dark blue bg
						rawLines.push(
							`${FG_PURPLE_MUTED}${theme.bold(" Background Tasks")} (${taskList.length})${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}`
						);
						rawLines.push("");

						// Task list - light colors for contrast on dark blue bg
						for (let i = 0; i < taskList.length; i++) {
							const task = taskList[i];
							const isSelected = i === selectedIndex;
							const duration = formatDuration((task.endTime || Date.now()) - task.startTime);

							let statusIcon: string;
							let iconColor: string;
							switch (task.status) {
								case "running":
									statusIcon = getIcon("in_progress");
									iconColor = FG_PURPLE; // Light blue dot
									break;
								case "completed":
									statusIcon = getIcon("success");
									iconColor = FG_LIGHT_GREEN; // Light green
									break;
								case "killed":
									statusIcon = getIcon("error");
									iconColor = FG_LIGHT_RED; // Light red
									break;
								default:
									statusIcon = "!";
									iconColor = FG_LIGHT_RED;
							}

							const prefix = isSelected
								? `${FG_PURPLE} > ${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}`
								: "   ";
							const icon = `${iconColor}${statusIcon}${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}`;
							const cmd = truncateCommand(task.command, width - 30);
							const info = ` [${task.status}, ${duration}]`;

							if (isSelected) {
								rawLines.push(
									`${prefix + icon} ${FG_PURPLE}${cmd}${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}${info}`
								);
							} else {
								rawLines.push(`${prefix + icon} ${cmd}${info}`);
							}
						}

						rawLines.push("");
						rawLines.push(" ↑↓ navigate • Enter view output • k kill • q close");
					} else if (mode === "output" && selectedTaskId) {
						const task = tasks.get(selectedTaskId);
						if (!task) {
							mode = "list";
							return render(width);
						}

						const duration = formatDuration((task.endTime || Date.now()) - task.startTime);
						let statusText: string;
						switch (task.status) {
							case "running":
								statusText = `${FG_PURPLE}${getIcon("in_progress")} RUNNING${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}`;
								break;
							case "completed":
								statusText = `${FG_LIGHT_GREEN}${getIcon("success")} COMPLETED${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}`;
								break;
							case "killed":
								statusText = `${FG_LIGHT_RED}${getIcon("error")} KILLED${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}`;
								break;
							default:
								statusText = `${FG_LIGHT_RED}! FAILED${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}`;
						}

						// Header - light blue on dark blue
						rawLines.push(
							`${FG_PURPLE}${theme.bold(" Task Output")}${RESET_ALL}${BG_DARK_GRAY}${FG_WHITE}  ${statusText} (${duration})`
						);
						rawLines.push(` ${truncateCommand(task.command, width - 4)}`);
						rawLines.push("");

						// Output content
						const outputText = task.output.join("");
						const outputLines = outputText.split("\n");

						// Clamp scroll offset
						const maxScroll = Math.max(0, outputLines.length - (height - 8));
						scrollOffset = Math.min(scrollOffset, maxScroll);

						const visibleLines = outputLines.slice(scrollOffset, scrollOffset + height - 8);

						if (visibleLines.length === 0) {
							rawLines.push(" (no output yet)");
						} else {
							for (const line of visibleLines) {
								rawLines.push(` ${truncateToWidth(line, width - 2)}`);
							}
						}

						// Scroll indicator
						if (outputLines.length > height - 8) {
							const scrollPct = Math.round((scrollOffset / maxScroll) * 100);
							rawLines.push("");
							rawLines.push(
								` [${scrollOffset + 1}-${Math.min(scrollOffset + height - 8, outputLines.length)}/${outputLines.length}] ${scrollPct}%`
							);
						}

						rawLines.push("");
						const killHint = task.status === "running" ? " • k kill" : "";
						rawLines.push(` Esc/q back • ↑↓ scroll • g/G top/bottom${killHint}`);
					}

					// Apply dark blue background to all lines
					cachedLines = rawLines.map((line) => withDarkBlueBg(line, width));
					return cachedLines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			// Force a full re-render to clean up stale content from the full-screen viewer.
			// showExtensionCustom only calls requestRender() (non-force) when restoring the editor,
			// which leaves stale lines on screen because clearOnShrink is off by default.
			tuiRef?.requestRender(true);
			syncTaskState(ctx);
		},
	});

	// Command: /toggle-inline-results — Enable or disable inline completion notifications
	pi.registerCommand("toggle-inline-results", {
		description: "Toggle inline result notifications for background tasks and subagents",
		handler: async (_args, ctx) => {
			const settingsPath = getTallowSettingsPath();
			let settings: Record<string, unknown> = {};
			try {
				const raw = fs.readFileSync(settingsPath, "utf-8");
				settings = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				/* no settings file yet */
			}

			const current = settings.inlineAgentResults !== false;
			settings.inlineAgentResults = !current;

			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"), "utf-8");

			const state = settings.inlineAgentResults ? "enabled" : "disabled";
			ctx.ui.notify(`Inline agent results: ${state}`, "info");
		},
	});

	// Cleanup on session end
	pi.on("session_shutdown", async () => {
		// Kill all running tasks and unregister PIDs
		for (const task of tasks.values()) {
			if (task.status === "running") {
				if (task.process) {
					if (task.process.pid != null) unregisterPid(task.process.pid);
					task.process.kill("SIGTERM");
				} else {
					const abort = promotedAbortControllers.get(task.id);
					if (abort) abort.abort();
				}
			}
		}
		tasks.clear();
		promotedAbortControllers.clear();
		publishBackgroundTaskSnapshot(pi.events);
		interopStateRequestCleanup?.();
		interopStateRequestCleanup = undefined;
	});

	// Capture TUI reference and update status on session start
	pi.on("session_start", async (_event, ctx) => {
		// Capture TUI via a throwaway widget so Loader can be used in renderResult
		ctx.ui.setWidget("bg-tasks-tui-capture", (tui, _theme) => {
			tuiRef = tui;
			return { render: () => [], invalidate: () => {} };
		});
		// Immediately remove — we just needed the reference
		ctx.ui.setWidget("bg-tasks-tui-capture", undefined);

		ctx.ui.setStatus("bg-tasks", undefined);
		syncTaskState(ctx);
	});

	// Register Ctrl+Shift+B shortcut for background tasks
	// Note: only works when TUI is idle, not during tool execution
	pi.registerShortcut(Key.ctrlShift("b"), {
		description: "Show background tasks (Note: use bg_bash tool to run commands in background)",
		handler: async (ctx) => {
			const running = [...tasks.values()].filter((t) => t.status === "running");

			if (running.length === 0) {
				ctx.ui.notify(
					"No background tasks running.\n\n" +
						"To run a command in background, ask the agent to use the bg_bash tool,\n" +
						"or say 'run [command] in the background'.",
					"info"
				);
			} else {
				const lines = running.map((t) => {
					const duration = formatDuration(Date.now() - t.startTime);
					return `${getIcon("in_progress")} ${t.id}: ${truncateCommand(t.command, 40)} (${duration})`;
				});
				ctx.ui.notify(`Running Background Tasks:\n${lines.join("\n")}`, "info");
			}
		},
	});

	// Enforce shell policy for bg_bash tool calls — denies denylist hits outright
	// and prompts for confirmation on high-risk commands in interactive mode.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bg_bash") return;

		const command = (event.input as Record<string, unknown>).command as string | undefined;
		if (!command) return;

		return enforceExplicitPolicy(command, "bg_bash", ctx.cwd, ctx.hasUI, (msg) =>
			ctx.ui.confirm("Shell Policy", msg)
		);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bg_bash") return;
		const command = (event.input as Record<string, unknown>).command;
		if (typeof command !== "string" || command.trim().length === 0) return;

		const details = (
			event as unknown as { details?: { exitCode?: number | null; status?: string } }
		).details;
		recordAudit({
			timestamp: Date.now(),
			command: command.trim(),
			source: "bg_bash",
			trustLevel: "explicit",
			cwd: ctx.cwd,
			outcome: event.isError || details?.status === "failed" ? "failed" : "executed",
			exitCode: details?.exitCode ?? null,
		});
	});

	// Intercept bash commands with & backgrounding and block them
	// This prevents the common mistake of using `bash &` which hangs forever
	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName !== "bash") return;

		const command = event.input?.command as string | undefined;
		if (!command) return;

		if (detectsBackgroundAmpersand(command)) {
			return {
				block: true,
				reason:
					"Cannot use & to background processes in bash - it will hang forever.\n" +
					"Use the bg_bash tool instead for background tasks.",
			};
		}

		const hangReason = detectsHangPattern(command);
		if (hangReason) {
			return {
				block: true,
				reason: `This command is likely to hang: ${hangReason}\n\nUse bg_bash instead for commands that may not exit promptly.`,
			};
		}
	});
}
