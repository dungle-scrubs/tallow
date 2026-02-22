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
import {
	emitWorktreeLifecycleEvent,
	type WorktreeLifecycleScope,
} from "../_shared/interop-events.js";
import { expandFileReferences } from "../file-reference/index.js";
import { createWorktree, removeWorktree, validateGitRepo } from "../worktree/lifecycle.js";
import type { AgentConfig, AgentDefaults } from "./agents.js";
import {
	computeEffectiveTools,
	resolveAgentForExecution,
	resolveEffectiveIsolation,
} from "./agents.js";
import { getFinalOutput, type SingleResult, type SubagentDetails } from "./formatting.js";
import type { RoutingHints } from "./model-router.js";
import { routeModel } from "./model-router.js";
import type {
	IsolationMode,
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
	setForegroundSubagentStatus,
	startBackgroundSubagentCleanupLoop,
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

/** Env flag that disables background-history compaction for debugging. */
export const SUBAGENT_KEEP_FULL_HISTORY_ENV = "TALLOW_SUBAGENT_KEEP_FULL_HISTORY";

/** Env var to tune retained background-message tail length after completion. */
export const SUBAGENT_HISTORY_TAIL_MESSAGES_ENV = "TALLOW_SUBAGENT_HISTORY_TAIL_MESSAGES";

/** Default retained message tail length for completed background subagents. */
export const SUBAGENT_HISTORY_TAIL_MESSAGES_DEFAULT = 24;

/** Max retained message tail length for completed background subagents. */
export const SUBAGENT_HISTORY_TAIL_MESSAGES_MAX = 200;

type EnvLookup = Readonly<Record<string, string | undefined>>;

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
 * Parse truthy env-flag values.
 * @param rawValue - Raw env value
 * @returns true when value enables the feature
 */
function isTruthyEnvFlag(rawValue: string | undefined): boolean {
	if (!rawValue) return false;
	const normalized = rawValue.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Check whether background subagent history compaction is disabled.
 * @param env - Environment lookup map
 * @returns true when full-history mode is enabled
 */
export function shouldKeepFullBackgroundSubagentHistory(env: EnvLookup = process.env): boolean {
	return isTruthyEnvFlag(env[SUBAGENT_KEEP_FULL_HISTORY_ENV]);
}

/**
 * Parse a bounded positive retained-tail count from an env var.
 * @param rawValue - Raw env value
 * @returns Parsed retained-tail count, or undefined when invalid
 */
function parseRetainedTailCount(rawValue: string | undefined): number | undefined {
	if (!rawValue) return undefined;
	const parsed = Number.parseInt(rawValue, 10);
	if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return undefined;
	if (parsed < 0) return undefined;
	return Math.min(parsed, SUBAGENT_HISTORY_TAIL_MESSAGES_MAX);
}

/**
 * Resolve retained message-tail count for compacted background histories.
 * @param env - Environment lookup map
 * @returns Number of tail messages to keep
 */
export function getBackgroundHistoryTailMessageLimit(env: EnvLookup = process.env): number {
	const parsed = parseRetainedTailCount(env[SUBAGENT_HISTORY_TAIL_MESSAGES_ENV]);
	return parsed ?? SUBAGENT_HISTORY_TAIL_MESSAGES_DEFAULT;
}

/**
 * Locate the last assistant message that contains text output.
 * @param messages - Message history
 * @returns Final assistant text message when present
 */
function getFinalAssistantTextMessage(messages: Message[]): Message | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.content.some((part) => part.type === "text")) {
			return message;
		}
	}
	return undefined;
}

/**
 * Compact a background subagent message history to a bounded debug tail.
 * Always preserves final assistant output text.
 * @param messages - Full message history
 * @param retainedTailLimit - Maximum tail size to keep
 * @returns Compacted-message payload with counts and final output text
 */
