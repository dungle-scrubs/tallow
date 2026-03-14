import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const agentRunnerModule = (await import(
	resolveRuntimeModuleUrl("agent-runner.js")
)) as typeof import("../src/agent-runner.js");

export type AgentRunnerCandidate = import("../src/agent-runner.js").AgentRunnerCandidate;
export type AgentRunnerResolutionOptions =
	import("../src/agent-runner.js").AgentRunnerResolutionOptions;
export type AgentRunnerSpawn = import("../src/agent-runner.js").AgentRunnerSpawn;
export type SpawnAgentRunnerFailure = import("../src/agent-runner.js").SpawnAgentRunnerFailure;
export type SpawnAgentRunnerOptions = import("../src/agent-runner.js").SpawnAgentRunnerOptions;
export type SpawnAgentRunnerResult = import("../src/agent-runner.js").SpawnAgentRunnerResult;
export type SpawnAgentRunnerSuccess = import("../src/agent-runner.js").SpawnAgentRunnerSuccess;

export const DEFAULT_AGENT_RUNNER_ENV = agentRunnerModule.DEFAULT_AGENT_RUNNER_ENV;
export const formatMissingAgentRunnerError = agentRunnerModule.formatMissingAgentRunnerError;
export const formatMissingRunnerError = agentRunnerModule.formatMissingRunnerError;
export const resolveAgentRunnerCandidates = agentRunnerModule.resolveAgentRunnerCandidates;
export const spawnWithResolvedAgentRunner = agentRunnerModule.spawnWithResolvedAgentRunner;
