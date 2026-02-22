/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Centipede: { centipede: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon, getSpinner } from "../_icons/index.js";
import { INTEROP_EVENT_NAMES, onInteropEvent } from "../_shared/interop-events.js";
import {
	appendSection,
	dimProcessOutputLine,
	formatIdentityText,
	formatPresentationText,
	formatSectionDivider,
} from "../tool-display/index.js";
import type { RoutingHints } from "./model-router.js";

// ── Re-exported modules ──────────────────────────────────────────────────────

import {
	type AgentScope,
	COLLAPSED_ITEM_COUNT,
	coerceArray,
	discoverAgents,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
} from "./agents.js";
import {
	aggregateUsage,
	formatToolCall,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	type SingleResult,
	type SubagentDetails,
} from "./formatting.js";
import {
	applyBackgroundResultRetention,
	mapWithConcurrencyLimit,
	type OnUpdateCallback,
	runSingleAgent,
	setPiRef,
	spawnBackgroundSubagent,
} from "./process.js";
import type { SubagentCompleteDetails } from "./schema.js";
import { SubagentParams } from "./schema.js";
import {
	backgroundSubagents,
	cleanupCompletedBackgroundSubagents,
	clearAllSubagents,
	clearForegroundSubagents,
	formatDuration,
	getBackgroundSubagentOutput,
	interopStateRequestCleanup,
	publishSubagentSnapshot,
	runningSubagents,
	SPINNER_FRAMES,
	setInteropStateRequestCleanup,
	setUiContext,
} from "./widget.js";

// ── Public re-exports (consumed by other extensions) ─────────────────────────