export function compactBackgroundMessages(
	messages: Message[],
	retainedTailLimit: number
): {
	compactedMessages: Message[];
	finalOutput: string;
	originalMessageCount: number;
	retainedMessageCount: number;
} {
	const originalMessageCount = messages.length;
	const finalOutput = getFinalOutput(messages);
	const boundedTailLimit = Math.max(
		0,
		Math.min(SUBAGENT_HISTORY_TAIL_MESSAGES_MAX, Math.floor(retainedTailLimit))
	);
	const compactedMessages = boundedTailLimit > 0 ? messages.slice(-boundedTailLimit) : [];
	const finalAssistantMessage = getFinalAssistantTextMessage(messages);
	if (finalAssistantMessage && !compactedMessages.includes(finalAssistantMessage)) {
		compactedMessages.push(finalAssistantMessage);
	}
	return {
		compactedMessages,
		finalOutput,
		originalMessageCount,
		retainedMessageCount: compactedMessages.length,
	};
}

/**
 * Apply retention policy to completed background-subagent history.
 * @param subagent - Background subagent record to compact
 * @param env - Environment lookup map
 */
export function applyBackgroundResultRetention(
	subagent: BackgroundSubagent,
	env: EnvLookup = process.env
): void {
	const originalMessages = subagent.result.messages;
	if (shouldKeepFullBackgroundSubagentHistory(env)) {
		subagent.retainedFinalOutput = getFinalOutput(originalMessages);
		subagent.historyCompacted = false;
		subagent.historyOriginalMessageCount = originalMessages.length;
		subagent.historyRetainedMessageCount = originalMessages.length;
		return;
	}

	const compacted = compactBackgroundMessages(
		originalMessages,
		getBackgroundHistoryTailMessageLimit(env)
	);
	subagent.result.messages = compacted.compactedMessages;
	subagent.retainedFinalOutput = compacted.finalOutput;
	subagent.historyCompacted = compacted.retainedMessageCount < compacted.originalMessageCount;
	subagent.historyOriginalMessageCount = compacted.originalMessageCount;
	subagent.historyRetainedMessageCount = compacted.retainedMessageCount;
}

/** Managed isolation metadata for one subagent invocation. */
interface SubagentIsolationContext {
	readonly mode: IsolationMode;
	readonly repoRoot: string;
	readonly worktreePath: string;
}

/**
 * Provision execution isolation for one subagent invocation.
 *
 * @param baseCwd - Base working directory before isolation
 * @param requestedIsolation - Explicit per-call isolation, if any
 * @param agent - Resolved agent config
 * @param defaults - Defaults from _defaults.md
 * @param lifecycleScope - Lifecycle scope for emitted events
 * @param lifecycleId - Subagent/task identifier for lifecycle payloads
 * @param events - Optional event bus for lifecycle hooks
 * @returns Effective cwd and optional isolation context
 */
function provisionIsolation(
	baseCwd: string,
	requestedIsolation: IsolationMode | undefined,
	agent: AgentConfig,
	defaults: AgentDefaults | undefined,
	lifecycleScope: WorktreeLifecycleScope,
	lifecycleId: string,
	events?: ExtensionAPI["events"]
): {
	readonly isolation: SubagentIsolationContext | undefined;
	readonly workingDirectory: string;
} {
	const isolationMode = resolveEffectiveIsolation(
		requestedIsolation,
		agent.isolation,
		defaults?.isolation
	);
	if (isolationMode !== "worktree") {
		return { isolation: undefined, workingDirectory: baseCwd };
	}

	const repoRoot = validateGitRepo(baseCwd).repoRoot;
	const created = createWorktree(repoRoot, {
		agentId: lifecycleScope === "subagent" ? lifecycleId : undefined,
		id: lifecycleId,
		scope: "subagent",
	});
	const isolation: SubagentIsolationContext = {
		mode: "worktree",
		repoRoot,
		worktreePath: created.worktreePath,
	};

	if (events) {
		emitWorktreeLifecycleEvent(events, "worktree_create", {
			agentId: lifecycleScope === "subagent" ? lifecycleId : undefined,
			repoRoot,
			scope: lifecycleScope,
			timestamp: Date.now(),
			worktreePath: created.worktreePath,
		});
	}

	return {
		isolation,
		workingDirectory: created.worktreePath,
	};
}

/**
 * Cleanup worktree isolation for one subagent invocation.
 *
 * @param lifecycleScope - Lifecycle scope for emitted events
 * @param lifecycleId - Subagent/task identifier
 * @param isolation - Isolation context to cleanup
 * @param events - Optional event bus for lifecycle hooks
 */
