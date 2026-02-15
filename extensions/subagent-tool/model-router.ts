/**
 * Model routing orchestrator.
 *
 * Loads routing config, runs the selection algorithm against the
 * capability matrix and provider cost data, and exposes the main
 * `routeModel` entry point consumed by the subagent tool.
 *
 * Supports per-call routing hints so the parent LLM can express
 * intent (cost preference, task type, complexity) without picking
 * a specific model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import type { ModelRatings, TaskType } from "./model-matrix.js";
import { getModelRatings } from "./model-matrix.js";
import type { ResolvedModel } from "./model-resolver.js";
import { listAvailableModels, resolveModelFuzzy } from "./model-resolver.js";
import type { ClassificationResult } from "./task-classifier.js";
import { classifyTask } from "./task-classifier.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** User's cost preference for model routing. */
export type CostPreference = "eco" | "balanced" | "premium";

/** Configuration for the routing engine (from settings.json). */
export interface RoutingConfig {
	/** Whether auto-routing is enabled. */
	enabled: boolean;
	/** Agent's default task type. */
	primaryType: TaskType;
	/** User's cost preference. */
	costPreference: CostPreference;
}

/**
 * Per-call routing hints from the parent LLM.
 *
 * These override the global settings and/or the classifier output
 * for a single subagent invocation.
 */
export interface RoutingHints {
	/** Cost preference — overrides global setting. */
	costPreference?: CostPreference;
	/** Task type — skips classifier's type detection. */
	taskType?: TaskType;
	/** Complexity (1-5) — skips classifier's complexity detection. */
	complexity?: number;
}

/** Result of the model routing decision. */
export type RoutingResult = RoutingSuccess | RoutingError;

/** Successful routing — a ranked list of candidate models. */
export interface RoutingSuccess {
	ok: true;
	/** The top-ranked model. */
	model: ResolvedModel;
	/** Fallback candidates in priority order (excludes the top pick). */
	fallbacks: ResolvedModel[];
	/** How the model was selected. */
	reason: "explicit" | "agent-frontmatter" | "auto-routed" | "fallback";
	/** Classification result if auto-routing was used. */
	classification?: ClassificationResult;
}

/** Failed routing — the user's explicit model couldn't be resolved. */
export interface RoutingError {
	ok: false;
	/** The model string that failed to resolve. */
	query: string;
	/** Human-readable error message. */
	error: string;
}

// ─── Settings ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RoutingConfig = {
	enabled: true,
	primaryType: "code",
	costPreference: "balanced",
};

const VALID_COST_PREFS = new Set<CostPreference>(["eco", "balanced", "premium"]);
const VALID_TASK_TYPES = new Set<TaskType>(["code", "vision", "text"]);

/**
 * Loads routing configuration from ~/.tallow/settings.json.
 *
 * Reads the `routing` key from settings. Falls back to defaults
 * for any missing fields.
 *
 * @returns Merged routing config
 */