export { resolveProjectRoot } from "./agents.js";
export type {
	SubagentStartEvent,
	SubagentStopEvent,
	SubagentToolCallEvent,
	SubagentToolResultEvent,
} from "./schema.js";

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Skip in subagent workers - they don't need to spawn subagents
	if (process.env.PI_IS_SUBAGENT === "1") {
		return;
	}

	setPiRef(pi);

	// Register inline result renderer for background subagent completions
	pi.registerMessageRenderer<SubagentCompleteDetails>(
		"subagent-complete",
		(message, _options, theme) => {
			const d = message.details;
			if (!d) return undefined;

			const icon =
				d.status === "completed"
					? theme.fg("success", getIcon("success"))
					: theme.fg("error", getIcon("error"));
			const label = d.status === "completed" ? "completed" : "failed";

			let text = `${icon} ${theme.fg("muted", "🤖 Agent")} ${theme.fg("accent", d.agentName)} ${theme.fg("muted", label)} ${theme.fg("dim", `(${d.duration})`)}`;

			if (d.preview.length > 0) {
				for (const line of d.preview) {
					text += `\n  ${theme.fg("dim", line)}`;
				}
			} else {
				text += `\n  ${theme.fg("dim", "(no output)")}`;
			}

			text += `\n  ${theme.fg("muted", "Expand tool result to view full conversation")}`;

			return new Text(text, 0, 0);
		}
	);

	// Clear any stale widget state on load/reload
	runningSubagents.clear();
	const G = globalThis;
	if (G.__piSubagentWidgetInterval) {
		clearInterval(G.__piSubagentWidgetInterval);
		G.__piSubagentWidgetInterval = null;
	}

	interopStateRequestCleanup?.();
	setInteropStateRequestCleanup(
		onInteropEvent(pi.events, INTEROP_EVENT_NAMES.stateRequest, () => {
			publishSubagentSnapshot(pi.events);
		})
	);

	// Also clear on session start
	pi.on("session_start", async (_event, ctx) => {
		setUiContext(ctx);
		clearAllSubagents(pi.events);
		publishSubagentSnapshot(pi.events);
	});

	// Kill all running background subagents on interrupt (agent_end).
	// Background agents are delegated cognitive work — if the user hits Esc,
	// they want all agent work to stop. Background bash tasks (dev servers,
	// builds) are infrastructure and intentionally survive interrupts.
	pi.on("agent_end", async () => {
		let mutated = false;
		for (const [_id, bg] of backgroundSubagents) {
			if (bg.status === "running" && bg.process && !bg.process.killed) {
				bg.process.kill("SIGTERM");
				bg.completedAt = Date.now();
				bg.status = "failed";
				bg.result.exitCode = 1;
				bg.result.stopReason = "interrupted";
				applyBackgroundResultRetention(bg);
				mutated = true;
				setTimeout(() => {
					if (!bg.process.killed) bg.process.kill("SIGKILL");
				}, 3000);
			}
		}
		if (mutated) {
			publishSubagentSnapshot(pi.events);
			cleanupCompletedBackgroundSubagents(pi.events);
		}
	});

	pi.registerTool({
		name: "subagent",
		label: "subagent",
		description: `Delegate tasks to specialized subagents with isolated context. Modes: single (agent + task), parallel (tasks array), centipede (sequential with {previous} placeholder). Default agent scope is "user" (from ~/.tallow/agents). To include project-local agents, set agentScope: "both". Missing agent names recover gracefully via best-match or ephemeral fallback.

MODEL SELECTION:
- model: explicit model name (fuzzy matched, e.g. "opus", "haiku", "gemini flash")
- No model specified: auto-routes based on task type and complexity
- costPreference: "eco" (cheapest capable), "balanced" (default), "premium" (best available)
- taskType: override auto-detected type ("code", "vision", "text")
- complexity: override auto-detected complexity (1=trivial to 5=expert)
- modelScope: constrain auto-routing to a model family (e.g. "codex", "gemini"). Classifies the task and picks the right model within that family based on complexity and cost.
- If the selected model fails (quota/auth), automatically retries with the next best candidate

WHEN TO USE PARALLEL:
- Tasks are independent (don't depend on each other)
- Can run concurrently without file conflicts
- Each task is self-contained

WHEN TO USE BACKGROUND (background: true):
- Long-running tasks user doesn't need to wait for
- Want to continue conversation while tasks run
- Multiple async tasks to monitor later

WHEN TO USE CENTIPEDE:
- Sequential steps where each depends on previous
- Use {previous} placeholder for prior output

WHEN NOT TO USE SUBAGENTS:
- Simple tasks you can do directly
- Tasks modifying same files (use sequential)
- Need real-time back-and-forth interaction`,
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			setUiContext(ctx);

			// Resolve parent model once for inheritance
			const parentModelId = ctx.model?.id;

			// Build per-call routing hints from params
			const routingHints: RoutingHints | undefined =
				params.costPreference || params.taskType || params.complexity || params.modelScope
					? {
							costPreference: params.costPreference as RoutingHints["costPreference"],
							taskType: params.taskType as RoutingHints["taskType"],
							complexity: params.complexity,
							modelScope: params.modelScope,
						}
					: undefined;

			// Enforce agent type restrictions from parent agent
			const allowedTypes = process.env.PI_ALLOWED_AGENT_TYPES?.split(",").filter(Boolean);
			if (allowedTypes && allowedTypes.length > 0) {
				const requestedAgents: string[] = [];
				if (params.agent) requestedAgents.push(params.agent);
				for (const t of coerceArray(params.tasks) ?? []) {
					if (t?.agent) requestedAgents.push(t.agent);
				}
				for (const c of coerceArray(params.centipede) ?? []) {
					if (c?.agent) requestedAgents.push(c.agent);
				}
				const blocked = requestedAgents.filter((a) => !allowedTypes.includes(a));
				if (blocked.length > 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Agent type restriction: cannot spawn ${blocked.join(", ")}. Allowed: ${allowedTypes.join(", ")}`,
							},
						],
						details: { mode: "single" as const, agentScope: "user", results: [] },
						isError: true,
					};
				}
			}

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const defaults = discovery.defaults;

			// Coerce tasks/centipede: LLMs sometimes pass arrays as JSON strings,
			// which causes .length to return character count instead of element count.
			const tasks = coerceArray(params.tasks);
			const centipede = coerceArray(params.centipede);

			const hasCentipede = (centipede?.length ?? 0) > 0;
			const hasTasks = (tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasCentipede) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(
					mode: "single" | "parallel" | "centipede",
					centipedeSteps?: { agent: string; task: string }[]
				) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					centipedeSteps,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (centipede && centipede.length > 0) {
				return executeCentipede(
					centipede,
					ctx,
					agents,
					defaults,
					makeDetails,
					onUpdate,
					signal,
					pi,
					parentModelId,
					routingHints
				);
			}

			if (tasks && tasks.length > 0) {
				return executeParallel(
					tasks,
					params,
					ctx,
					agents,
					defaults,
					makeDetails,
					onUpdate,
					signal,
					pi,
					parentModelId,
					routingHints
				);
			}

			if (params.agent && params.task) {
				return executeSingle(
					{ ...params, agent: params.agent, task: params.task },
					ctx,
					agents,
					defaults,
					makeDetails,
					onUpdate,
					signal,
					pi,
					parentModelId,
					routingHints
				);
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, { expanded }, theme) {
			return renderSubagentResult(result, expanded, theme);
		},
	});

	// Tool to check status of background subagents
	pi.registerTool({
		name: "subagent_status",
		label: "subagent_status",
		description:
			"Check status of background subagents. Optionally provide a taskId to get details for a specific task.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Specific task ID to check (optional)" })),
		}),
		async execute(_toolCallId, params) {
			cleanupCompletedBackgroundSubagents(pi.events);

			if (params.taskId) {
				const bg = backgroundSubagents.get(params.taskId);
				if (!bg) {
					return {
						details: {},
						content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					};
				}
				const duration = formatDuration(Date.now() - bg.startTime);
				const output = getBackgroundSubagentOutput(bg) || "(no output yet)";
				const historyLine =
					bg.historyCompacted &&
					bg.historyOriginalMessageCount !== undefined &&
					bg.historyRetainedMessageCount !== undefined
						? `\n**History:** compacted (${bg.historyRetainedMessageCount}/${bg.historyOriginalMessageCount} messages retained)`
						: "";
				return {
					details: {},
					content: [
						{
							type: "text",
							text: `**Task:** ${bg.id}\n**Agent:** ${bg.agent}\n**Status:** ${bg.status}\n**Duration:** ${duration}\n**Task:** ${bg.task}${historyLine}\n\n**Output:**\n${output}`,
						},
					],
				};
			}

			// List all background subagents
			const all = [...backgroundSubagents.values()];
			if (all.length === 0) {
				return {
					details: {},
					content: [{ type: "text", text: "No background subagents running." }],
				};
			}

			const lines = all.map((bg) => {
				const duration = formatDuration(Date.now() - bg.startTime);
				const statusIcon =
					bg.status === "running"
						? getIcon("in_progress")
						: bg.status === "completed"
							? getIcon("success")
							: getIcon("error");
				const preview = bg.task.length > 40 ? `${bg.task.slice(0, 37)}...` : bg.task;
				const compactedBadge = bg.historyCompacted ? " · compacted" : "";
				return `${statusIcon} **${bg.id}** (${bg.agent}) - ${bg.status}${compactedBadge} (${duration})\n   ${preview}`;
			});

			return {
				details: {},
				content: [
					{
						type: "text",
						text: `**Background Subagents (${all.length}):**\n\n${lines.join("\n\n")}`,
					},
				],
			};
		},
	});
}

// ── Execution Modes ──────────────────────────────────────────────────────────

/**
 * Execute centipede (sequential) mode.
 */
async function executeCentipede(
	centipede: { agent: string; task: string; cwd?: string; model?: string }[],
	ctx: ExtensionContext,
	agents: { name: string; source: string }[],
	defaults: Parameters<typeof runSingleAgent>[13],
	makeDetails: (
		mode: "single" | "parallel" | "centipede",
		steps?: { agent: string; task: string }[]
	) => (results: SingleResult[]) => SubagentDetails,
	onUpdate: OnUpdateCallback | undefined,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
	parentModelId: string | undefined,
	routingHints: RoutingHints | undefined
) {
	const results: SingleResult[] = [];
	let previousOutput = "";
	const centipedeSteps = centipede.map((s) => ({ agent: s.agent, task: s.task }));
	const mkCentipedeDetails = makeDetails("centipede", centipedeSteps);

	// Spinner animation for centipede progress
	let centipedeSpinnerFrame = 0;
	let latestPartialResult: SingleResult | undefined;
	let spinnerInterval: NodeJS.Timeout | null = null;

	const emitCentipedeUpdate = () => {
		if (onUpdate) {
			const allResults = latestPartialResult ? [...results, latestPartialResult] : [...results];
			const details = mkCentipedeDetails(allResults);
			details.spinnerFrame = centipedeSpinnerFrame;
			onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(latestPartialResult?.messages ?? []) || "(running...)",
					},
				],
				details,
			});
		}
	};

	if (onUpdate) {
		spinnerInterval = setInterval(() => {
			centipedeSpinnerFrame = (centipedeSpinnerFrame + 1) % SPINNER_FRAMES.length;
			emitCentipedeUpdate();
		}, 100);
	}

	try {
		for (let i = 0; i < centipede.length; i++) {
			const step = centipede[i];
			ctx.ui.setWorkingMessage(
				`Running centipede step ${i + 1}/${centipede.length}: ${step.agent}`
			);
			const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
			latestPartialResult = undefined;

			// Create update callback that includes all previous results
			const centipedeUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							latestPartialResult = currentResult;
							emitCentipedeUpdate();
						}
					}
				: undefined;

			const result = await runSingleAgent(
				ctx.cwd,
				agents as Parameters<typeof runSingleAgent>[1],
				step.agent,
				taskWithContext,
				step.cwd,
				i + 1,
				signal,
				centipedeUpdate,
				mkCentipedeDetails,
				pi.events,
				undefined,
				step.model,
				parentModelId,
				defaults,
				routingHints
			);
			results.push(result);
			latestPartialResult = undefined;

			const isError =
				result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				if (spinnerInterval) clearInterval(spinnerInterval);
				ctx.ui.setWorkingMessage();
				const errorMsg =
					result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					content: [
						{
							type: "text" as const,
							text: `Centipede stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
						},
					],
					details: mkCentipedeDetails(results),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}
		if (spinnerInterval) clearInterval(spinnerInterval);
		ctx.ui.setWorkingMessage();
		return {
			content: [
				{
					type: "text" as const,
					text: getFinalOutput(results.at(-1)?.messages ?? []) || "(no output)",
				},
			],
			details: mkCentipedeDetails(results),
		};
	} finally {
		if (spinnerInterval) clearInterval(spinnerInterval);
	}
}

/** Parallel-task payload for subagent parallel mode. */
type ParallelTask = {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
};

/**
 * Execute parallel mode.
 */
