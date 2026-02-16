/**
 * Fuzzy model name resolution against the pi framework's model registry.
 * Resolves human-friendly names like "opus", "sonnet 4.5" to exact provider/model-id pairs.
 */

import { getModels, getProviders } from "@mariozechner/pi-ai";

export interface ResolvedModel {
	provider: string;
	id: string;
	displayName: string;
}

interface CandidateModel {
	provider: string;
	id: string;
	name: string;
}

/**
 * Collects all models from every registered provider.
 * @returns Flat array of candidate models with provider, id, and name
 */
function getAllModels(): CandidateModel[] {
	const result: CandidateModel[] = [];
	for (const provider of getProviders()) {
		for (const m of getModels(provider)) {
			result.push({ provider: m.provider, id: m.id, name: m.name });
		}
	}
	return result;
}

/** Model-fetching function signature for dependency injection. */
export type ModelSource = () => CandidateModel[];

/**
 * Builds a ResolvedModel from a candidate.
 * @param m - Candidate model
 * @returns ResolvedModel with display name
 */
function toResolved(m: CandidateModel): ResolvedModel {
	return { provider: m.provider, id: m.id, displayName: `${m.provider}/${m.id}` };
}

/**
 * Picks the candidate with the shorter model ID (tiebreak heuristic).
 * @param models - Array of candidates to pick from
 * @returns The candidate with the shortest ID
 */
function shortest(models: CandidateModel[]): CandidateModel {
	return models.reduce((a, b) => (a.id.length <= b.id.length ? a : b));
}

/**
 * Splits a string into lowercase tokens on spaces, hyphens, underscores, and dots.
 * @param s - Input string
 * @returns Array of non-empty lowercase tokens
 */
function tokenize(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[\s\-_.]+/)
		.filter((t) => t.length > 0);
}

/**
 * Strips all common separators and lowercases for normalized comparison.
 * "glm-5" → "glm5", "claude-sonnet-4-5" → "claudesonnet45"
 * @param s - Input string
 * @returns Normalized string with separators removed
 */
function normalize(s: string): string {
	return s.toLowerCase().replace(/[\s\-_.]+/g, "");
}

/**
 * Resolves a human-friendly model name to an exact provider/model-id.
 *
 * Resolution cascade:
 * 1. Exact ID match across all providers
 * 2. Case-insensitive ID match
 * 2.5. Normalized match — strips separators ("glm5" → "glm-5")
 * 3. Provider/ID format (e.g. "anthropic/claude-sonnet-4-5")
 * 4. Token overlap — split query into tokens, score models by how many
 *    tokens appear in provider + id + name. Best score wins. Tiebreak: shorter ID.
 * 5. Substring match — query appears as substring in model ID or name
 * 6. Normalized substring — strips separators before substring comparison
 *
 * @param query - Human-friendly model name (e.g. "opus", "sonnet 4.5", "claude-opus-4-5")
 * @param modelSource - Optional model-fetching function (defaults to pi-ai registry)
 * @returns Resolved model, or undefined if no match found
 */
export function resolveModelFuzzy(
	query: string,
	modelSource?: ModelSource
): ResolvedModel | undefined {
	const models = modelSource ? modelSource() : getAllModels();
	if (models.length === 0) return undefined;

	const q = query.trim();
	if (q.length === 0) return undefined;
	const qLower = q.toLowerCase();

	// 1. Exact ID match
	const exact = models.filter((m) => m.id === q);
	if (exact.length > 0) return toResolved(shortest(exact));

	// 2. Case-insensitive ID match
	const ciMatch = models.filter((m) => m.id.toLowerCase() === qLower);
	if (ciMatch.length > 0) return toResolved(shortest(ciMatch));

	// 2.5. Normalized match — strips separators ("glm5" matches "glm-5")
	const qNorm = normalize(q);
	const normMatch = models.filter((m) => normalize(m.id) === qNorm);
	if (normMatch.length > 0) return toResolved(shortest(normMatch));

	// 3. Provider/ID format
	if (q.includes("/")) {
		const slashIdx = q.indexOf("/");
		const provider = q.slice(0, slashIdx).toLowerCase();
		const id = q.slice(slashIdx + 1).toLowerCase();
		const providerMatch = models.filter(
			(m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id
		);
		if (providerMatch.length > 0) return toResolved(shortest(providerMatch));
	}

	// 4. Token overlap scoring
	const queryTokens = tokenize(q);
	if (queryTokens.length > 0) {
		let bestScore = 0;
		let bestMatches: CandidateModel[] = [];

		for (const m of models) {
			const haystack = `${m.provider} ${m.id} ${m.name}`.toLowerCase();
			const score = queryTokens.filter((t) => haystack.includes(t)).length;
			if (score > bestScore) {
				bestScore = score;
				bestMatches = [m];
			} else if (score === bestScore && score > 0) {
				bestMatches.push(m);
			}
		}

		if (bestScore > 0 && bestMatches.length > 0) {
			return toResolved(shortest(bestMatches));
		}
	}

	// 5. Substring match (raw)
	const subMatches = models.filter(
		(m) => m.id.toLowerCase().includes(qLower) || m.name.toLowerCase().includes(qLower)
	);
	if (subMatches.length > 0) return toResolved(shortest(subMatches));

	// 6. Substring match (normalized — strips separators before comparing)
	const normSubMatches = models.filter(
		(m) => normalize(m.id).includes(qNorm) || normalize(m.name).includes(qNorm)
	);
	if (normSubMatches.length > 0) return toResolved(shortest(normSubMatches));

	return undefined;
}

/**
 * Lists all available models from the registry for error messages.
 * @param modelSource - Optional model-fetching function (defaults to pi-ai registry)
 * @returns Array of model display strings ("provider/id")
 */
export function listAvailableModels(modelSource?: ModelSource): string[] {
	const models = modelSource ? modelSource() : getAllModels();
	return models.map((m) => `${m.provider}/${m.id}`);
}
