/**
 * Fuzzy model name resolution — re-exports from synapse.
 *
 * @module
 */

export type { ModelSource, ResolvedModel } from "@dungle-scrubs/synapse";
export {
	listAvailableModels,
	resolveModelCandidates,
	resolveModelFuzzy,
} from "@dungle-scrubs/synapse";