async function executeParallel(
	tasks: ParallelTask[],
	params: { background?: boolean },
	ctx: ExtensionContext,
	agents: Parameters<typeof runSingleAgent>[1],
	defaults: Parameters<typeof runSingleAgent>[13],
	makeDetails: (
		mode: "single" | "parallel" | "centipede"
	) => (results: SingleResult[]) => SubagentDetails,
	onUpdate: OnUpdateCallback | undefined,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
	parentModelId: string | undefined,
	routingHints: RoutingHints | undefined
) {
	// Background mode: spawn without awaiting, return immediately
	if (params.background) {
		const taskIds: string[] = [];
		const errors: string[] = [];
		for (const t of tasks) {
			const result = await spawnBackgroundSubagent(
				ctx.cwd,
				agents,
				t.agent,
				t.task,
				t.cwd,
				pi.events,
				undefined,
				(t as { model?: string }).model,
				parentModelId,
				defaults,
				routingHints
			);
			if (result?.startsWith("bg_")) taskIds.push(result);
			else if (result) errors.push(result);
		}
		const parts = [];
		if (taskIds.length > 0) {
			parts.push(
				`Started ${taskIds.length} background subagent(s):\n${taskIds.map((id) => `- ${id}`).join("\n")}\n\nUse subagent_status to check progress.`
			);
		}
		if (errors.length > 0) parts.push(`Errors:\n${errors.join("\n")}`);
		return {
			content: [{ type: "text" as const, text: parts.join("\n\n") || "No subagents started." }],
			details: makeDetails("parallel")([]),
			isError: errors.length > 0 && taskIds.length === 0,
		};
	}

	const taskBatches: { start: number; tasks: typeof tasks }[] = [];
	for (let start = 0; start < tasks.length; start += MAX_PARALLEL_TASKS) {
		taskBatches.push({
			start,
			tasks: tasks.slice(start, start + MAX_PARALLEL_TASKS),
		});
	}

	// Clear any stale foreground subagent entries from previous runs
	clearForegroundSubagents(pi.events);

	// Track all results for streaming updates
	const allResults: SingleResult[] = new Array(tasks.length);

	// Initialize placeholder results
	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = {
			agent: tasks[i].agent,
			agentSource: "unknown",
			task: tasks[i].task,
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
		};
	}

	let spinnerFrame = 0;
	let spinnerInterval: NodeJS.Timeout | null = null;

	const emitParallelUpdate = () => {
		if (onUpdate) {
			const counts = countParallelResultStates(allResults);
			const details = makeDetails("parallel")([...allResults]);
			details.spinnerFrame = spinnerFrame;
			onUpdate({
				content: [
					{
						type: "text",
						text:
							`Parallel: ${counts.finished}/${counts.total} done, ` +
							`${counts.running} running, ${counts.stalled} stalled...`,
					},
				],
				details,
			});
		}
	};

	// Start spinner animation
	spinnerInterval = setInterval(() => {
		spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
		emitParallelUpdate();
	}, 100);

	if (taskBatches.length > 1) {
		ctx.ui.setWorkingMessage(
			`Running ${tasks.length} agents in ${taskBatches.length} batches ` +
				`(max ${MAX_PARALLEL_TASKS} per call)`
		);
	} else {
		ctx.ui.setWorkingMessage(`Waiting for ${tasks.length} parallel agents to finish`);
	}

	let results: SingleResult[];
	try {
		for (let batchIndex = 0; batchIndex < taskBatches.length; batchIndex++) {
			const batch = taskBatches[batchIndex];
			if (taskBatches.length > 1) {
				ctx.ui.setWorkingMessage(
					`Running parallel batch ${batchIndex + 1}/${taskBatches.length} ` +
						`(${batch.tasks.length} agents)`
				);
			}
			await mapWithConcurrencyLimit(batch.tasks, MAX_CONCURRENCY, async (t, index) => {
				const globalIndex = batch.start + index;
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					t.agent,
					t.task,
					t.cwd,
					undefined,
					signal,
					(partial) => {
						if (partial.details?.results[0]) {
							allResults[globalIndex] = partial.details.results[0];
							emitParallelUpdate();
						}
					},
					makeDetails("parallel"),
					pi.events,
					undefined,
					(t as { model?: string }).model,
					parentModelId,
					defaults,
					routingHints
				);
				allResults[globalIndex] = result;
				return result;
			});
		}
		results = [...allResults];
	} finally {
		if (spinnerInterval) {
			clearInterval(spinnerInterval);
			spinnerInterval = null;
		}
		ctx.ui.setWorkingMessage();
	}

	let counts = countParallelResultStates(results);
	let stalledRetrySummary: string | undefined;

	const initialStalledIndexes = collectParallelStateIndices(results, "stalled");
	if (initialStalledIndexes.length > 0) {
		const retrySummaryLines: string[] = [];
		const totalRetries = initialStalledIndexes.length;

		try {
			ctx.ui.setWorkingMessage(
				`Rerunning ${totalRetries} stalled worker${totalRetries === 1 ? "" : "s"} individually`
			);

			for (let retryIndex = 0; retryIndex < initialStalledIndexes.length; retryIndex++) {
				const stalledIndex = initialStalledIndexes[retryIndex];
				const stalledTask = tasks[stalledIndex];
				const priorResult = allResults[stalledIndex];
				const retryTask = buildStalledRetryTask(stalledTask.task);
				const explicitRetryModel = stalledTask.model ?? priorResult.model ?? parentModelId;
				const retryRoutingHints = explicitRetryModel ? undefined : routingHints;
				const retryLabel = explicitRetryModel
					? `model:${explicitRetryModel}`
					: retryRoutingHints?.modelScope
						? `modelScope:${retryRoutingHints.modelScope}`
						: "auto-routing";

				ctx.ui.setWorkingMessage(
					`Retrying stalled worker ${retryIndex + 1}/${totalRetries}: ${stalledTask.agent}`
				);

				const retryResult = await runSingleAgent(
					ctx.cwd,
					agents,
					stalledTask.agent,
					retryTask,
					stalledTask.cwd,
					undefined,
					signal,
					(partial) => {
						if (partial.details?.results[0]) {
							const partialResult = {
								...partial.details.results[0],
								task: stalledTask.task,
							};
							allResults[stalledIndex] = partialResult;
							emitParallelUpdate();
						}
					},
					makeDetails("parallel"),
					pi.events,
					undefined,
					explicitRetryModel,
					parentModelId,
					defaults,
					retryRoutingHints
				);

				retryResult.task = stalledTask.task;
				retryResult.stderr = appendStderrNote(
					retryResult.stderr,
					`[Auto-rerun] retried stalled worker individually (${retryLabel})`
				);
				allResults[stalledIndex] = retryResult;
				retrySummaryLines.push(`- [${stalledTask.agent}] ${retryLabel}`);
				emitParallelUpdate();
			}
		} finally {
			ctx.ui.setWorkingMessage();
		}

		results = [...allResults];
		counts = countParallelResultStates(results);
		const remainingStalledIndexes = collectParallelStateIndices(results, "stalled");
		const recoveredCount = totalRetries - remainingStalledIndexes.length;
		const remainingAgents = remainingStalledIndexes.map((index) => results[index].agent).join(", ");
		const lines = [
			`Auto-rerun: retried ${totalRetries} stalled worker${totalRetries === 1 ? "" : "s"} individually with narrowed scope.`,
			`Recovered ${recoveredCount}/${totalRetries}.`,
		];
		if (remainingStalledIndexes.length > 0) {
			lines.push(`Still stalled: ${remainingAgents}.`);
		}
		stalledRetrySummary = lines.join(" ");
		if (retrySummaryLines.length > 0) {
			stalledRetrySummary += `\n${retrySummaryLines.join("\n")}`;
		}
	}

	const summaries = results.map((result) => {
		const output = getFinalOutput(result.messages);
		const fallback = result.errorMessage || result.stderr || "(no output)";
		const preview = output
			? output.slice(0, 100) + (output.length > 100 ? "..." : "")
			: fallback.slice(0, 100) + (fallback.length > 100 ? "..." : "");
		const state = getParallelResultState(result);
		const stateLabel = state === "completed" ? "completed" : state;
		return `[${result.agent}] ${stateLabel}: ${preview}`;
	});

	let isError = false;
	let stalledRemediation: string | undefined;

	if (counts.stalled > 0) {
		const stalledAgents = results
			.filter((result) => getParallelResultState(result) === "stalled")
			.map((result) => result.agent);
		const stalledAgentList = stalledAgents.join(", ");
		const remediation =
			`Stalled workers: ${stalledAgentList}. ` +
			"Automatic rerun already attempted once per stalled worker. " +
			"Split task scope further, avoid confirmation-gated steps, " +
			"or pin a different explicit model/modelScope.";
		isError = true;
		stalledRemediation = ctx.hasUI
			? "Parallel run finished with unrecovered stalled workers after automatic reruns.\n" +
				`${remediation}`
			: "Non-interactive mode: returning partial results with error because " +
				"workers remained stalled after automatic reruns.\n" +
				`${remediation}`;
	}

	const batchNote =
		taskBatches.length > 1
			? `\nAuto-batched into ${taskBatches.length} calls ` +
				`(${taskBatches.map((batch) => batch.tasks.length).join(" + ")}) ` +
				`to respect max ${MAX_PARALLEL_TASKS} tasks per call.`
			: "";
	const header =
		`Parallel: ${counts.finished}/${counts.total} done ` +
		`(${counts.completed} completed, ${counts.failed} failed, ${counts.stalled} stalled)`;
	const summaryText =
		`${header}${batchNote}\n\n${summaries.join("\n\n")}` +
		(stalledRetrySummary ? `\n\n${stalledRetrySummary}` : "") +
		(stalledRemediation ? `\n\n${stalledRemediation}` : "");

	return {
		content: [{ type: "text" as const, text: summaryText }],
		details: makeDetails("parallel")(results),
		isError,
	};
}