export function loadRoutingConfig(): RoutingConfig {
	try {
		const settingsPath = path.join(os.homedir(), ".tallow", "settings.json");
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw);
		const routing = parsed?.routing;
		if (!routing || typeof routing !== "object") return { ...DEFAULT_CONFIG };

		return {
			enabled: typeof routing.enabled === "boolean" ? routing.enabled : DEFAULT_CONFIG.enabled,
			primaryType: VALID_TASK_TYPES.has(routing.primaryType)
				? routing.primaryType
				: DEFAULT_CONFIG.primaryType,
			costPreference: VALID_COST_PREFS.has(routing.costPreference)
				? routing.costPreference
				: DEFAULT_CONFIG.costPreference,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

// ─── Selection ───────────────────────────────────────────────────────────────

/** Model candidate with resolved identity and cost. */
interface ScoredCandidate {
	resolved: ResolvedModel;
	ratings: ModelRatings;
	effectiveCost: number;
}

/**
 * Enumerates all models from the registry with their ratings and costs.
 *
 * @returns Array of candidates that exist in the capability matrix
 */
function enumerateCandidates(): ScoredCandidate[] {
	const candidates: ScoredCandidate[] = [];
	for (const provider of getProviders()) {
		for (const model of getModels(provider)) {
			const ratings = getModelRatings(model.id);
			if (!ratings) continue;
			candidates.push({
				resolved: {
					provider: model.provider,
					id: model.id,
					displayName: `${model.provider}/${model.id}`,
				},
				ratings,
				effectiveCost: (model.cost.input + model.cost.output) / 2,
			});
		}
	}
	return candidates;
}

/**
 * Selects models for a classified task, ranked by preference.
 *
 * Algorithm:
 * 1. Enumerate all models from registry that have matrix ratings
 * 2. Filter: model has rating for classification.type
 * 3. Filter: rating[type] >= classification.complexity
 * 4. Sort by cost preference:
 *    - "eco": ascending by effective cost
 *    - "premium": descending by effective cost
 *    - "balanced": exact rating match first, then ascending cost
 * 5. Return ranked list (caller uses first, falls back to rest)
 *
 * @param classification - Task classification result
 * @param costPreference - Cost preference for sorting
 * @returns Ranked list of suitable models (may be empty)
 */
export function selectModels(
	classification: ClassificationResult,
	costPreference: CostPreference
): ResolvedModel[] {
	const { type, complexity } = classification;
	const candidates = enumerateCandidates().filter((c) => {
		const rating = c.ratings[type];
		return rating !== undefined && rating >= complexity;
	});

	if (candidates.length === 0) return [];

	candidates.sort((a, b) => {
		if (costPreference === "eco") {
			return a.effectiveCost - b.effectiveCost;
		}
		if (costPreference === "premium") {
			return b.effectiveCost - a.effectiveCost;
		}
		// "balanced": exact-match rating sorts first, then ascending cost
		const aExact = a.ratings[type] === complexity ? 0 : 1;
		const bExact = b.ratings[type] === complexity ? 0 : 1;
		if (aExact !== bExact) return aExact - bExact;
		return a.effectiveCost - b.effectiveCost;
	});

	return candidates.map((c) => c.resolved);
}

// ─── Routing ─────────────────────────────────────────────────────────────────

/**
 * Builds a fallback ResolvedModel from a parent model ID.
 *
 * @param parentModelId - Parent session's model ID
 * @returns Resolved model for fallback use
 */
function resolveFallback(parentModelId: string): ResolvedModel {
	const resolved = resolveModelFuzzy(parentModelId);
	if (resolved) return resolved;
	return { provider: "unknown", id: parentModelId, displayName: parentModelId };
}

/**
 * Route a subagent task to the best model(s).
 *
 * Decision flow:
 * 1. If modelOverride provided → fuzzy resolve it, return as "explicit"
 * 2. If agentModel provided (from frontmatter) → fuzzy resolve, return as "agent-frontmatter"
 * 3. If routing disabled → return parentModel as "fallback"
 * 4. Auto-route: classify task (or use per-call hints), select ranked
 *    candidates, return top pick + fallbacks as "auto-routed"
 * 5. If no candidates found → return parentModel as "fallback"
 *
 * Per-call hints override individual fields:
 * - hints.costPreference → overrides global costPreference
 * - hints.taskType → overrides classifier's type detection
 * - hints.complexity → overrides classifier's complexity detection
 *
 * @param task - Task description
 * @param modelOverride - Per-call explicit model (from params.model)
 * @param agentModel - Model from agent frontmatter
 * @param parentModelId - Parent session's model ID (inheritance fallback)
 * @param agentRole - Optional agent role for classifier context
 * @param hints - Optional per-call routing hints from parent LLM
 * @returns Routing result with model, fallbacks, and reason
 */
export async function routeModel(
	task: string,
	modelOverride?: string,
	agentModel?: string,
	parentModelId?: string,
	agentRole?: string,
	hints?: RoutingHints
): Promise<RoutingResult> {
	// 1. Explicit per-call model override — must resolve or error
	if (modelOverride) {
		const resolved = resolveModelFuzzy(modelOverride);
		if (resolved) return { ok: true, model: resolved, fallbacks: [], reason: "explicit" };
		const available = listAvailableModels().slice(0, 15).join(", ");
		return {
			ok: false,
			query: modelOverride,
			error: `Model "${modelOverride}" not found in registry. Available: ${available}`,
		};
	}

	// 2. Agent frontmatter model — warn but fall through (don't block the agent)
	if (agentModel) {
		const resolved = resolveModelFuzzy(agentModel);
		if (resolved) return { ok: true, model: resolved, fallbacks: [], reason: "agent-frontmatter" };
	}

	const config = loadRoutingConfig();
	const fallback = parentModelId
		? resolveFallback(parentModelId)
		: { provider: "unknown", id: "unknown", displayName: "unknown" };

	// 3. Routing disabled → inherit parent model
	if (!config.enabled) {
		return { ok: true, model: fallback, fallbacks: [], reason: "fallback" };
	}

	// 4. Auto-route: classify (or use hints), then select ranked candidates
	const effectiveCostPref = hints?.costPreference ?? config.costPreference;

	// Build classification — use hints to skip/override classifier where provided
	let classification: ClassificationResult;
	if (hints?.taskType !== undefined && hints?.complexity !== undefined) {
		// Both overridden — skip classifier entirely
		classification = {
			type: hints.taskType,
			complexity: Math.max(1, Math.min(5, hints.complexity)) as ClassificationResult["complexity"],
			reasoning: "per-call hints (type + complexity)",
		};
	} else {
		// Run classifier, then overlay any partial hints
		classification = await classifyTask(task, config.primaryType, agentRole);
		if (hints?.taskType !== undefined) {
			classification = {
				...classification,
				type: hints.taskType,
				reasoning: "per-call hint (type)",
			};
		}
		if (hints?.complexity !== undefined) {
			classification = {
				...classification,
				complexity: Math.max(
					1,
					Math.min(5, hints.complexity)
				) as ClassificationResult["complexity"],
				reasoning: "per-call hint (complexity)",
			};
		}
	}

	const ranked = selectModels(classification, effectiveCostPref);
	if (ranked.length > 0) {
		return {
			ok: true,
			model: ranked[0],
			fallbacks: ranked.slice(1),
			reason: "auto-routed",
			classification,
		};
	}

	// 5. No candidates matched → fallback to parent model
	return { ok: true, model: fallback, fallbacks: [], reason: "fallback", classification };
}
