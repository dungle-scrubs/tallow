/**
 * Deterministic fuzzy model resolution for subagents.
 *
 * We keep a local implementation instead of delegating straight to synapse
 * because the direct dependency path was flaky under Linux CI in this repo.
 * The behavior mirrors synapse's public resolver cascade closely enough for
 * runtime callers and keeps tests deterministic across platforms.
 *
 * @module
 */

import type { CandidateModel, ModelSource, ResolvedModel } from "@dungle-scrubs/synapse";
import { getModels, getProviders } from "@mariozechner/pi-ai";

export type { ModelSource, ResolvedModel };

/**
 * Collect all models from the registered pi-ai providers.
 *
 * @returns Flat list of candidate models
 */
function getAllModels(): CandidateModel[] {
	const result: CandidateModel[] = [];
	for (const provider of getProviders()) {
		for (const model of getModels(provider)) {
			result.push({ provider: model.provider, id: model.id, name: model.name });
		}
	}
	return result;
}

/**
 * Convert a candidate model into the resolved public shape.
 *
 * @param model - Candidate model
 * @returns Resolved model descriptor
 */
function toResolved(model: CandidateModel): ResolvedModel {
	return {
		displayName: `${model.provider}/${model.id}`,
		id: model.id,
		provider: model.provider,
	};
}

/**
 * Tokenize a query or model identifier for overlap matching.
 *
 * @param value - Raw query or identifier
 * @returns Lowercase tokens split on separators and digit boundaries
 */
function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.replace(/([a-z])(\d)/g, "$1 $2")
		.replace(/(\d)([a-z])/g, "$1 $2")
		.split(/[\s\-_.]+/)
		.filter((token) => token.length > 0);
}

/**
 * Normalize a query or identifier by removing separators.
 *
 * @param value - Raw query or identifier
 * @returns Lowercase normalized string
 */
function normalize(value: string): string {
	return value.toLowerCase().replace(/[\s\-_.]+/g, "");
}

/**
 * Compare model IDs using numeric-aware sorting.
 *
 * @param a - First model ID
 * @param b - Second model ID
 * @returns Positive when a is newer/higher than b
 */