/**
 * Execute single agent mode.
 */
async function executeSingle(
	params: {
		agent: string;
		task: string;
		cwd?: string;
		session?: string;
		model?: string;
		background?: boolean;
	},
	ctx: ExtensionContext,
	agents: Parameters<typeof runSingleAgent>[1],
	defaults: Parameters<typeof runSingleAgent>[13],
	makeDetails: (
		mode: "single" | "parallel" | "centipede"
	) => (results: SingleResult[]) => SubagentDetails,
	onUpdate: OnUpdateCallback | undefined,
	signal: AbortSignal | undefined,
	pi: ExtensionAPI,
	parentModelId: string | undefined,
	routingHints: RoutingHints | undefined
) {
	const agentName = params.agent;
	const task = params.task;

	// Background mode for single agent: spawn without awaiting
	if (params.background) {
		const result = await spawnBackgroundSubagent(
			ctx.cwd,
			agents,
			agentName,
			task,
			params.cwd,
			pi.events,
			params.session,
			params.model,
			parentModelId,
			defaults,
			routingHints
		);
		if (result?.startsWith("bg_")) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Started background subagent: ${result}\n\nUse subagent_status to check progress.`,
					},
				],
				details: makeDetails("single")([]),
			};
		}
		return {
			content: [{ type: "text" as const, text: result || "Failed to start background subagent" }],
			details: makeDetails("single")([]),
			isError: true,
		};
	}

	ctx.ui.setWorkingMessage(`Running agent: ${agentName}`);

	// Spinner animation for single agent
	let singleSpinnerFrame = 0;
	let singleSpinnerInterval: NodeJS.Timeout | null = null;
	let lastUpdate: Parameters<OnUpdateCallback>[0] | null = null;

	const emitSingleUpdate = () => {
		if (onUpdate && lastUpdate) {
			if (lastUpdate.details) {
				(lastUpdate.details as unknown as Record<string, unknown>).spinnerFrame =
					singleSpinnerFrame;
			}
			onUpdate(lastUpdate);
		}
	};

	if (onUpdate) {
		singleSpinnerInterval = setInterval(() => {
			singleSpinnerFrame = (singleSpinnerFrame + 1) % SPINNER_FRAMES.length;
			emitSingleUpdate();
		}, 100);
	}

	const result = await runSingleAgent(
		ctx.cwd,
		agents,
		agentName,
		task,
		params.cwd,
		undefined,
		signal,
		(update) => {
			lastUpdate = update;
			emitSingleUpdate();
		},
		makeDetails("single"),
		pi.events,
		params.session,
		params.model,
		parentModelId,
		defaults,
		routingHints
	);

	if (singleSpinnerInterval) {
		clearInterval(singleSpinnerInterval);
	}
	ctx.ui.setWorkingMessage();
	const isError =
		result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	if (isError) {
		const errorMsg =
			result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
		return {
			content: [
				{ type: "text" as const, text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` },
			],
			details: makeDetails("single")([result]),
			isError: true,
		};
	}
	return {
		content: [{ type: "text" as const, text: getFinalOutput(result.messages) || "(no output)" }],
		details: makeDetails("single")([result]),
	};
}

// ── Render Functions ─────────────────────────────────────────────────────────

interface DisplayRenderOptions {
	itemLimit?: number;
	maxLineLength?: number;
	textLineLimit?: number;
}

/**
 * Shared preview budgets for compact subagent presentation lines.
 */
const SUBAGENT_PREVIEW_LIMITS = {
	callCentipedeStep: 90,
	callParallelTask: 90,
	collapsedParallelResult: 88,
} as const;

/**
 * Build a compact single-line preview from raw text.
 *
 * @param text - Raw preview text (possibly multiline)
 * @param maxLength - Maximum visible characters
 * @returns Compact preview with ellipsis when truncated
 */
