/**
 * TypeBox parameter schemas and event type definitions for the subagent tool.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

// ── Parameter Schemas ────────────────────────────────────────────────────────

export const IsolationModeSchema = StringEnum(["worktree"] as const, {
	description:
		'Isolation strategy for subagent execution. "worktree" runs the subagent in a temporary detached git worktree.',
});

/** Isolation mode supported by the subagent tool. */
export type IsolationMode = "worktree";

export const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(
		Type.String({ description: "Model ID to use for this agent (overrides agent default)" })
	),
	isolation: Type.Optional(IsolationModeSchema),
});

export const CentipedeItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(
		Type.String({ description: "Model ID to use for this step (overrides agent default)" })
	),
	isolation: Type.Optional(IsolationModeSchema),
});

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Name of the agent to invoke (for single mode)" })
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })
	),
	centipede: Type.Optional(
		Type.Array(CentipedeItem, {
			description: "Array of {agent, task} for sequential execution",
		})
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description:
				"Deprecated — project-local agents now run without confirmation. " +
				"Kept for backward compatibility; ignored at runtime.",
			default: true,
		})
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process (single mode)" })
	),
	isolation: Type.Optional(IsolationModeSchema),
	background: Type.Optional(
		Type.Boolean({
			description: "Run in background, return immediately. Use subagent_status to check.",
			default: false,
		})
	),
	session: Type.Optional(
		Type.String({
			description:
				"Session file path for persistent teammates. Creates or continues a session. " +
				"On first call, creates the session file. On subsequent calls, resumes the conversation " +
				"with full history. Use for long-lived agents that need multiple interactions.",
		})
	),
	model: Type.Optional(
		Type.String({ description: "Model ID to use (overrides agent default). For single mode." })
	),
	costPreference: Type.Optional(
		StringEnum(["eco", "balanced", "premium"] as const, {
			description:
				'Cost preference for auto-routing. "eco" = cheapest capable model, ' +
				'"balanced" = best fit for task complexity, "premium" = most capable. ' +
				"Only used when no explicit model is specified.",
		})
	),
	taskType: Type.Optional(
		StringEnum(["code", "vision", "text"] as const, {
			description:
				"Override the auto-detected task type. " +
				'"code" for coding tasks, "vision" for image analysis, "text" for docs/planning.',
		})
	),
	complexity: Type.Optional(
		Type.Number({
			description:
				"Override the auto-detected task complexity (1-5). " +
				"1=trivial, 2=simple, 3=moderate, 4=complex, 5=expert.",
			minimum: 1,
			maximum: 5,
		})
	),
	modelScope: Type.Optional(
		Type.String({
			description:
				'Constrain auto-routing to a model family (e.g. "codex", "gemini", "opus"). ' +
				"The task is still classified and the best model within the family is selected " +
				"based on complexity and cost preference. No effect when explicit model is set.",
		})
	),
});

// ── Event Types ──────────────────────────────────────────────────────────────

/**
 * Subagent lifecycle events (aligned with Claude Code hook naming, snake_case)
 *
 * Listen in other extensions:
 *   pi.events.on("subagent_start", (data) => { ... });
 *   pi.events.on("subagent_stop", (data) => { ... });
 *   pi.events.on("subagent_tool_call", (data) => { ... });
 *   pi.events.on("subagent_tool_result", (data) => { ... });
 */
export interface SubagentStartEvent {
	agent_id: string;
	agent_type: string;
	task: string;
	cwd: string;
	background: boolean;
}

/** Event emitted when a subagent completes, for stop hooks to inspect. */
export interface SubagentStopEvent {
	agent_id: string;
	agent_type: string;
	task: string;
	exit_code: number;
	result: string;
	background: boolean;
}

/** Pi extension - not in Claude Code hooks */
export interface SubagentToolCallEvent {
	agent_id: string;
	agent_type: string;
	tool_name: string;
	tool_call_id: string;
	tool_input: Record<string, unknown>;
}

/** Pi extension - not in Claude Code hooks */
export interface SubagentToolResultEvent {
	agent_id: string;
	agent_type: string;
	tool_name: string;
	tool_call_id: string;
	is_error: boolean;
	/** Whether the error was a permission denial rather than an execution failure. */
	is_denied: boolean;
}

/** Details for inline subagent-complete messages. */
export interface SubagentCompleteDetails {
	readonly agentId: string;
	readonly agentName: string;
	readonly task: string;
	readonly exitCode: number;
	readonly duration: string;
	readonly preview: string[];
	readonly status: "completed" | "failed";
	readonly timestamp: number;
}