function compareModelIds(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Build a provider-priority lookup map.
 *
 * @param preferredProviders - Ordered provider preference list
 * @returns Provider -> priority map (lower is better)
 */
function buildProviderPreferenceMap(
	preferredProviders: readonly string[] | undefined
): ReadonlyMap<string, number> {
	const priorities = new Map<string, number>();
	for (const [index, provider] of (preferredProviders ?? []).entries()) {
		priorities.set(provider.toLowerCase(), index);
	}
	return priorities;
}

/**
 * Resolve one provider's priority, defaulting unknown providers last.
 *
 * @param preferenceMap - Provider priority map
 * @param provider - Provider to score
 * @returns Numeric priority (lower is better)
 */
function getProviderPriority(preferenceMap: ReadonlyMap<string, number>, provider: string): number {
	return preferenceMap.get(provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Pick the best candidate by ID quality only.
 *
 * Tiebreak order:
 * 1. Higher numeric-aware model ID
 * 2. Shorter ID when numeric ordering ties
 * 3. Lexicographically last as deterministic fallback
 *
 * @param models - Candidate models
 * @returns Best candidate
 */
function pickBestModel(models: readonly CandidateModel[]): CandidateModel {
	return models.reduce((best, current) => {
		const versionDiff = compareModelIds(best.id, current.id);
		if (versionDiff !== 0) {
			return versionDiff > 0 ? best : current;
		}
		if (best.id.length !== current.id.length) {
			return best.id.length < current.id.length ? best : current;
		}
		return best.id >= current.id ? best : current;
	});
}

/**
 * Pick the best final candidate, optionally preferring specific providers.
 *
 * @param models - Candidate models
 * @param preferredProviders - Ordered provider preference list
 * @returns Best candidate
 */
function pickBest(
	models: readonly CandidateModel[],
	preferredProviders?: readonly string[]
): CandidateModel {
	const bestModel = pickBestModel(models);
	if (!preferredProviders || preferredProviders.length === 0) {
		return bestModel;
	}

	const sameModel = models.filter((model) => model.id === bestModel.id);
	if (sameModel.length <= 1) {
		return bestModel;
	}

	const preferenceMap = buildProviderPreferenceMap(preferredProviders);
	return sameModel.reduce((best, current) => {
		return getProviderPriority(preferenceMap, best.provider) <=
			getProviderPriority(preferenceMap, current.provider)
			? best
			: current;
	});
}

/**
 * Find all candidates that tie at the best score for the first matching tier.
 *
 * Resolution cascade:
 * 1. Exact ID match
 * 2. Case-insensitive ID match
 * 3. Normalized ID match (strips separators)
 * 4. Provider/ID exact match
 * 5. Token overlap scoring
 * 6. Raw substring match
 * 7. Normalized substring match
 *
 * @param query - Human-friendly query
 * @param modelSource - Optional injected model source
 * @returns Tied candidates from the first matching tier
 */
function findCandidates(query: string, modelSource?: ModelSource): CandidateModel[] {
	const models = modelSource ? modelSource() : getAllModels();
	if (models.length === 0) return [];

	const trimmed = query.trim();
	if (trimmed.length === 0) return [];

	const lower = trimmed.toLowerCase();
	const normalized = normalize(trimmed);

	const exact = models.filter((model) => model.id === trimmed);
	if (exact.length > 0) return exact;

	const caseInsensitive = models.filter((model) => model.id.toLowerCase() === lower);
	if (caseInsensitive.length > 0) return caseInsensitive;

	const normalizedId = models.filter((model) => normalize(model.id) === normalized);
	if (normalizedId.length > 0) return normalizedId;

	if (trimmed.includes("/")) {
		const slashIndex = trimmed.indexOf("/");
		const provider = trimmed.slice(0, slashIndex).toLowerCase();
		const id = trimmed.slice(slashIndex + 1).toLowerCase();
		const providerMatch = models.filter(
			(model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id
		);
		if (providerMatch.length > 0) return providerMatch;
	}

	const queryTokens = tokenize(trimmed);
	if (queryTokens.length > 0) {
		let bestScore = 0;
		let bestMatches: CandidateModel[] = [];
		for (const model of models) {
			const idName = `${model.id} ${model.name}`.toLowerCase();
			const providerText = model.provider.toLowerCase();
			let score = 0;
			for (const token of queryTokens) {
				if (idName.includes(token)) score += 2;
				else if (providerText.includes(token)) score += 1;
			}
			if (score > bestScore) {
				bestScore = score;
				bestMatches = [model];
			} else if (score === bestScore && score > 0) {
				bestMatches.push(model);
			}
		}
		if (bestMatches.length > 0) return bestMatches;
	}

	const substring = models.filter(
		(model) => model.id.toLowerCase().includes(lower) || model.name.toLowerCase().includes(lower)
	);
	if (substring.length > 0) return substring;

	return models.filter(
		(model) =>
			normalize(model.id).includes(normalized) || normalize(model.name).includes(normalized)
	);
}

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
	const candidates = findCandidates(query, modelSource);
	if (candidates.length === 0) return undefined;
	return toResolved(pickBest(candidates, preferredProviders));
}

/**
 * Resolve a fuzzy model query to all tied candidates.
 *
 * @param query - Human-friendly model query
 * @param modelSource - Optional injected model source for deterministic tests
 * @returns Candidate matches
 */
export function resolveModelCandidates(query: string, modelSource?: ModelSource): ResolvedModel[] {
	return findCandidates(query, modelSource).map(toResolved);
}

/**
 * List available provider/model identifiers.
 *
 * @param modelSource - Optional injected model source for deterministic tests
 * @returns Provider/model identifier strings
 */
export function listAvailableModels(modelSource?: ModelSource): string[] {
	const models = modelSource ? modelSource() : getAllModels();
	return models.map((model) => `${model.provider}/${model.id}`);
}
