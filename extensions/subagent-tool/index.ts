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
	clearAllSubagents,
	clearForegroundSubagents,
	formatDuration,
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
				bg.status = "failed";
				bg.result.exitCode = 1;
				bg.result.stopReason = "interrupted";
				mutated = true;
				setTimeout(() => {
					if (!bg.process.killed) bg.process.kill("SIGKILL");
				}, 3000);
			}
		}
		if (mutated) publishSubagentSnapshot(pi.events);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate tasks to specialized subagents with isolated context. Modes: single (agent + task), parallel (tasks array), centipede (sequential with {previous} placeholder). Default agent scope is "user" (from ~/.tallow/agents). To include project-local agents, set agentScope: "both". Missing agent names recover gracefully via best-match or ephemeral fallback.

MODEL SELECTION:
- model: explicit model name (fuzzy matched, e.g. "opus", "haiku", "gemini flash")
- No model specified: auto-routes based on task type and complexity
- costPreference: "eco" (cheapest capable), "balanced" (default), "premium" (best available)
- taskType: override auto-detected type ("code", "vision", "text")
- complexity: override auto-detected complexity (1=trivial to 5=expert)
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
				params.costPreference || params.taskType || params.complexity
					? {
							costPreference: params.costPreference as RoutingHints["costPreference"],
							taskType: params.taskType as RoutingHints["taskType"],
							complexity: params.complexity,
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
		label: "Subagent Status",
		description:
			"Check status of background subagents. Optionally provide a taskId to get details for a specific task.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Specific task ID to check (optional)" })),
		}),
		async execute(_toolCallId, params) {
			if (params.taskId) {
				const bg = backgroundSubagents.get(params.taskId);
				if (!bg) {
					return {
						details: {},
						content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					};
				}
				const duration = formatDuration(Date.now() - bg.startTime);
				const output = getFinalOutput(bg.result.messages) || "(no output yet)";
				return {
					details: {},
					content: [
						{
							type: "text",
							text: `**Task:** ${bg.id}\n**Agent:** ${bg.agent}\n**Status:** ${bg.status}\n**Duration:** ${duration}\n**Task:** ${bg.task}\n\n**Output:**\n${output}`,
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
				return `${statusIcon} **${bg.id}** (${bg.agent}) - ${bg.status} (${duration})\n   ${preview}`;
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

/**
 * Execute parallel mode.
 */
async function executeParallel(
	tasks: { agent: string; task: string; cwd?: string; model?: string }[],
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
	if (tasks.length > MAX_PARALLEL_TASKS)
		return {
			content: [
				{
					type: "text" as const,
					text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				},
			],
			details: makeDetails("parallel")([]),
		};

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
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			const details = makeDetails("parallel")([...allResults]);
			details.spinnerFrame = spinnerFrame;
			onUpdate({
				content: [
					{
						type: "text",
						text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
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

	ctx.ui.setWorkingMessage(`Waiting for ${tasks.length} parallel agents to finish`);

	let results: SingleResult[];
	try {
		results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
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
						allResults[index] = partial.details.results[0];
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
			allResults[index] = result;
			return result;
		});
	} finally {
		if (spinnerInterval) {
			clearInterval(spinnerInterval);
			spinnerInterval = null;
		}
		ctx.ui.setWorkingMessage();
	}

	const successCount = results.filter((r) => r.exitCode === 0).length;
	const summaries = results.map((r) => {
		const output = getFinalOutput(r.messages);
		const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
		return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
	});
	return {
		content: [
			{
				type: "text" as const,
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
			},
		],
		details: makeDetails("parallel")(results),
	};
}

/**
 * Execute single agent mode.
 */
async function executeSingle(
	params: {
		agent?: string;
		task?: string;
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
	const agentName = params.agent!;
	const task = params.task!;

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

/**
 * Render the tool call header for the subagent tool.
 */
function renderSubagentCall(args: Record<string, unknown>, theme: Theme) {
	const scope: AgentScope = (args.agentScope as AgentScope) ?? "user";
	const modelTag = args.model ? ` ${theme.fg("dim", args.model as string)}` : "";
	const centipedeArr = coerceArray(
		args.centipede as { agent: string; task: string }[] | string | undefined
	);
	const tasksArr = coerceArray(
		args.tasks as { agent: string; task: string }[] | string | undefined
	);
	if (centipedeArr && centipedeArr.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `centipede (${centipedeArr.length} steps)`) +
			theme.fg("muted", ` [${scope}]`) +
			modelTag;
		for (let i = 0; i < Math.min(centipedeArr.length, 3); i++) {
			const step = centipedeArr[i];
			const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
			const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
			text +=
				"\n  " +
				theme.fg("muted", `${i + 1}.`) +
				" " +
				theme.fg("accent", step.agent) +
				theme.fg("dim", ` ${preview}`);
		}
		if (centipedeArr.length > 3)
			text += `\n  ${theme.fg("muted", `... +${centipedeArr.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	if (tasksArr && tasksArr.length > 0) {
		const text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${tasksArr.length} tasks)`) +
			theme.fg("muted", ` [${scope}]`) +
			modelTag;
		return new Text(text, 0, 0);
	}
	const agentName = (args.agent as string) || "...";
	const preview = args.task
		? (args.task as string).length > 200
			? `${(args.task as string).slice(0, 200)}...`
			: (args.task as string)
		: "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}]`) +
		modelTag;
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

/**
 * Render display items (text + tool calls) from subagent messages.
 */
function renderDisplayItems(
	items: ReturnType<typeof getDisplayItems>,
	theme: Theme,
	expanded: boolean,
	limit?: number
) {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded
				? item.text
				: item.text
						.split("\n")
						.filter((l) => l.trim())
						.slice(0, 3)
						.join("\n");
			text += `${theme.fg("dim", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

/**
 * Render the subagent tool result.
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
	const themeFg = theme.fg.bind(theme);

	if (details.mode === "single" && details.results.length === 1) {
		return renderSingleResult(details, expanded, theme, mdTheme, themeFg);
	}

	if (details.mode === "centipede") {
		return renderCentipedeResult(details, expanded, theme, mdTheme, themeFg);
	}

	if (details.mode === "parallel") {
		return renderParallelResult(details, expanded, theme, mdTheme, themeFg);
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
	mdTheme: ReturnType<typeof getMarkdownTheme>,
	themeFg: (color: ThemeColor, text: string) => string
) {
	const r = details.results[0];
	const isRunning = r.exitCode === -1;
	const isError =
		!isRunning && (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted");
	const spinnerChar =
		details.spinnerFrame !== undefined
			? SPINNER_FRAMES[details.spinnerFrame % SPINNER_FRAMES.length]
			: getSpinner()[0];
	const icon = isRunning
		? theme.fg("warning", spinnerChar)
		: isError
			? theme.fg("error", getIcon("error"))
			: theme.fg("success", getIcon("success"));
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);

	if (expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (r.model) header += ` ${theme.fg("dim", r.model)}`;
		if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		container.addChild(new Text(header, 0, 0));
		if (isError && r.errorMessage)
			container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
		if (r.deniedTools && r.deniedTools.length > 0) {
			const unique = [...new Set(r.deniedTools)];
			container.addChild(
				new Text(theme.fg("warning", `⚠ Denied tools: ${unique.join(", ")}`), 0, 0)
			);
		}
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall")
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg), 0, 0)
					);
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
	if (r.model) text += ` ${theme.fg("dim", r.model)}`;
	if (isRunning) {
		text += ` ${theme.fg("warning", "(running...)")}`;
		if (displayItems.length > 0) {
			text += `\n${renderDisplayItems(displayItems, theme, expanded, 3)}`;
		}
	} else if (isError && r.stopReason) {
		text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
	} else if (displayItems.length === 0) {
		text += `\n${theme.fg("muted", "(no output)")}`;
	} else {
		text += `\n${renderDisplayItems(displayItems, theme, expanded, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT)
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	if (r.deniedTools && r.deniedTools.length > 0) {
		const unique = [...new Set(r.deniedTools)];
		text += `\n${theme.fg("warning", `⚠ Denied: ${unique.join(", ")}`)}`;
	}
	{
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	}
	return new Text(text, 0, 0);
}

/**
 * Render a centipede-mode subagent result.
 */
function renderCentipedeResult(
	details: SubagentDetails,
	expanded: boolean,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
	themeFg: (color: ThemeColor, text: string) => string
) {
	const totalSteps = details.centipedeSteps?.length ?? details.results.length;
	const isRunning = details.results.some((r) => r.exitCode === -1);
	const successCount = details.results.filter((r) => r.exitCode === 0).length;
	const failCount = details.results.filter((r) => r.exitCode > 0).length;
	const spinnerChar =
		details.spinnerFrame !== undefined
			? SPINNER_FRAMES[details.spinnerFrame % SPINNER_FRAMES.length]
			: getSpinner()[0];

	const icon = isRunning
		? theme.fg("warning", spinnerChar)
		: failCount > 0
			? theme.fg("error", getIcon("error"))
			: theme.fg("success", getIcon("success"));

	const getStepIcon = (stepNum: number): string => {
		const r = details.results.find((res) => res.step === stepNum);
		if (!r) return "";
		if (r.exitCode === -1) return ` ${theme.fg("warning", spinnerChar)}`;
		if (r.exitCode === 0) return ` ${theme.fg("success", getIcon("success"))}`;
		return ` ${theme.fg("error", getIcon("error"))}`;
	};

	if (expanded) {
		const container = new Container();
		container.addChild(
			new Text(
				icon +
					" " +
					theme.fg("toolTitle", theme.bold("centipede ")) +
					theme.fg("accent", `${successCount}/${totalSteps} steps`),
				0,
				0
			)
		);

		for (let si = 0; si < totalSteps; si++) {
			const stepNum = si + 1;
			const r = details.results.find((res) => res.step === stepNum);
			const stepAgent = r?.agent ?? details.centipedeSteps?.[si]?.agent ?? `step ${stepNum}`;
			const rIcon = getStepIcon(stepNum);

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg("muted", `─── Step ${stepNum}: `) + theme.fg("accent", stepAgent) + rIcon,
					0,
					0
				)
			);

			if (r) {
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg),
								0,
								0
							)
						);
					}
				}

				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const stepUsage = formatUsageStats(r.usage, r.model);
				if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
			}
		}

		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
		}
		return container;
	}

	// Collapsed view
	let text =
		icon +
		" " +
		theme.fg("toolTitle", theme.bold("centipede ")) +
		theme.fg("accent", `${successCount}/${totalSteps} steps`);
	for (let si = 0; si < totalSteps; si++) {
		const stepNum = si + 1;
		const r = details.results.find((res) => res.step === stepNum);
		const stepAgent = r?.agent ?? details.centipedeSteps?.[si]?.agent ?? `step ${stepNum}`;
		const rIcon = getStepIcon(stepNum);
		text += `\n\n${theme.fg("muted", `─── Step ${stepNum}: `)}${theme.fg("accent", stepAgent)}${rIcon}`;
		if (r) {
			const displayItems = getDisplayItems(r.messages);
			if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else text += `\n${renderDisplayItems(displayItems, theme, expanded, 5)}`;
			const stepUsage = formatUsageStats(r.usage, r.model);
			if (stepUsage) text += `\n${theme.fg("dim", stepUsage)}`;
		}
	}
	const usageStr = formatUsageStats(aggregateUsage(details.results));
	if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	if (!isRunning) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

/**
 * Render a parallel-mode subagent result.
 */
function renderParallelResult(
	details: SubagentDetails,
	expanded: boolean,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
	themeFg: (color: ThemeColor, text: string) => string
) {
	const running = details.results.filter((r) => r.exitCode === -1).length;
	const successCount = details.results.filter((r) => r.exitCode === 0).length;
	const failCount = details.results.filter((r) => r.exitCode > 0).length;
	const isRunning = running > 0;
	const spinnerChar =
		details.spinnerFrame !== undefined
			? SPINNER_FRAMES[details.spinnerFrame % SPINNER_FRAMES.length]
			: getSpinner()[0];
	const icon = isRunning
		? theme.fg("warning", spinnerChar)
		: failCount > 0
			? theme.fg("warning", getSpinner()[0])
			: theme.fg("success", getIcon("success"));
	const status = isRunning
		? `${successCount + failCount}/${details.results.length} done, ${running} running`
		: `${details.results.length} agents complete`;

	if (expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
				0,
				0
			)
		);

		for (const r of details.results) {
			const rIcon =
				r.exitCode === 0
					? theme.fg("success", getIcon("success"))
					: theme.fg("error", getIcon("error"));
			const displayItems = getDisplayItems(r.messages);
			const finalOutput = getFinalOutput(r.messages);

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0)
			);
			container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg), 0, 0)
					);
				}
			}

			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}

			const taskUsage = formatUsageStats(r.usage, r.model);
			if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
		}

		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
		}
		return container;
	}

	if (isRunning) {
		let text = `${theme.fg("warning", spinnerChar)} ${theme.fg("accent", status)}`;
		for (let i = 0; i < details.results.length; i++) {
			const r = details.results[i];
			const isLast = i === details.results.length - 1;
			const treeChar = isLast ? "└─" : "├─";
			const rIcon =
				r.exitCode === -1
					? theme.fg("warning", spinnerChar)
					: r.exitCode === 0
						? theme.fg("success", getIcon("success"))
						: theme.fg("error", getIcon("error"));
			const taskPreview = r.task.length > 40 ? `${r.task.slice(0, 37)}...` : r.task;
			const modelTag = r.model ? ` ${theme.fg("dim", r.model)}` : "";
			const contChar = isLast ? "   " : `${theme.fg("muted", "│")}  `;
			text += `\n${theme.fg("muted", treeChar)} ${theme.fg("accent", r.agent)} ${rIcon}${modelTag}`;
			text += `\n${contChar}${theme.fg("dim", taskPreview)}`;
			const agentUsage = formatUsageStats(r.usage);
			if (agentUsage) text += `\n${contChar}${theme.fg("dim", agentUsage)}`;
		}
		const liveTotal = formatUsageStats(aggregateUsage(details.results));
		if (liveTotal) text += `\n${theme.fg("dim", `Total: ${liveTotal}`)}`;
		return new Text(text, 0, 0);
	}

	let text = `${icon} ${theme.fg("accent", status)}`;
	for (let i = 0; i < details.results.length; i++) {
		const r = details.results[i];
		const isLast = i === details.results.length - 1;
		const treeChar = isLast ? "└─" : "├─";
		const contChar = isLast ? "   " : `${theme.fg("muted", "│")}  `;
		const rIcon =
			r.exitCode === 0
				? theme.fg("success", getIcon("success"))
				: theme.fg("error", getIcon("error"));
		const displayItems = getDisplayItems(r.messages);
		const modelTag = r.model ? ` ${theme.fg("dim", r.model)}` : "";
		text += `\n${theme.fg("muted", treeChar)} ${theme.fg("accent", r.agent)} ${rIcon}${modelTag}`;
		if (displayItems.length === 0) text += `\n${contChar}${theme.fg("muted", "(no output)")}`;
		else {
			const rendered = renderDisplayItems(displayItems, theme, expanded, 5)
				.split("\n")
				.filter((l) => l.trim())
				.join(`\n${contChar}`);
			text += `\n${contChar}${rendered}`;
		}
	}
	const usageStr = formatUsageStats(aggregateUsage(details.results));
	if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}
