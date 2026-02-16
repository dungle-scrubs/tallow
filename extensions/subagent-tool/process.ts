/**
 * Subagent process spawning and execution.
 *
 * Handles spawning pi subprocesses for both foreground (inline) and
 * background execution modes, including model routing, retry logic,
 * and permission denial detection.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractPreview, isInlineResultsEnabled } from "../_shared/inline-preview.js";
import { expandFileReferences } from "../file-reference/index.js";
import type { AgentConfig, AgentDefaults } from "./agents.js";
import { computeEffectiveTools, resolveAgentForExecution } from "./agents.js";
import { getFinalOutput, type SingleResult, type SubagentDetails } from "./formatting.js";
import type { RoutingHints } from "./model-router.js";
import { routeModel } from "./model-router.js";
import type {
	SubagentCompleteDetails,
	SubagentStartEvent,
	SubagentStopEvent,
	SubagentToolCallEvent,
	SubagentToolResultEvent,
} from "./schema.js";
import type { BackgroundSubagent } from "./widget.js";
import {
	backgroundSubagents,
	completeForegroundSubagent,
	formatDuration,
	generateId,
	publishSubagentSnapshot,
	registerForegroundSubagent,
	startWidgetUpdates,
	uiContext,
	updateWidget,
} from "./widget.js";

// ── Module State ─────────────────────────────────────────────────────────────

/** Reference to pi extension API, for sendMessage from async completion handlers. */
let _piRef: ExtensionAPI | null = null;

/**
 * Set the pi extension API reference for async completion handlers.
 * @param pi - Extension API reference
 */