function toCompactPreview(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	if (maxLength <= 1) return "…";
	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Format muted metadata values as a bullet-separated line.
 *
 * @param theme - Active theme
 * @param entries - Metadata entries to render
 * @returns Formatted metadata line, or undefined when empty
 */
function formatMetaLine(
	theme: Theme,
	entries: readonly (string | undefined)[]
): string | undefined {
	const present = entries.filter((entry): entry is string => Boolean(entry?.trim()));
	if (present.length === 0) return undefined;
	return formatPresentationText(theme, "meta", present.join(" • "));
}

/**
 * Apply deterministic identity styling for subagent names.
 *
 * @param identity - Agent identity label
 * @returns ANSI-styled identity token
 */
function formatSubagentIdentity(identity: string): string {
	return formatIdentityText(identity, identity, true);
}

/**
 * Build a compact model label for agent rows.
 *
 * @param theme - Active theme
 * @param model - Optional model identifier
 * @returns Styled model label, or undefined
 */
function formatModelTag(theme: Theme, model: string | undefined): string | undefined {
	if (!model) return undefined;
	const modelId = model.split("/").at(-1) ?? model;
	const shortModel = modelId.length > 24 ? `${modelId.slice(0, 21)}...` : modelId;
	return formatPresentationText(theme, "hint", `(${shortModel})`);
}

/**
 * Build the shared subagent header line with semantic roles.
 *
 * @param theme - Active theme
 * @param action - Mode/status action label
 * @param identity - Optional identity label (agent name)
 * @param icon - Optional status icon prefix
 * @returns Formatted header line
 */
function formatSubagentHeader(
	theme: Theme,
	action: string,
	identity?: string,
	icon?: string
): string {
	const parts: string[] = [];
	if (icon) parts.push(icon);
	parts.push(formatPresentationText(theme, "title", "subagent"));
	parts.push(formatPresentationText(theme, "action", action));
	if (identity) parts.push(formatSubagentIdentity(identity));
	return parts.join(" ");
}

/**
 * Build a subdued color adapter for `formatToolCall` output.
 *
 * @param theme - Active theme
 * @returns Theme color formatter biased toward muted/process styles
 */
function createToolCallThemeFg(theme: Theme): (color: ThemeColor, text: string) => string {
	return (color, text) => {
		switch (color) {
			case "dim":
			case "muted":
				return formatPresentationText(theme, "meta", text);
			case "error":
				return formatPresentationText(theme, "status_error", text);
			case "warning":
				return formatPresentationText(theme, "status_warning", text);
			default:
				return formatPresentationText(theme, "process_output", text);
		}
	};
}

/**
 * Return whether a subagent result ended in a stalled state.
 *
 * @param result - Single subagent result
 * @returns True when the worker stalled before completing
 */
function isResultStalled(result: SingleResult): boolean {
	if (result.exitCode === -1) return false;
	if (result.stopReason?.toLowerCase() === "stalled") return true;
	if (result.exitCode === 0) return false;
	const failureText = `${result.errorMessage ?? ""} ${result.stderr}`.toLowerCase();
	return /\bstall(?:ed|ing)?\b/.test(failureText);
}

/** Status classification for parallel subagent rows. */
type ParallelResultState = "running" | "completed" | "failed" | "stalled";

/** Aggregated state counters for parallel execution. */
interface ParallelResultCounts {
	total: number;
	finished: number;
	running: number;
	completed: number;
	failed: number;
	stalled: number;
}

/**
 * Return whether a subagent result should be rendered as an error.
 *
 * @param result - Single subagent result
 * @returns True when the result ended in an error state
 */
function isResultError(result: SingleResult): boolean {
	if (result.exitCode === -1) return false;
	if (isResultStalled(result)) return true;
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/**
 * Classify a parallel result into a stable status label.
 *
 * @param result - Single subagent result
 * @returns Parallel status bucket
 */
function getParallelResultState(result: SingleResult): ParallelResultState {
	if (result.exitCode === -1) return "running";
	if (isResultStalled(result)) return "stalled";
	return isResultError(result) ? "failed" : "completed";
}

/**
 * Count status buckets for a parallel run.
 *
 * @param results - Parallel subagent results
 * @returns Count breakdown used by stream/final summaries
 */
function countParallelResultStates(results: SingleResult[]): ParallelResultCounts {
	const counts: ParallelResultCounts = {
		total: results.length,
		finished: 0,
		running: 0,
		completed: 0,
		failed: 0,
		stalled: 0,
	};

	for (const result of results) {
		const state = getParallelResultState(result);
		switch (state) {
			case "running":
				counts.running++;
				break;
			case "completed":
				counts.completed++;
				break;
			case "failed":
				counts.failed++;
				break;
			case "stalled":
				counts.stalled++;
				break;
		}
	}

	counts.finished = counts.completed + counts.failed + counts.stalled;
	return counts;
}

/**
 * Retry directive appended to stalled-worker reruns.
 *
 * Instructs the worker to aggressively narrow scope so retried tasks
 * are less likely to deadlock on long/interactive paths.
 */
const STALLED_RETRY_SCOPE_GUIDANCE =
	"[Automatic retry after stall]\n" +
	"Your previous parallel attempt stalled. Execute a narrower slice now: " +
	"complete only the smallest high-confidence chunk you can finish quickly.\n" +
	"If the original task is already small, complete it fully. " +
	"If it is broad, finish one concrete slice and list remaining follow-ups.";

/**
 * Build the retry task text for a stalled parallel worker.
 *
 * @param task - Original worker task
 * @returns Task text with explicit scope-narrowing retry guidance
 */
function buildStalledRetryTask(task: string): string {
	const baseTask = task.trim();
	if (baseTask.length === 0) return STALLED_RETRY_SCOPE_GUIDANCE;
	return `${baseTask}\n\n${STALLED_RETRY_SCOPE_GUIDANCE}`;
}

/**
 * Collect indexes of results that match a target parallel state.
 *
 * @param results - Parallel result list
 * @param state - Target state to match
 * @returns Zero-based indexes for matching rows
 */
function collectParallelStateIndices(
	results: SingleResult[],
	state: ParallelResultState
): number[] {
	const indexes: number[] = [];
	for (let index = 0; index < results.length; index++) {
		if (getParallelResultState(results[index]) === state) {
			indexes.push(index);
		}
	}
	return indexes;
}

/**
 * Append a note to stderr while preserving existing diagnostics.
 *
 * @param stderr - Existing stderr text
 * @param note - Diagnostic note to append
 * @returns Combined stderr string
 */
function appendStderrNote(stderr: string, note: string): string {
	if (!stderr.trim()) return note;
	return `${stderr}\n${note}`;
}

/**
 * Render the tool call header for the subagent tool.
 *
 * @param args - Tool call arguments
 * @param theme - Active theme
 * @returns Renderable text component
 */
function renderSubagentCall(args: Record<string, unknown>, theme: Theme) {
	const scope: AgentScope = (args.agentScope as AgentScope) ?? "user";
	const model = typeof args.model === "string" ? args.model : undefined;
	const centipedeArr = coerceArray(
		args.centipede as { agent: string; model?: string; task: string }[] | string | undefined
	);
	const tasksArr = coerceArray(
		args.tasks as { agent: string; model?: string; task: string }[] | string | undefined
	);
	const lines: string[] = [];

	if (centipedeArr && centipedeArr.length > 0) {
		appendSection(lines, [formatSubagentHeader(theme, `centipede (${centipedeArr.length} steps)`)]);
		const metaLine = formatMetaLine(theme, [
			`scope:${scope}`,
			model ? `model:${model}` : undefined,
		]);
		if (metaLine) appendSection(lines, [metaLine]);

		const previewLines = centipedeArr.slice(0, 3).map((step, index) => {
			const task = step.task.replace(/\{previous\}/g, "").trim();
			const preview = toCompactPreview(
				task || "(uses previous output)",
				SUBAGENT_PREVIEW_LIMITS.callCentipedeStep
			);
			const modelTag = formatModelTag(theme, step.model);
			const identity = modelTag
				? `${formatSubagentIdentity(step.agent)} ${modelTag}`
				: formatSubagentIdentity(step.agent);
			return `${formatPresentationText(theme, "meta", `${index + 1}.`)} ${identity} ${formatPresentationText(theme, "process_output", preview)}`;
		});
		if (previewLines.length > 0) appendSection(lines, previewLines, { blankBefore: true });
		if (centipedeArr.length > 3) {
			appendSection(lines, [
				formatPresentationText(theme, "hint", `… +${centipedeArr.length - 3} more steps`),
			]);
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	if (tasksArr && tasksArr.length > 0) {
		appendSection(lines, [formatSubagentHeader(theme, `parallel (${tasksArr.length} tasks)`)]);
		const metaLine = formatMetaLine(theme, [
			`scope:${scope}`,
			model ? `model:${model}` : undefined,
		]);
		if (metaLine) appendSection(lines, [metaLine]);

		const previewLines = tasksArr.slice(0, 2).map((task, index) => {
			const taskPreview = toCompactPreview(task.task, SUBAGENT_PREVIEW_LIMITS.callParallelTask);
			const modelTag = formatModelTag(theme, task.model);
			const identity = modelTag
				? `${formatSubagentIdentity(task.agent)} ${modelTag}`
				: formatSubagentIdentity(task.agent);
			return `${formatPresentationText(theme, "meta", `${index + 1}.`)} ${identity} ${formatPresentationText(theme, "process_output", taskPreview)}`;
		});
		if (previewLines.length > 0) appendSection(lines, previewLines, { blankBefore: true });
		if (tasksArr.length > 2) {
			appendSection(lines, [
				formatPresentationText(theme, "hint", `… +${tasksArr.length - 2} more tasks`),
			]);
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	const agentName = (args.agent as string) || "...";
	const task = typeof args.task === "string" ? args.task : "...";
	appendSection(lines, [formatSubagentHeader(theme, "single", agentName)]);
	const metaLine = formatMetaLine(theme, [`scope:${scope}`, model ? `model:${model}` : undefined]);
	if (metaLine) appendSection(lines, [metaLine]);
	appendSection(
		lines,
		[formatPresentationText(theme, "process_output", toCompactPreview(task, 200))],
		{
			blankBefore: true,
		}
	);
	return new Text(lines.join("\n"), 0, 0);
}

/**
 * Render display items (text + tool calls) from subagent messages.
 *
 * @param items - Display items extracted from assistant messages
 * @param theme - Active theme
 * @param expanded - Whether the tool result is expanded
 * @param options - Optional truncation controls
 * @returns Rendered display lines
 */
function renderDisplayItems(
	items: ReturnType<typeof getDisplayItems>,
	theme: Theme,
	expanded: boolean,
	options?: DisplayRenderOptions
): string[] {
	const limit = options?.itemLimit;
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	const lines: string[] = [];

	if (skipped > 0) {
		lines.push(
			formatPresentationText(theme, "hint", `… ${skipped} earlier item${skipped > 1 ? "s" : ""}`)
		);
	}

	for (const item of toShow) {
		if (item.type === "text") {
			const textLines = item.text
				.split("\n")
				.map((line) => line.trimEnd())
				.filter((line) => line.trim().length > 0);
			if (textLines.length === 0) continue;
			const lineLimit = expanded ? textLines.length : (options?.textLineLimit ?? 2);
			for (let index = 0; index < Math.min(textLines.length, lineLimit); index++) {
				const rawLine = textLines[index] ?? "";
				const preview =
					options?.maxLineLength !== undefined
						? toCompactPreview(rawLine, options.maxLineLength)
						: rawLine;
				const styled = dimProcessOutputLine(preview, (value) =>
					formatPresentationText(theme, "process_output", value)
				);
				if (index === 0) {
					lines.push(`${formatPresentationText(theme, "meta", "•")} ${styled}`);
				} else {
					lines.push(`  ${styled}`);
				}
			}
			continue;
		}

		const toolCallText = formatToolCall(item.name, item.args, createToolCallThemeFg(theme));
		const toolLine = dimProcessOutputLine(toolCallText, (value) =>
			formatPresentationText(theme, "process_output", value)
		);
		lines.push(`${formatPresentationText(theme, "meta", "→")} ${toolLine}`);
	}

	return lines;
}

/**
 * Render the subagent tool result.
 *
 * @param result - Tool result payload
 * @param expanded - Whether result is expanded in the TUI
 * @param theme - Active theme
 * @returns Renderable component
 */
function renderSubagentResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	expanded: boolean,
	theme: Theme
) {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" && text.text ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	if (details.mode === "single" && details.results.length === 1) {
		return renderSingleResult(details, expanded, theme, mdTheme);
	}

	if (details.mode === "centipede") {
		return renderCentipedeResult(details, expanded, theme, mdTheme);
	}

	if (details.mode === "parallel") {
		return renderParallelResult(details, expanded, theme, mdTheme);
	}

	const text = result.content[0];
	return new Text(text?.type === "text" && text.text ? text.text : "(no output)", 0, 0);
}

/**
 * Render a single-mode subagent result.
 */
function renderSingleResult(
	details: SubagentDetails,
	expanded: boolean,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>
) {
	const r = details.results[0];
	const isRunning = r.exitCode === -1;
	const isError = isResultError(r);
	const spinnerChar =
		details.spinnerFrame !== undefined
			? SPINNER_FRAMES[details.spinnerFrame % SPINNER_FRAMES.length]
			: getSpinner()[0];
	const icon = isRunning
		? theme.fg("warning", spinnerChar)
		: isError
			? theme.fg("error", getIcon("error"))
			: theme.fg("success", getIcon("success"));
	const statusLabel = isRunning ? "running" : isError ? "failed" : "completed";
	const headerLine = formatSubagentHeader(theme, statusLabel, r.agent, icon);
	const metaLine = formatMetaLine(theme, [
		`source:${r.agentSource}`,
		r.model ? `model:${r.model}` : undefined,
		!isRunning && r.stopReason ? `stop:${r.stopReason}` : undefined,
	]);
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);
	const usageStr = formatUsageStats(r.usage);

	if (expanded) {
		const container = new Container();
		const lines: string[] = [];
		appendSection(lines, [headerLine]);
		if (metaLine) appendSection(lines, [metaLine]);
		if (isError && r.errorMessage) {
			appendSection(lines, [
				formatPresentationText(theme, "status_error", `Error: ${r.errorMessage}`),
			]);
		}
		if (r.deniedTools && r.deniedTools.length > 0) {
			const unique = [...new Set(r.deniedTools)];
			appendSection(lines, [
				formatPresentationText(theme, "status_warning", `Denied tools: ${unique.join(", ")}`),
			]);
		}

		appendSection(
			lines,
			[
				formatSectionDivider(theme, "Task"),
				formatPresentationText(theme, "process_output", r.task),
			],
			{ blankBefore: true }
		);

		const activityItems = finalOutput
			? displayItems.filter((item) => item.type === "toolCall")
			: displayItems;
		const activityLines = renderDisplayItems(activityItems, theme, true, {
			maxLineLength: 140,
			textLineLimit: 6,
		});
		appendSection(
			lines,
			[
				formatSectionDivider(theme, "Activity"),
				...(activityLines.length > 0
					? activityLines
					: [
							formatPresentationText(
								theme,
								"meta",
								finalOutput ? "(no tool calls)" : "(no activity)"
							),
						]),
			],
			{ blankBefore: true }
		);

		if (finalOutput) {
			appendSection(lines, [formatSectionDivider(theme, "Final output")], { blankBefore: true });
		}

		container.addChild(new Text(lines.join("\n"), 0, 0));

		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}

		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(formatSectionDivider(theme, "Usage"), 0, 0));
			container.addChild(new Text(formatPresentationText(theme, "meta", usageStr), 0, 0));
		}
		return container;
	}

	const lines: string[] = [];
	appendSection(lines, [headerLine]);
	if (metaLine) appendSection(lines, [metaLine]);

	if (isRunning) {
		const activityLines = renderDisplayItems(displayItems, theme, false, {
			itemLimit: 2,
			maxLineLength: 92,
			textLineLimit: 1,
		});
		if (activityLines.length > 0) {
			appendSection(lines, [formatSectionDivider(theme, "Activity"), ...activityLines], {
				blankBefore: true,
			});
		} else {
			appendSection(lines, [formatPresentationText(theme, "meta", "(running, no output yet)")], {
				blankBefore: true,
			});
		}
	} else if (isError) {
		const errorInfo = r.errorMessage || r.stderr || finalOutput || "(no output)";
		appendSection(
			lines,
			[
				formatSectionDivider(theme, "Error"),
				formatPresentationText(theme, "status_error", toCompactPreview(errorInfo, 140)),
			],
			{ blankBefore: true }
		);
	} else {
		const activityLines = renderDisplayItems(displayItems, theme, false, {
			itemLimit: COLLAPSED_ITEM_COUNT,
			maxLineLength: 92,
			textLineLimit: 2,
		});
		if (activityLines.length > 0) {
			appendSection(lines, [formatSectionDivider(theme, "Activity"), ...activityLines], {
				blankBefore: true,
			});
		} else {
			appendSection(lines, [formatPresentationText(theme, "meta", "(no output)")], {
				blankBefore: true,
			});
		}
		if (displayItems.length > COLLAPSED_ITEM_COUNT) {
			appendSection(lines, [formatPresentationText(theme, "hint", "(Ctrl+O to expand)")]);
		}
	}

	if (r.deniedTools && r.deniedTools.length > 0) {
		const unique = [...new Set(r.deniedTools)];
		appendSection(
			lines,
			[formatPresentationText(theme, "status_warning", `Denied tools: ${unique.join(", ")}`)],
			{
				blankBefore: true,
			}
		);
	}

	if (usageStr) {
		appendSection(lines, [formatPresentationText(theme, "meta", usageStr)], {
			blankBefore: true,
		});
	}

	return new Text(lines.join("\n"), 0, 0);
}