function cleanupIsolation(
	lifecycleScope: WorktreeLifecycleScope,
	lifecycleId: string,
	isolation: SubagentIsolationContext | undefined,
	events?: ExtensionAPI["events"]
): void {
	if (!isolation) return;
	removeWorktree(isolation.worktreePath);
	if (!events) return;
	emitWorktreeLifecycleEvent(events, "worktree_remove", {
		agentId: lifecycleScope === "subagent" ? lifecycleId : undefined,
		repoRoot: isolation.repoRoot,
		scope: lifecycleScope,
		timestamp: Date.now(),
		worktreePath: isolation.worktreePath,
	});
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

/** Liveness watchdog thresholds for foreground subagent workers. */
export interface ForegroundWatchdogThresholds {
	readonly inactivityTimeoutMs: number;
	readonly killGraceMs: number;
	readonly startupTimeoutMs: number;
}

/** Heartbeat state tracked by the foreground subagent liveness watchdog. */
export interface WatchdogHeartbeatState {
	readonly lastHeartbeatAtMs: number | null;
	readonly startedAtMs: number;
}

/** Liveness watchdog status for a foreground subagent worker. */
export type WatchdogStatus =
	| { readonly kind: "healthy" }
	| {
			readonly elapsedMs: number;
			readonly kind: "stalled";
			readonly phase: "inactivity" | "startup";
			readonly timeoutMs: number;
	  };

/** Default watchdog thresholds used by foreground subagents in runSingleAgent. */
export const FOREGROUND_WATCHDOG_THRESHOLDS: ForegroundWatchdogThresholds = {
	inactivityTimeoutMs: 90_000,
	killGraceMs: 5_000,
	startupTimeoutMs: 30_000,
};

/** How often the foreground watchdog checks for stalled subagents. */
const FOREGROUND_WATCHDOG_CHECK_INTERVAL_MS = 500;

/**
 * Create initial watchdog heartbeat state.
 * @param nowMs - Current wall-clock timestamp in milliseconds
 * @returns Initial heartbeat state with no heartbeat yet
 */
export function createWatchdogHeartbeatState(nowMs: number): WatchdogHeartbeatState {
	return {
		lastHeartbeatAtMs: null,
		startedAtMs: nowMs,
	};
}

/**
 * Record a watchdog heartbeat timestamp.
 * @param state - Existing watchdog heartbeat state
 * @param nowMs - Current wall-clock timestamp in milliseconds
 * @returns Updated heartbeat state
 */
export function recordWatchdogHeartbeat(
	state: WatchdogHeartbeatState,
	nowMs: number
): WatchdogHeartbeatState {
	return {
		...state,
		lastHeartbeatAtMs: nowMs,
	};
}

/**
 * Evaluate current liveness state against watchdog thresholds.
 * @param state - Current heartbeat state
 * @param nowMs - Current wall-clock timestamp in milliseconds
 * @param thresholds - Timeout thresholds for startup/inactivity checks
 * @returns Healthy or stalled watchdog status
 */
export function evaluateWatchdogStatus(
	state: WatchdogHeartbeatState,
	nowMs: number,
	thresholds: ForegroundWatchdogThresholds
): WatchdogStatus {
	if (state.lastHeartbeatAtMs === null) {
		const startupElapsedMs = nowMs - state.startedAtMs;
		if (startupElapsedMs >= thresholds.startupTimeoutMs) {
			return {
				elapsedMs: startupElapsedMs,
				kind: "stalled",
				phase: "startup",
				timeoutMs: thresholds.startupTimeoutMs,
			};
		}
		return { kind: "healthy" };
	}

	const inactivityElapsedMs = nowMs - state.lastHeartbeatAtMs;
	if (inactivityElapsedMs >= thresholds.inactivityTimeoutMs) {
		return {
			elapsedMs: inactivityElapsedMs,
			kind: "stalled",
			phase: "inactivity",
			timeoutMs: thresholds.inactivityTimeoutMs,
		};
	}
	return { kind: "healthy" };
}

/**
 * Build a clear actionable error for stalled foreground subagents.
 * @param stalledStatus - The stalled watchdog classification
 * @returns User-facing error message with remediation guidance
 */
export function createStalledSubagentErrorMessage(
	stalledStatus: Extract<WatchdogStatus, { kind: "stalled" }>
): string {
	const timeoutSeconds = Math.max(1, Math.round(stalledStatus.timeoutMs / 1000));
	const phaseDescription =
		stalledStatus.phase === "startup"
			? "no startup heartbeat was received"
			: `no heartbeat was received for ${timeoutSeconds}s`;
	return `Subagent stalled (${phaseDescription}). Likely deadlock: waiting for an interactive confirmation path unavailable in subagent JSON mode. Action: avoid confirmation-gated steps, pre-authorize required tools, or run this step in the parent agent.`;
}

/**
 * Mark a subagent result as stalled with consistent diagnostics.
 * @param result - Mutable execution result object to annotate
 * @param stalledStatus - Watchdog stalled classification details
 * @returns Nothing
 */
export function applyStalledClassification(
	result: SingleResult,
	stalledStatus: Extract<WatchdogStatus, { kind: "stalled" }>
): void {
	const watchdogNote = `[Watchdog: ${stalledStatus.phase} timeout after ${stalledStatus.timeoutMs}ms]`;
	result.errorMessage = createStalledSubagentErrorMessage(stalledStatus);
	result.stderr = result.stderr ? `${result.stderr}\n${watchdogNote}` : watchdogNote;
	result.stopReason = "stalled";
}

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerClearFn = (timer: TimerHandle) => void;
type TimerSetFn = (callback: () => void, delayMs: number) => TimerHandle;

/** Minimal process contract needed for deterministic termination escalation. */
export interface KillableProcess {
	exitCode: number | null;
	kill(signal?: NodeJS.Signals): boolean;
}

/** Configuration for graceful process termination with SIGKILL fallback. */
export interface GracefulTerminationOptions {
	readonly clearTimeoutFn?: TimerClearFn;
	readonly killGraceMs: number;
	readonly onForceResolve: () => void;
	readonly setTimeoutFn?: TimerSetFn;
}

/** Cancellation handle for graceful termination escalation timers. */
export interface GracefulTerminationHandle {
	cancel: () => void;
}

/**
 * Request process termination with deterministic SIGTERM → SIGKILL escalation.
 * @param proc - Child process handle
 * @param options - Termination and timer options
 * @returns Handle to cancel pending escalation timer
 */
export function terminateProcessWithGrace(
	proc: KillableProcess,
	options: GracefulTerminationOptions
): GracefulTerminationHandle {
	const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
	const setTimeoutFn = options.setTimeoutFn ?? setTimeout;

	proc.kill("SIGTERM");
	const killTimer = setTimeoutFn(() => {
		if (proc.exitCode !== null) return;
		proc.kill("SIGKILL");
		options.onForceResolve();
	}, options.killGraceMs);

	let cancelled = false;
	return {
		cancel: () => {
			if (cancelled) return;
			cancelled = true;
			clearTimeoutFn(killTimer);
		},
	};
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
 * @param isolationOverride - Optional per-call isolation override
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
	hints?: RoutingHints,
	isolationOverride?: IsolationMode
): Promise<string | null> {
	const resolved = resolveAgentForExecution(agentName, agents, defaults);
	const id = `bg_${generateId()}`;
	const requestedCwd = cwd ?? defaultCwd;

	// Route model via fuzzy resolution + auto-routing.
	const routing = await routeModel(
		task,
		modelOverride,
		resolved.agent.model,
		parentModelId,
		resolved.agent.description,
		hints,
		requestedCwd
	);
	if (!routing.ok) return routing.error;

	let isolationContext: SubagentIsolationContext | undefined;
	let effectiveCwd = requestedCwd;
	try {
		const provisioned = provisionIsolation(
			requestedCwd,
			isolationOverride,
			resolved.agent,
			defaults,
			"subagent",
			id,
			piEvents
		);
		isolationContext = provisioned.isolation;
		effectiveCwd = provisioned.workingDirectory;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `Failed to create worktree isolation for ${agentName}: ${reason}`;
	}

	const agent = { ...resolved.agent, model: routing.model.id };
	const agentSource = resolved.resolution === "ephemeral" ? ("ephemeral" as const) : agent.source;

	const args: string[] = session
		? ["--mode", "json", "-p", "--session", session]
		: ["--mode", "json", "-p", "--no-session"];
	// Use provider-qualified name (e.g. "openai-codex/gpt-5.1") so the child process
	// resolves to the exact provider the router selected, not just the first match.
	if (agent.model) args.push("--models", routing.model.displayName);
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

	let expandedTask: string;
	try {
		expandedTask = await expandFileReferences(task, effectiveCwd);
	} catch (error) {
		cleanupIsolation("subagent", id, isolationContext, piEvents);
		const reason = error instanceof Error ? error.message : String(error);
		return `Failed to expand task references for ${agentName}: ${reason}`;
	}
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

	let proc: ReturnType<typeof spawn>;
	try {
		proc = spawn("pi", args, {
			cwd: effectiveCwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnv,
		});
	} catch (error) {
		cleanupIsolation("subagent", id, isolationContext, piEvents);
		const reason = error instanceof Error ? error.message : String(error);
		return `Failed to spawn background subagent ${agentName}: ${reason}`;
	}

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
		isolationMode: isolationContext?.mode,
		model: agent.model,
		task,
		startTime: Date.now(),
		process: proc,
		result,
		status: "running",
		tmpPromptDir,
		tmpPromptPath,
		worktreePath: isolationContext?.worktreePath,
	};

	backgroundSubagents.set(id, bgSubagent);
	publishSubagentSnapshot(piEvents);
	startBackgroundSubagentCleanupLoop(piEvents);

	let isolationCleaned = false;
	const cleanupBackgroundIsolation = () => {
		if (isolationCleaned) return;
		isolationCleaned = true;
		cleanupIsolation("subagent", id, isolationContext, piEvents);
	};

	if (!proc.stdout || !proc.stderr) {
		cleanupBackgroundIsolation();
		return `Failed to spawn background subagent ${agentName}: missing stdio pipes`;
	}

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

	proc.on("error", (error) => {
		result.stderr += error.message;
		cleanupBackgroundIsolation();
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
		const finalOutput = getFinalOutput(result.messages);
		result.exitCode = code ?? 0;
		bgSubagent.completedAt = Date.now();
		bgSubagent.status = code === 0 ? "completed" : "failed";
		applyBackgroundResultRetention(bgSubagent);
		publishSubagentSnapshot(piEvents);
		startBackgroundSubagentCleanupLoop(piEvents);

		// Emit subagent_stop event
		piEvents?.emit("subagent_stop", {
			agent_id: id,
			agent_type: agentName,
			task,
			exit_code: code ?? 0,
			result: finalOutput,
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

		cleanupBackgroundIsolation();
		updateWidget();

		// Post inline result for background subagent completion
		if (_piRef && isInlineResultsEnabled()) {
			const duration = formatDuration(Date.now() - bgSubagent.startTime);
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
 * @param isolationOverride - Optional per-call isolation override
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
	hints?: RoutingHints,
	isolationOverride?: IsolationMode
): Promise<SingleResult> {
	const resolved = resolveAgentForExecution(agentName, agents, defaults);
	const requestedCwd = cwd ?? defaultCwd;
	// Route model via fuzzy resolution + auto-routing
	const routing = await routeModel(
		task,
		modelOverride,
		resolved.agent.model,
		parentModelId,
		resolved.agent.description,
		hints,
		requestedCwd
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

	let isolationContext: SubagentIsolationContext | undefined;
	let effectiveCwd = requestedCwd;
	try {
		const provisioned = provisionIsolation(
			requestedCwd,
			isolationOverride,
			agent,
			defaults,
			"subagent",
			taskId,
			piEvents
		);
		isolationContext = provisioned.isolation;
		effectiveCwd = provisioned.workingDirectory;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			agent: agentName,
			agentSource,
			task,
			exitCode: 1,
			messages: [],
			stderr: message,
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
			errorMessage: message,
			step,
		};
	}

	registerForegroundSubagent(
		taskId,
		agentName,
		task,
		Date.now(),
		piEvents,
		agent.model,
		isolationContext?.mode
	);

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
	// Use provider-qualified name so the child process resolves to the exact provider.
	if (agent.model) args.push("--models", routing.model.displayName);
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

	// Surface selected model immediately, before first assistant/tool event arrives.
	emitUpdate(true);

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
				cwd: effectiveCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: fgChildEnv,
			});

			let abortListener: (() => void) | null = null;
			let buffer = "";
			let heartbeatState = createWatchdogHeartbeatState(Date.now());
			let isResolved = false;
			let stopHandle: GracefulTerminationHandle | null = null;
			let stopRequested = false;
			let watchdogInterval: ReturnType<typeof setInterval> | null = null;

			const cleanupProcessLifecycle = () => {
				if (watchdogInterval) {
					clearInterval(watchdogInterval);
					watchdogInterval = null;
				}
				if (stopHandle) {
					stopHandle.cancel();
					stopHandle = null;
				}
				if (signal && abortListener) {
					signal.removeEventListener("abort", abortListener);
					abortListener = null;
				}
			};

			const settle = (code: number) => {
				if (isResolved) return;
				isResolved = true;
				cleanupProcessLifecycle();
				resolve(code);
			};

			const requestWorkerStop = (_reason: "abort" | "max_turns" | "stalled") => {
				if (stopRequested) return;
				stopRequested = true;
				stopHandle = terminateProcessWithGrace(proc, {
					killGraceMs: FOREGROUND_WATCHDOG_THRESHOLDS.killGraceMs,
					onForceResolve: () => {
						settle(1);
					},
				});
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				// biome-ignore lint/suspicious/noExplicitAny: pi subagent JSON protocol has dynamic shape
				let event: Record<string, any>;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (
					event.type === "message_end" ||
					event.type === "tool_call_start" ||
					event.type === "tool_result_end"
				) {
					heartbeatState = recordWatchdogHeartbeat(heartbeatState, Date.now());
				}

				// Emit subagent_tool_call when tool starts
				if (event.type === "tool_call_start") {
					fgTurnCount++;
					// Hard enforcement: kill after maxTurns tool calls
					if (agent.maxTurns && fgTurnCount >= agent.maxTurns) {
						requestWorkerStop("max_turns");
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
						if (msg.stopReason && currentResult.stopReason !== "stalled") {
							currentResult.stopReason = msg.stopReason;
						}
						if (msg.errorMessage && currentResult.stopReason !== "stalled") {
							currentResult.errorMessage = msg.errorMessage;
						}
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

			watchdogInterval = setInterval(() => {
				if (isResolved || stopRequested) return;
				const status = evaluateWatchdogStatus(
					heartbeatState,
					Date.now(),
					FOREGROUND_WATCHDOG_THRESHOLDS
				);
				if (status.kind !== "stalled") return;
				applyStalledClassification(currentResult, status);
				setForegroundSubagentStatus(taskId, "stalled", piEvents);
				emitUpdate(true);
				requestWorkerStop("stalled");
			}, FOREGROUND_WATCHDOG_CHECK_INTERVAL_MS);

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code, closeSignal) => {
				if (buffer.trim()) processLine(buffer);
				if (code !== null) {
					settle(code);
					return;
				}
				if (closeSignal) {
					settle(1);
					return;
				}
				settle(0);
			});

			proc.on("error", () => {
				settle(1);
			});

			if (signal) {
				abortListener = () => {
					wasAborted = true;
					requestWorkerStop("abort");
				};
				if (signal.aborted) abortListener();
				else signal.addEventListener("abort", abortListener, { once: true });
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
				effectiveCwd,
				step,
				signal,
				onUpdate,
				makeDetails,
				piEvents,
				session,
				nextModel.id,
				parentModelId,
				defaults,
				undefined,
				undefined
				// Clear hints and isolation override — explicit model + existing cwd are used
			);
		}

		return currentResult;
	} finally {
		completeForegroundSubagent(taskId, piEvents);
		cleanupTempFiles();
		cleanupIsolation("subagent", taskId, isolationContext, piEvents);
	}
}