export function setPiRef(pi: ExtensionAPI | null): void {
	_piRef = pi;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Patterns in stderr/errorMessage that indicate a model-level failure (not a task failure). */
const MODEL_ERROR_PATTERNS = [
	"usage limit",
	"rate limit",
	"quota exceeded",
	"authentication",
	"unauthorized",
	"api key",
	"billing",
	"capacity",
	"overloaded",
	"503",
	"429",
];

/** Patterns in tool result content that indicate a permission denial rather than execution failure. */
const DENIAL_PATTERNS = [
	"permission denied",
	"tool denied",
	"user declined",
	"denied by user",
	"user rejected",
	"request denied",
];

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Checks if a subagent failure looks like a model/API error rather than a task error.
 *
 * Model errors (quota, auth, rate limits) are retryable with a different model.
 * Task errors (bad tool call, runtime crash) are not.
 *
 * @param result - The failed subagent result
 * @returns true if the error looks model-level and retryable
 */
function isModelLevelError(result: SingleResult): boolean {
	const text = `${result.stderr} ${result.errorMessage ?? ""}`.toLowerCase();
	return MODEL_ERROR_PATTERNS.some((p) => text.includes(p));
}

/**
 * Checks if a tool_result_end event message indicates a permission denial.
 *
 * Distinguishes user/framework permission denials from regular tool execution
 * failures. Checks for an explicit `isDenied` flag (forward-compatible with
 * future pi framework support) and falls back to pattern-matching the result
 * content text.
 *
 * @param eventMessage - The raw event message from the pi JSON protocol
 * @returns true if the result indicates a tool was denied permission
 */
function isToolDenialEvent(eventMessage: Record<string, unknown>): boolean {
	if (!eventMessage.isError) return false;

	// Explicit denial flag (forward-compatible with pi framework changes)
	if (eventMessage.isDenied === true) return true;

	// Pattern-match content array for denial indicators
	const content = eventMessage.content;
	if (Array.isArray(content)) {
		const text = content
			.filter((p: Record<string, unknown>) => p.type === "text")
			.map((p: Record<string, unknown>) => p.text as string)
			.join(" ")
			.toLowerCase();
		return DENIAL_PATTERNS.some((p) => text.includes(p));
	}

	return false;
}

/**
 * Write a subagent prompt to a temporary file for the pi subprocess.
 * @param agentName - Agent name (sanitized for filename)
 * @param prompt - System prompt content
 * @returns Object with temp directory and file path
 */
function writePromptToTempFile(
	agentName: string,
	prompt: string
): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

/**
 * Map items with a concurrency limit using a worker pool pattern.
 * @param items - Items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Async function to apply to each item
 * @returns Array of results in original order
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ── Types ────────────────────────────────────────────────────────────────────

/** Callback for streaming partial results during subagent execution. */
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

// ── Background Spawning ──────────────────────────────────────────────────────

/**
 * Spawn a background subagent process.
 * @param defaultCwd - Default working directory
 * @param agents - Available agent configurations
 * @param agentName - Name of the agent to spawn
 * @param task - Task to delegate
 * @param cwd - Optional working directory override
 * @param piEvents - Optional event emitter for subagent lifecycle events
 * @param session - Optional session file path for persistent teammates
 * @param modelOverride - Optional explicit model ID
 * @param parentModelId - Parent model ID for inheritance
 * @param defaults - Optional agent defaults
 * @param hints - Optional routing hints
 * @returns Background subagent ID, error string if model unresolvable, or null if agent not found
 */
export async function spawnBackgroundSubagent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	piEvents?: ExtensionAPI["events"],
	session?: string,
	modelOverride?: string,
	parentModelId?: string,
	defaults?: AgentDefaults,
	hints?: RoutingHints
): Promise<string | null> {
	const resolved = resolveAgentForExecution(agentName, agents, defaults);
	// Route model via fuzzy resolution + auto-routing
	const routing = await routeModel(
		task,
		modelOverride,
		resolved.agent.model,
		parentModelId,
		resolved.agent.description,
		hints
	);
	if (!routing.ok) return routing.error;
	const agent = { ...resolved.agent, model: routing.model.id };
	const agentSource = resolved.resolution === "ephemeral" ? ("ephemeral" as const) : agent.source;
	const effectiveCwd = cwd ?? defaultCwd;

	const args: string[] = session
		? ["--mode", "json", "-p", "--session", session]
		: ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--models", agent.model);
	const effectiveTools = computeEffectiveTools(agent.tools, agent.disallowedTools);
	if (effectiveTools && effectiveTools.length > 0) args.push("--tools", effectiveTools.join(","));
	if (agent.skills && agent.skills.length > 0) {
		for (const skill of agent.skills) args.push("--skill", skill);
	}

	let tmpPromptDir: string | undefined;
	let tmpPromptPath: string | undefined;

	// Inject maxTurns budget hint into system prompt
	let systemPrompt = agent.systemPrompt;
	if (agent.maxTurns) {
		const budget = `You have a maximum of ${agent.maxTurns} tool-use turns for this task. Plan your approach to complete within this budget. If you are running low, output your best result immediately.\n\n`;
		systemPrompt = budget + systemPrompt;
	}

	if (systemPrompt.trim()) {
		const tmp = writePromptToTempFile(agent.name, systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
	}

	const expandedTask = await expandFileReferences(task, effectiveCwd);
	args.push(`Task: ${expandedTask}`);

	const childEnv: Record<string, string> = { ...process.env, PI_IS_SUBAGENT: "1" } as Record<
		string,
		string
	>;
	if (agent.allowedAgentTypes) {
		childEnv.PI_ALLOWED_AGENT_TYPES = agent.allowedAgentTypes.join(",");
	}
	if (agent.mcpServers && agent.mcpServers.length > 0) {
		childEnv.PI_MCP_SERVERS = agent.mcpServers.join(",");
	}

	const proc = spawn("pi", args, {
		cwd: effectiveCwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: childEnv,
	});

	const id = `bg_${generateId()}`;

	// Emit subagent_start event
	piEvents?.emit("subagent_start", {
		agent_id: id,
		agent_type: agentName,
		task,
		cwd: effectiveCwd,
		background: true,
	} satisfies SubagentStartEvent);
	const result: SingleResult = {
		agent: agentName,
		agentSource,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
			denials: 0,
		},
		model: agent.model,
	};

	const bgSubagent: BackgroundSubagent = {
		id,
		agent: agentName,
		task,
		startTime: Date.now(),
		process: proc,
		result,
		status: "running",
		tmpPromptDir,
		tmpPromptPath,
	};

	backgroundSubagents.set(id, bgSubagent);
	publishSubagentSnapshot(piEvents);

	// Collect output
	let buffer = "";
	let bgTurnCount = 0;
	proc.stdout.on("data", (data) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);

				// Emit subagent_tool_call when tool starts
				if (event.type === "tool_call_start") {
					bgTurnCount++;
					// Hard enforcement: kill after maxTurns tool calls
					if (agent.maxTurns && bgTurnCount >= agent.maxTurns) {
						proc.kill("SIGTERM");
					}

					piEvents?.emit("subagent_tool_call", {
						agent_id: id,
						agent_type: agentName,
						tool_name: event.toolName,
						tool_call_id: event.toolCallId,
						tool_input: event.input ?? {},
					} satisfies SubagentToolCallEvent);
				}

				if (event.type === "message_end" && event.message) {
					result.messages.push(event.message);
					if (event.message.role === "assistant") {
						result.usage.turns = (result.usage.turns || 0) + 1;
						const usage = event.message.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
						}
					}
				}
				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message);
					// Detect permission denials vs regular errors
					const resultMsg = event.message;
					const denied = isToolDenialEvent(resultMsg as Record<string, unknown>);
					if (denied) {
						if (!result.deniedTools) result.deniedTools = [];
						result.deniedTools.push(resultMsg.toolName ?? "unknown");
						result.usage.denials++;
					}
					// Emit subagent_tool_result when tool completes
					piEvents?.emit("subagent_tool_result", {
						agent_id: id,
						agent_type: agentName,
						tool_name: resultMsg.toolName ?? "unknown",
						tool_call_id: resultMsg.toolCallId ?? "",
						is_error: resultMsg.isError ?? false,
						is_denied: denied,
					} satisfies SubagentToolResultEvent);
				}
			} catch {
				/* ignore parse errors */
			}
		}
	});

	proc.stderr.on("data", (data) => {
		result.stderr += data.toString();
	});

	proc.on("close", (code) => {
		if (buffer.trim()) {
			try {
				const event = JSON.parse(buffer);
				if (event.type === "message_end" && event.message) {
					result.messages.push(event.message);
				}
			} catch {
				/* ignore */
			}
		}
		result.exitCode = code ?? 0;
		bgSubagent.status = code === 0 ? "completed" : "failed";
		publishSubagentSnapshot(piEvents);

		// Emit subagent_stop event
		piEvents?.emit("subagent_stop", {
			agent_id: id,
			agent_type: agentName,
			task,
			exit_code: code ?? 0,
			result: getFinalOutput(result.messages),
			background: true,
		} satisfies SubagentStopEvent);

		// Cleanup temp files
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}

		updateWidget();

		// Post inline result for background subagent completion
		if (_piRef && isInlineResultsEnabled()) {
			const duration = formatDuration(Date.now() - bgSubagent.startTime);
			const finalOutput = getFinalOutput(result.messages);
			const preview = extractPreview(finalOutput, 3, 80);

			_piRef.sendMessage({
				customType: "subagent-complete",
				content: `Agent ${agentName} ${bgSubagent.status} (${duration})`,
				display: true,
				details: {
					agentId: id,
					agentName,
					task,
					exitCode: code ?? 0,
					duration,
					preview,
					status: bgSubagent.status as "completed" | "failed",
					timestamp: Date.now(),
				} satisfies SubagentCompleteDetails,
			});
		}
	});

	// Start widget updates immediately after spawning
	if (uiContext) {
		startWidgetUpdates();
		updateWidget(); // Force immediate update
	}

	return id;
}