/**
 * Build a compact preview line for collapsed tree nodes.
 *
 * @param result - Single subagent result
 * @param theme - Active theme
 * @param maxLineLength - Maximum preview width
 * @returns Formatted preview line
 */
function formatCollapsedResultPreview(
	result: SingleResult,
	theme: Theme,
	maxLineLength: number
): string {
	const rendered = renderDisplayItems(getDisplayItems(result.messages), theme, false, {
		itemLimit: 1,
		maxLineLength,
		textLineLimit: 1,
	});
	if (rendered.length > 0) return rendered[0] ?? "";
	const fallback = result.errorMessage || result.stderr || result.task || "(no output)";
	const state = getParallelResultState(result);
	const role =
		state === "failed" ? "status_error" : state === "stalled" ? "status_warning" : "process_output";
	return formatPresentationText(theme, role, toCompactPreview(fallback, maxLineLength));
}

/**
 * Render a centipede-mode subagent result.
 *
 * @param details - Render details with centipede results
 * @param expanded - Whether the result is expanded
 * @param theme - Active theme
 * @param mdTheme - Markdown theme for rich output
 * @returns Renderable component
 */
function renderCentipedeResult(
	details: SubagentDetails,
	expanded: boolean,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>
) {
	const totalSteps = details.centipedeSteps?.length ?? details.results.length;
	const runningCount = details.results.filter((result) => result.exitCode === -1).length;
	const successCount = details.results.filter((result) => result.exitCode === 0).length;
	const failCount = details.results.filter((result) => isResultError(result)).length;
	const isRunning = runningCount > 0;
	const spinnerChar =
		details.spinnerFrame !== undefined
			? SPINNER_FRAMES[details.spinnerFrame % SPINNER_FRAMES.length]
			: getSpinner()[0];
	const icon = isRunning
		? theme.fg("warning", spinnerChar)
		: failCount > 0
			? theme.fg("error", getIcon("error"))
			: theme.fg("success", getIcon("success"));
	const summaryLine = formatMetaLine(theme, [
		`${successCount + failCount}/${totalSteps} done`,
		runningCount > 0 ? `${runningCount} running` : undefined,
		failCount > 0 ? `${failCount} failed` : undefined,
	]);

	if (expanded) {
		const container = new Container();
		const headerLines: string[] = [formatSubagentHeader(theme, "centipede", undefined, icon)];
		if (summaryLine) appendSection(headerLines, [summaryLine]);
		container.addChild(new Text(headerLines.join("\n"), 0, 0));

		for (let si = 0; si < totalSteps; si++) {
			const stepNum = si + 1;
			const stepResult = details.results.find((result) => result.step === stepNum);
			const stepAgent =
				stepResult?.agent ?? details.centipedeSteps?.[si]?.agent ?? `step ${stepNum}`;
			const stepStatus = !stepResult
				? "pending"
				: stepResult.exitCode === -1
					? "running"
					: isResultError(stepResult)
						? "failed"
						: "completed";
			const stepStatusRole = !stepResult
				? "meta"
				: stepResult.exitCode === -1
					? "status_warning"
					: isResultError(stepResult)
						? "status_error"
						: "status_success";
			const stepIcon = !stepResult
				? ""
				: stepResult.exitCode === -1
					? theme.fg("warning", spinnerChar)
					: isResultError(stepResult)
						? theme.fg("error", getIcon("error"))
						: theme.fg("success", getIcon("success"));
			const modelTag = formatModelTag(theme, stepResult?.model);

			const stepLines: string[] = [];
			appendSection(stepLines, [formatSectionDivider(theme, `Step ${stepNum}`)]);
			appendSection(stepLines, [
				`${stepIcon ? `${stepIcon} ` : ""}${formatSubagentIdentity(stepAgent)}${modelTag ? ` ${modelTag}` : ""} ${formatPresentationText(theme, stepStatusRole, `(${stepStatus})`)}`,
			]);

			if (stepResult) {
				appendSection(
					stepLines,
					[
						formatSectionDivider(theme, "Task"),
						formatPresentationText(theme, "process_output", stepResult.task),
					],
					{ blankBefore: true }
				);

				const activityLines = renderDisplayItems(
					getDisplayItems(stepResult.messages).filter((item) => item.type === "toolCall"),
					theme,
					true,
					{
						maxLineLength: 120,
						textLineLimit: 4,
					}
				);
				appendSection(
					stepLines,
					[
						formatSectionDivider(theme, "Activity"),
						...(activityLines.length > 0
							? activityLines
							: [formatPresentationText(theme, "meta", "(no tool calls)")]),
					],
					{ blankBefore: true }
				);

				const stepUsage = formatUsageStats(stepResult.usage);
				if (stepUsage) {
					appendSection(stepLines, [formatPresentationText(theme, "meta", stepUsage)], {
						blankBefore: true,
					});
				}
			} else {
				const pendingTask = details.centipedeSteps?.[si]?.task;
				if (pendingTask) {
					appendSection(
						stepLines,
						[formatPresentationText(theme, "hint", toCompactPreview(pendingTask, 120))],
						{ blankBefore: true }
					);
				}
			}

			container.addChild(new Spacer(1));
			container.addChild(new Text(stepLines.join("\n"), 0, 0));

			const finalOutput = stepResult ? getFinalOutput(stepResult.messages) : "";
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}

		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(formatSectionDivider(theme, "Total usage"), 0, 0));
			container.addChild(new Text(formatPresentationText(theme, "meta", usageStr), 0, 0));
		}
		return container;
	}

	const lines: string[] = [formatSubagentHeader(theme, "centipede", undefined, icon)];
	if (summaryLine) appendSection(lines, [summaryLine]);

	for (let si = 0; si < totalSteps; si++) {
		const stepNum = si + 1;
		const stepResult = details.results.find((result) => result.step === stepNum);
		const stepAgent = stepResult?.agent ?? details.centipedeSteps?.[si]?.agent ?? `step ${stepNum}`;
		const isLast = si === totalSteps - 1;
		const branch = formatPresentationText(theme, "meta", isLast ? "└─" : "├─");
		const stem = isLast ? "   " : `${formatPresentationText(theme, "meta", "│")}  `;
		const stepStatus = !stepResult
			? "pending"
			: stepResult.exitCode === -1
				? "running"
				: isResultError(stepResult)
					? "failed"
					: "done";
		const statusRole = !stepResult
			? "meta"
			: stepResult.exitCode === -1
				? "status_warning"
				: isResultError(stepResult)
					? "status_error"
					: "status_success";
		const stepIcon = !stepResult
			? ""
			: stepResult.exitCode === -1
				? theme.fg("warning", spinnerChar)
				: isResultError(stepResult)
					? theme.fg("error", getIcon("error"))
					: theme.fg("success", getIcon("success"));
		const modelTag = formatModelTag(theme, stepResult?.model);
		lines.push(
			`${branch} ${stepIcon ? `${stepIcon} ` : ""}${formatSubagentIdentity(stepAgent)}${modelTag ? ` ${modelTag}` : ""} ${formatPresentationText(theme, statusRole, `(${stepStatus})`)}`
		);

		if (stepResult) {
			lines.push(`${stem}${formatCollapsedResultPreview(stepResult, theme, 72)}`);
			const stepUsage = formatUsageStats(stepResult.usage);
			if (stepUsage) lines.push(`${stem}${formatPresentationText(theme, "meta", stepUsage)}`);
		} else {
			const pendingTask = details.centipedeSteps?.[si]?.task;
			if (pendingTask) {
				lines.push(
					`${stem}${formatPresentationText(theme, "hint", toCompactPreview(pendingTask, 72))}`
				);
			}
		}
	}

	const usageStr = formatUsageStats(aggregateUsage(details.results));
	if (usageStr) {
		appendSection(lines, [formatPresentationText(theme, "meta", `total ${usageStr}`)], {
			blankBefore: true,
		});
	}
	if (!isRunning)
		appendSection(lines, [formatPresentationText(theme, "hint", "(Ctrl+O to expand)")]);
	return new Text(lines.join("\n"), 0, 0);
}

