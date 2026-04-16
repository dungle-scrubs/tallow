/**
 * Fuzzy model name resolution — thin wrappers around synapse.
 *
 * Re-exporting the resolver functions directly was flaky under CI/Bun in this
 * repo, so keep explicit wrappers here to preserve deterministic argument
 * forwarding for tests and runtime callers.
 *
 * @module
 */

import {
	type ModelSource,
	type ResolvedModel,
	listAvailableModels as synapseListAvailableModels,
	resolveModelCandidates as synapseResolveModelCandidates,
	resolveModelFuzzy as synapseResolveModelFuzzy,
} from "@dungle-scrubs/synapse";

export type { ModelSource, ResolvedModel };

/**
 * Resolve a fuzzy model query to one best match.
 *
 * @param query - Human-friendly model query
 * @param modelSource - Optional injected model source for deterministic tests
 * @param preferredProviders - Optional provider preference ordering
 * @returns Best matching model or undefined
 */
export function resolveModelFuzzy(
	query: string,
	modelSource?: ModelSource,
	preferredProviders?: string[]
): ResolvedModel | undefined {
	return synapseResolveModelFuzzy(query, modelSource, preferredProviders);
}

/**
 * Resolve a fuzzy model query to all tied candidates.
 *
 * @param query - Human-friendly model query
 * @param modelSource - Optional injected model source for deterministic tests
 * @returns Candidate matches
 */
export function resolveModelCandidates(query: string, modelSource?: ModelSource): ResolvedModel[] {
	return synapseResolveModelCandidates(query, modelSource);
}

/**
 * List available provider/model identifiers.
 *
 * @param modelSource - Optional injected model source for deterministic tests
 * @returns Provider/model identifier strings
 */
export function listAvailableModels(modelSource?: ModelSource): string[] {
	return synapseListAvailableModels(modelSource);
}