// ── Foreground Execution ─────────────────────────────────────────────────────

/**
 * Run a single subagent as a pi subprocess and collect its output.
 * Retries with fallback models on API/quota errors.
 *
 * @param defaultCwd - Default working directory
 * @param agents - Available agent configurations
 * @param agentName - Name of the agent to run
 * @param task - Task to delegate
 * @param cwd - Optional working directory override
 * @param step - Optional step index (for centipede mode)
 * @param signal - Optional abort signal
 * @param onUpdate - Optional callback for streaming partial results
 * @param makeDetails - Factory for SubagentDetails
 * @param piEvents - Optional event emitter
 * @param session - Optional session file path
 * @param modelOverride - Optional explicit model ID
 * @param parentModelId - Parent model ID for inheritance
 * @param defaults - Optional agent defaults
 * @param hints - Optional routing hints
 * @returns Result from the subagent execution
 */
export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	piEvents?: ExtensionAPI["events"],
	session?: string,
	modelOverride?: string,
	parentModelId?: string,
	defaults?: AgentDefaults,
	hints?: RoutingHints
): Promise<SingleResult> {
	const resolved = resolveAgentForExecution(agentName, agents, defaults);
	// Route model via fuzzy resolution + auto-routing
	const routing = await routeModel(
		task,
		modelOverride,
		resolved.agent.model,
		parentModelId,
		resolved.agent.description,
		hints
	);
	if (!routing.ok) {
		// Return a failed SingleResult so the caller can surface the error
		return {
			agent: agentName,
			agentSource: resolved.resolution === "ephemeral" ? "ephemeral" : resolved.agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: routing.error,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
				denials: 0,
			},
			errorMessage: routing.error,
			step,
		};
	}
	const agent = { ...resolved.agent, model: routing.model.id };
	const agentSource = resolved.resolution === "ephemeral" ? ("ephemeral" as const) : agent.source;
	const taskId = `fg_${generateId()}`;
	const effectiveCwd = cwd ?? defaultCwd;

	registerForegroundSubagent(taskId, agentName, task, Date.now(), piEvents);

	// Emit subagent_start event
	piEvents?.emit("subagent_start", {
		agent_id: taskId,
		agent_type: agentName,
		task,
		cwd: effectiveCwd,
		background: false,
	} satisfies SubagentStartEvent);

	const args: string[] = session
		? ["--mode", "json", "-p", "--session", session]
		: ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--models", agent.model);
	const fgEffectiveTools = computeEffectiveTools(agent.tools, agent.disallowedTools);
	if (fgEffectiveTools && fgEffectiveTools.length > 0)
		args.push("--tools", fgEffectiveTools.join(","));
	if (agent.skills && agent.skills.length > 0) {
		for (const skill of agent.skills) args.push("--skill", skill);
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	/** Cleanup temp prompt files (safe to call multiple times). */
	const cleanupTempFiles = () => {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
			tmpPromptPath = null;
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
			tmpPromptDir = null;
		}
	};

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource,
		task,
		exitCode: -1, // -1 = still running, will be set to actual exit code when done
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
			denials: 0,
		},
		model: agent.model,
		step,
	};

	/** Timestamp of the last emitted update, used for throttling. */
	let lastEmitTime = 0;
	const EMIT_THROTTLE_MS = 500;

	/**
	 * Emit a partial-result update to the parent tool framework.
	 * Throttled to max ~2 updates/sec to avoid TUI flicker during rapid tool calls.
	 * @param force - Bypass throttle (e.g., for first update or significant state changes)
	 */
	const emitUpdate = (force?: boolean) => {
		if (!onUpdate) return;
		const now = Date.now();
		if (!force && now - lastEmitTime < EMIT_THROTTLE_MS) return;
		lastEmitTime = now;
		onUpdate({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	try {
		// Inject maxTurns budget hint into system prompt
		let fgSystemPrompt = agent.systemPrompt;
		if (agent.maxTurns) {
			const budget = `You have a maximum of ${agent.maxTurns} tool-use turns for this task. Plan your approach to complete within this budget. If you are running low, output your best result immediately.\n\n`;
			fgSystemPrompt = budget + fgSystemPrompt;
		}

		if (fgSystemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, fgSystemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const expandedTask = await expandFileReferences(task, effectiveCwd);
		args.push(`Task: ${expandedTask}`);
		let wasAborted = false;

		const fgChildEnv: Record<string, string> = {
			...process.env,
			PI_IS_SUBAGENT: "1",
		} as Record<string, string>;
		if (agent.allowedAgentTypes) {
			fgChildEnv.PI_ALLOWED_AGENT_TYPES = agent.allowedAgentTypes.join(",");
		}
		if (agent.mcpServers && agent.mcpServers.length > 0) {
			fgChildEnv.PI_MCP_SERVERS = agent.mcpServers.join(",");
		}

		let fgTurnCount = 0;
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: fgChildEnv,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				// biome-ignore lint/suspicious/noExplicitAny: pi subagent JSON protocol has dynamic shape
				let event: Record<string, any>;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Emit subagent_tool_call when tool starts
				if (event.type === "tool_call_start") {
					fgTurnCount++;
					// Hard enforcement: kill after maxTurns tool calls
					if (agent.maxTurns && fgTurnCount >= agent.maxTurns) {
						proc.kill("SIGTERM");
					}

					piEvents?.emit("subagent_tool_call", {
						agent_id: taskId,
						agent_type: agentName,
						tool_name: event.toolName,
						tool_call_id: event.toolCallId,
						tool_input: event.input ?? {},
					} satisfies SubagentToolCallEvent);
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					// Detect permission denials vs regular errors
					const resultMsg = event.message;
					const denied = isToolDenialEvent(resultMsg as unknown as Record<string, unknown>);
					if (denied) {
						if (!currentResult.deniedTools) currentResult.deniedTools = [];
						currentResult.deniedTools.push(resultMsg.toolName ?? "unknown");
						currentResult.usage.denials++;
					}
					// Emit subagent_tool_result when tool completes
					piEvents?.emit("subagent_tool_result", {
						agent_id: taskId,
						agent_type: agentName,
						tool_name: resultMsg.toolName ?? "unknown",
						tool_call_id: resultMsg.toolCallId ?? "",
						is_error: resultMsg.isError ?? false,
						is_denied: denied,
					} satisfies SubagentToolResultEvent);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");

		// Annotate result when maxTurns killed the process
		if (agent.maxTurns && fgTurnCount >= agent.maxTurns) {
			currentResult.stderr += `\n[Terminated: reached maxTurns limit of ${agent.maxTurns}]`;
		}

		// Emit subagent_stop event
		piEvents?.emit("subagent_stop", {
			agent_id: taskId,
			agent_type: agentName,
			task,
			exit_code: exitCode,
			result: getFinalOutput(currentResult.messages),
			background: false,
		} satisfies SubagentStopEvent);

		// Retry with fallback model on API/quota errors (not task-level failures)
		if (
			currentResult.exitCode !== 0 &&
			routing.ok &&
			routing.fallbacks.length > 0 &&
			isModelLevelError(currentResult)
		) {
			completeForegroundSubagent(taskId, piEvents);
			cleanupTempFiles();
			// Retry with the next fallback model directly (no re-routing)
			const nextModel = routing.fallbacks[0];
			return runSingleAgent(
				defaultCwd,
				agents,
				agentName,
				task,
				cwd,
				step,
				signal,
				onUpdate,
				makeDetails,
				piEvents,
				session,
				nextModel.id,
				parentModelId,
				defaults
				// Clear hints — the explicit model override will be used
			);
		}

		return currentResult;
	} finally {
		completeForegroundSubagent(taskId, piEvents);
		cleanupTempFiles();
	}
}