/**
 * Render a parallel-mode subagent result.
 */
function renderParallelResult(
	details: SubagentDetails,
	expanded: boolean,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>
) {
	const counts = countParallelResultStates(details.results);
	const isRunning = counts.running > 0;
	const spinnerChar =
		details.spinnerFrame !== undefined
			? SPINNER_FRAMES[details.spinnerFrame % SPINNER_FRAMES.length]
			: getSpinner()[0];
	const icon = isRunning
		? theme.fg("warning", spinnerChar)
		: counts.failed > 0
			? theme.fg("error", getIcon("error"))
			: counts.stalled > 0
				? theme.fg("warning", getIcon("blocked"))
				: theme.fg("success", getIcon("success"));
	const summaryLine = formatMetaLine(theme, [
		`${counts.finished}/${details.results.length} done`,
		`${counts.completed} completed`,
		counts.failed > 0 ? `${counts.failed} failed` : undefined,
		`${counts.stalled} stalled`,
		counts.running > 0 ? `${counts.running} running` : undefined,
	]);

	if (expanded && !isRunning) {
		const container = new Container();
		const headerLines = [formatSubagentHeader(theme, "parallel", undefined, icon)];
		if (summaryLine) appendSection(headerLines, [summaryLine]);
		container.addChild(new Text(headerLines.join("\n"), 0, 0));

		for (const result of details.results) {
			const resultState = getParallelResultState(result);
			const resultStatus = resultState === "completed" ? "completed" : resultState;
			const resultStatusRole =
				resultState === "failed"
					? "status_error"
					: resultState === "stalled" || resultState === "running"
						? "status_warning"
						: "status_success";
			const resultIcon =
				resultState === "failed"
					? theme.fg("error", getIcon("error"))
					: resultState === "stalled"
						? theme.fg("warning", getIcon("blocked"))
						: resultState === "running"
							? theme.fg("warning", spinnerChar)
							: theme.fg("success", getIcon("success"));
			const resultLines: string[] = [];
			const modelTag = formatModelTag(theme, result.model);

			appendSection(resultLines, [formatSectionDivider(theme, result.agent)]);
			appendSection(resultLines, [
				`${resultIcon} ${formatSubagentIdentity(result.agent)}${modelTag ? ` ${modelTag}` : ""} ${formatPresentationText(theme, resultStatusRole, resultStatus)}`,
			]);
			const resultMeta = formatMetaLine(theme, [
				`source:${result.agentSource}`,
				result.stopReason ? `stop:${result.stopReason}` : undefined,
			]);
			if (resultMeta) appendSection(resultLines, [resultMeta]);

			appendSection(
				resultLines,
				[
					formatSectionDivider(theme, "Task"),
					formatPresentationText(theme, "process_output", result.task),
				],
				{ blankBefore: true }
			);

			const activityLines = renderDisplayItems(
				getDisplayItems(result.messages).filter((item) => item.type === "toolCall"),
				theme,
				true,
				{
					maxLineLength: 120,
					textLineLimit: 4,
				}
			);
			appendSection(
				resultLines,
				[
					formatSectionDivider(theme, "Activity"),
					...(activityLines.length > 0
						? activityLines
						: [formatPresentationText(theme, "meta", "(no tool calls)")]),
				],
				{ blankBefore: true }
			);

			container.addChild(new Spacer(1));
			container.addChild(new Text(resultLines.join("\n"), 0, 0));

			const finalOutput = getFinalOutput(result.messages);
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			} else {
				const errInfo = result.errorMessage || result.stderr;
				if (errInfo) {
					const errRole = resultState === "failed" ? "status_error" : "status_warning";
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(formatPresentationText(theme, errRole, toCompactPreview(errInfo, 200)), 0, 0)
					);
				}
			}

			const taskUsage = formatUsageStats(result.usage);
			if (taskUsage) {
				container.addChild(new Text(formatPresentationText(theme, "meta", taskUsage), 0, 0));
			}
		}

		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(formatSectionDivider(theme, "Total usage"), 0, 0));
			container.addChild(new Text(formatPresentationText(theme, "meta", usageStr), 0, 0));
		}
		return container;
	}

	const lines: string[] = [formatSubagentHeader(theme, "parallel", undefined, icon)];
	if (summaryLine) appendSection(lines, [summaryLine]);

	for (let index = 0; index < details.results.length; index++) {
		const result = details.results[index];
		const isLast = index === details.results.length - 1;
		const branch = formatPresentationText(theme, "meta", isLast ? "└─" : "├─");
		const stem = isLast ? "   " : `${formatPresentationText(theme, "meta", "│")}  `;
		const resultState = getParallelResultState(result);
		const resultStatus = resultState === "completed" ? "done" : resultState;
		const statusRole =
			resultState === "failed"
				? "status_error"
				: resultState === "stalled" || resultState === "running"
					? "status_warning"
					: "status_success";
		const resultIcon =
			resultState === "failed"
				? theme.fg("error", getIcon("error"))
				: resultState === "stalled"
					? theme.fg("warning", getIcon("blocked"))
					: resultState === "running"
						? theme.fg("warning", spinnerChar)
						: theme.fg("success", getIcon("success"));
		const modelTag = formatModelTag(theme, result.model);
		lines.push(
			`${branch} ${resultIcon} ${formatSubagentIdentity(result.agent)}${modelTag ? ` ${modelTag}` : ""} ${formatPresentationText(theme, statusRole, `(${resultStatus})`)}`
		);
		const collapsedPreview = formatCollapsedResultPreview(
			result,
			theme,
			SUBAGENT_PREVIEW_LIMITS.collapsedParallelResult
		);
		lines.push(`${stem}${collapsedPreview}`);
		if (!isRunning) {
			const taskUsage = formatUsageStats(result.usage);
			if (taskUsage) lines.push(`${stem}${formatPresentationText(theme, "meta", taskUsage)}`);
		}
	}

	const usageStr = formatUsageStats(aggregateUsage(details.results));
	if (usageStr) {
		appendSection(lines, [formatPresentationText(theme, "meta", `total ${usageStr}`)], {
			blankBefore: true,
		});
	}
	if (!isRunning && !expanded) {
		appendSection(lines, [formatPresentationText(theme, "hint", "(Ctrl+O to expand)")]);
	}
	return new Text(lines.join("\n"), 0, 0);
}
