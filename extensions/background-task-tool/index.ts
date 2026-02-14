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
import { type ExtensionAPI, type ExtensionContext, keyHint } from "@mariozechner/pi-coding-agent";
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
import { enforceExplicitPolicy, recordAudit } from "../_shared/shell-policy.js";

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

// TUI reference captured at session_start for Loader in renderResult
let tuiRef: TUI | null = null;

// Persistent Loader instances per streaming task (avoids leaking intervals)
const activeLoaders = new Map<string, InstanceType<typeof Loader>>();

// Global task registry (exposed via globalThis for tasks extension to read)
const tasks = new Map<string, BackgroundTask>();
globalThis.__piBackgroundTasks = tasks as unknown as GlobalMap;
let taskCounter = 0;

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

/**
 * Formats milliseconds into human-readable duration (e.g., "5s", "2m 30s", "1h 15m").
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
function formatDuration(ms: number): string {
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
function truncateCommand(cmd: string, maxLen = 40): string {
	if (cmd.length <= maxLen) return cmd;
	return `${cmd.substring(0, maxLen - 3)}...`;
}

/**
 * Registers background task tools (bg_bash, task_output, task_status, task_kill) and /bg command.
 * @param pi - Extension API for registering tools and commands
 */
export default function backgroundTasksExtension(pi: ExtensionAPI): void {
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

	// Tool: Run bash in background
	pi.registerTool({
		name: "bg_bash",
		label: "Background Bash",
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
			const child = spawn(shell, ["-c", params.command], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});

			task.process = child;
			tasks.set(taskId, task);
			cleanupOldTasks();

			// Buffer output (and stream if not fire-and-forget)
			const onData = (data: Buffer) => {
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

			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);

			// Handle timeout
			if (params.timeout && params.timeout > 0) {
				setTimeout(() => {
					if (task.status === "running" && task.process) {
						task.process.kill("SIGTERM");
						task.status = "killed";
						task.output.push(`\n[Killed: timeout after ${params.timeout}s]\n`);
					}
				}, params.timeout * 1000);
			}

			// Fire-and-forget: return immediately
			if (fireAndForget) {
				// Handle completion in background
				child.on("close", (code) => {
					task.endTime = Date.now();
					task.exitCode = code;
					task.status = code === 0 ? "completed" : "failed";
					task.process = null;
					updateWidget(ctx);
				});
				child.on("error", (err) => {
					task.endTime = Date.now();
					task.status = "failed";
					task.output.push(`\nError: ${err.message}\n`);
					task.process = null;
					updateWidget(ctx);
				});
				child.unref();
				updateWidget(ctx);

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
			updateWidget(ctx);

			const result = await new Promise<{
				exitCode: number | null;
				error?: string;
			}>((resolve) => {
				child.on("close", (code) => {
					task.endTime = Date.now();
					task.exitCode = code;
					task.status = code === 0 ? "completed" : "failed";
					task.process = null;
					updateWidget(ctx);
					resolve({ exitCode: code });
				});
				child.on("error", (err) => {
					task.endTime = Date.now();
					task.status = "failed";
					task.output.push(`\nError: ${err.message}\n`);
					task.process = null;
					updateWidget(ctx);
					resolve({ exitCode: null, error: err.message });
				});

				// Kill on abort signal (e.g., user presses Escape)
				signal?.addEventListener("abort", () => {
					if (task.status === "running" && task.process) {
						task.process.kill("SIGTERM");
						task.status = "killed";
						task.endTime = Date.now();
						task.output.push("\n[Killed: aborted by user]\n");
						updateWidget(ctx);
						resolve({ exitCode: null, error: "Aborted" });
					}
				});
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
					exitCode: result.exitCode,
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
			const bg = args.background ? theme.fg("dim", " (detached)") : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("bg_bash ")) + theme.fg("muted", cmd) + bg,
				0,
				0
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as { fireAndForget?: boolean; taskId?: string } | undefined;

			// Fire-and-forget: compact one-liner
			if (details?.fireAndForget) {
				return new Text(theme.fg("success", "⚙ Started (detached)"), 0, 0);
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

					let rendered = "";
					if (truncated) {
						rendered += `${theme.fg("dim", `... ${allLines.length - maxLines} more lines above`)}\n`;
					}
					for (let i = 0; i < tail.length; i++) {
						rendered += theme.fg("muted", tail[i]);
						if (i < tail.length - 1) rendered += "\n";
					}
					container.addChild(new Text(rendered, 0, 0));
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
					container.addChild(new Text(theme.fg("bashMode", "Running..."), 0, 0));
				}

				return container;
			}

			// Completed: show output
			if (!output) return new Text(theme.fg("dim", "(no output)"), 0, 0);

			const allLines = output.split("\n").filter((l: string) => l.length > 0);
			const maxLines = expanded ? EXPANDED_LINES : COLLAPSED_LINES;
			const truncated = allLines.length > maxLines;
			const tail = truncated ? allLines.slice(-maxLines) : allLines;

			let rendered = "";
			if (truncated) {
				rendered += `${theme.fg("dim", `... ${allLines.length - maxLines} more lines above`)}\n`;
			}
			for (let i = 0; i < tail.length; i++) {
				rendered += theme.fg("toolOutput", tail[i]);
				if (i < tail.length - 1) rendered += "\n";
			}
			if (truncated && !expanded) {
				rendered += `\n${theme.fg("dim", `... ${allLines.length - maxLines} more lines`)} ${keyHint("expandTools", "to expand")}`;
			}

			return new Text(rendered, 0, 0);
		},
	});

	// Tool: Get task output
	pi.registerTool({
		name: "task_output",
		label: "Task Output",
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
			let text = theme.fg("toolTitle", theme.bold("task_output ")) + theme.fg("accent", taskId);
			if (cmd) text += theme.fg("dim", ` ${cmd}`);
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
				return new Text(theme.fg("error", text?.type === "text" ? text.text : "Error"), 0, 0);
			}

			const status = details?.status ?? "unknown";
			const duration = details?.duration ?? "";

			// Status icon
			let icon: string;
			let statusColor: "success" | "warning" | "error" | "accent";
			switch (status) {
				case "running":
					icon = getIcon("in_progress");
					statusColor = "accent";
					break;
				case "completed":
					icon = getIcon("success");
					statusColor = "success";
					break;
				default:
					icon = getIcon("error");
					statusColor = "error";
			}

			// Header line
			let text = theme.fg(statusColor, `${icon} ${status}`) + theme.fg("muted", ` (${duration})`);

			// Show output tail (always — collapsed=10 lines, expanded=50)
			if (details?.output) {
				const allLines = details.output.split("\n").filter((l) => l.length > 0);
				const maxLines = expanded ? EXPANDED_LINES : COLLAPSED_LINES;
				const truncated = allLines.length > maxLines;
				const tail = truncated ? allLines.slice(-maxLines) : allLines;

				if (truncated) {
					text += `\n${theme.fg("dim", `  ... ${allLines.length - maxLines} more lines above`)}`;
				}
				for (const line of tail) {
					text += `\n${theme.fg("dim", `  ${line}`)}`;
				}

				if (!expanded && truncated) {
					text += `\n${keyHint("expandTools", "to show more")}`;
				}
			} else {
				text += theme.fg("dim", " (no output yet)");
			}

			return new Text(text, 0, 0);
		},
	});

	// Tool: Check task status
	pi.registerTool({
		name: "task_status",
		label: "Task Status",
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
				theme.fg("toolTitle", theme.bold("task_status ")) +
					theme.fg("accent", args.taskId as string),
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
				return new Text(theme.fg("error", text?.type === "text" ? text.text : "Not found"), 0, 0);
			}
			const status = details?.status ?? "unknown";
			const duration = details?.duration ?? "";
			const icon =
				status === "running"
					? getIcon("in_progress")
					: status === "completed"
						? getIcon("success")
						: getIcon("error");
			const color: "success" | "accent" | "error" =
				status === "completed" ? "success" : status === "running" ? "accent" : "error";
			return new Text(
				theme.fg(color, `${icon} ${status}`) + theme.fg("muted", ` (${duration})`),
				0,
				0
			);
		},
	});

	// Tool: Kill a background task
	pi.registerTool({
		name: "task_kill",
		label: "Kill Task",
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

			if (task.status !== "running" || !task.process) {
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

			task.process.kill("SIGTERM");
			task.status = "killed";
			task.endTime = Date.now();
			task.output.push("\n[Killed by user]\n");

			updateWidget(ctx);

			return {
				details: { taskId: params.taskId, killed: true },
				content: [{ type: "text", text: `Killed task ${params.taskId}` }],
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("task_kill ")) + theme.fg("error", args.taskId as string),
				0,
				0
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { killed?: boolean; error?: boolean } | undefined;
			if (details?.error) {
				const text = result.content[0];
				return new Text(theme.fg("error", text?.type === "text" ? text.text : "Error"), 0, 0);
			}
			return new Text(theme.fg("warning", `${getIcon("error")} Killed`), 0, 0);
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
				if (task.status !== "running" || !task.process) {
					ctx.ui.notify(`Task ${rest} is not running`, "error");
					return;
				}
				task.process.kill("SIGTERM");
				task.status = "killed";
				task.endTime = Date.now();
				updateWidget(ctx);
				ctx.ui.notify(`Killed task ${rest}`, "info");
				return;
			}

			if (subcommand === "clear") {
				const completed = [...tasks.entries()].filter(([_, t]) => t.status !== "running");
				for (const [id] of completed) {
					tasks.delete(id);
				}
				updateWidget(ctx);
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
					updateWidget(ctx);
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
							if (task.status === "running" && task.process) {
								task.process.kill("SIGTERM");
								task.status = "killed";
								task.endTime = Date.now();
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
							if (task && task.status === "running" && task.process) {
								task.process.kill("SIGTERM");
								task.status = "killed";
								task.endTime = Date.now();
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

			updateWidget(ctx);
		},
	});

	// Cleanup on session end
	pi.on("session_shutdown", async () => {
		// Kill all running tasks
		for (const task of tasks.values()) {
			if (task.status === "running" && task.process) {
				task.process.kill("SIGTERM");
			}
		}
		tasks.clear();
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
		updateWidget(ctx);
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

		// Detect & used for backgrounding
		// Key insight: a backgrounding & is a SINGLE & that is:
		// - Not preceded by another & (that would be &&)
		// - Not followed by > (that would be &> redirect)
		// - Followed by: end of string, whitespace+newline, semicolon, ), or space+word

		// Pattern: single & followed by end, newline, semicolon, paren, or space+word
		// (?<!&) = not preceded by &
		// (?!>) = not followed by > (excludes &>)
		// (?!&) = not followed by & (excludes &&)
		const backgroundPattern = /(?<!&)&(?!>)(?!&)(\s*$|\s*\n|\s*;|\s*\)|\s+[a-zA-Z])/;

		const hasBackgroundAmpersand = backgroundPattern.test(command);

		// Exclude if & only appears inside heredocs
		// Simple heuristic: if there's a heredoc marker, be conservative
		const hasHeredoc = /<<[-]?\s*['"]?\w+['"]?/.test(command);

		if (hasBackgroundAmpersand && !hasHeredoc) {
			return {
				block: true,
				reason:
					"Cannot use & to background processes in bash - it will hang forever.\n" +
					"Use the bg_bash tool instead for background tasks.",
			};
		}

		// Detect commands likely to hang (should use bg_bash instead)
		// These patterns open persistent connections or run interactive sessions
		const hangPatterns: Array<{ pattern: RegExp; reason: string }> = [
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

		for (const { pattern, reason } of hangPatterns) {
			if (pattern.test(command)) {
				return {
					block: true,
					reason: `This command is likely to hang: ${reason}\n\nUse bg_bash instead for commands that may not exit promptly.`,
				};
			}
		}
	});
}
