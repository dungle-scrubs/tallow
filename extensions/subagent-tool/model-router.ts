/**
 * Model routing orchestrator.
 *
 * Loads routing config, runs the selection algorithm (from synapse),
 * and exposes the main `routeModel` entry point consumed by the
 * subagent tool.
 *
 * Supports per-call routing hints so the parent LLM can express
 * intent (cost preference, task type, complexity) without picking
 * a specific model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ClassificationResult,
	CostPreference,
	ResolvedModel,
	SelectionOptions,
	TaskType,
} from "@dungle-scrubs/synapse";
import {
	listAvailableModels,
	resolveModelCandidates,
	resolveModelFuzzy,
	selectModels,
} from "@dungle-scrubs/synapse";
import { classifyTask } from "./task-classifier.js";

// ─── Types ───────────────────────────────────────────────────────────────────

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
	/**
	 * Constrain auto-routing to a model family via fuzzy match.
	 *
	 * When set, the auto-router only considers models matching this query
	 * (e.g. "codex" → only codex models, "gemini" → only Gemini models).
	 * The task is still classified and models are still filtered by capability
	 * and sorted by cost preference — but only within the scoped pool.
	 *
	 * Has no effect when an explicit model override is provided.
	 */
	modelScope?: string;
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
	reason: "explicit" | "agent-frontmatter" | "auto-routed" | "scoped-auto-routed" | "fallback";
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

// Re-export CostPreference for consumers that import it from model-router
export type { CostPreference, TaskType } from "@dungle-scrubs/synapse";

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

// ─── Subscription Provider Detection ─────────────────────────────────────────

/**
 * Reads auth.json and returns provider names that use OAuth (subscription) auth.
 *
 * Subscription providers (e.g. openai-codex for ChatGPT Plus/Pro, github-copilot)
 * are preferred over pay-per-token API providers when models tie on cost/rating.
 *
 * @returns Array of provider names with OAuth credentials, or empty if none
 */
function getSubscriptionProviders(): string[] {
	try {
		const authPath = path.join(os.homedir(), ".tallow", "auth.json");
		const raw = fs.readFileSync(authPath, "utf-8");
		const data = JSON.parse(raw) as Record<string, { type?: string }>;
		return Object.entries(data)
			.filter(([, cred]) => cred?.type === "oauth")
			.map(([provider]) => provider);
	} catch {
		return [];
	}
}

// ─── Routing Keywords ────────────────────────────────────────────────────────

/**
 * Maps routing keyword strings from agent frontmatter to cost preferences.
 *
 * When an agent's `model` field is set to one of these keywords instead of
 * an actual model name, the routing engine skips fuzzy model resolution and
 * instead forces auto-routing with the corresponding cost preference.
 *
 * Examples: `model: auto-cheap` → eco routing, `model: auto-premium` → premium routing.
 */
const ROUTING_KEYWORDS: ReadonlyMap<string, CostPreference> = new Map([
	["auto-cheap", "eco"],
	["auto-eco", "eco"],
	["auto-balanced", "balanced"],
	["auto-premium", "premium"],
]);

/**
 * Parse a model string as a routing keyword.
 *
 * @param model - Model string from agent frontmatter
 * @returns Cost preference if the string is a routing keyword, undefined otherwise
 */
export function parseRoutingKeyword(model: string): CostPreference | undefined {
	return ROUTING_KEYWORDS.get(model.toLowerCase().trim());
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
	// 1. Explicit per-call model override — fuzzy resolve to best match
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

	// 2. Agent frontmatter model — resolve as routing keyword, fuzzy match, or fall through
	let routingKeywordCostPref: CostPreference | undefined;
	if (agentModel) {
		const keyword = parseRoutingKeyword(agentModel);
		if (keyword) {
			// Routing keyword (e.g. "auto-cheap") — skip fuzzy resolution,
			// force auto-routing with the keyword's cost preference
			routingKeywordCostPref = keyword;
		} else {
			const resolved = resolveModelFuzzy(agentModel);
			if (resolved)
				return { ok: true, model: resolved, fallbacks: [], reason: "agent-frontmatter" };
		}
	}

	const config = loadRoutingConfig();
	const fallback = parentModelId
		? resolveFallback(parentModelId)
		: { provider: "unknown", id: "unknown", displayName: "unknown" };

	// 3. Routing disabled → inherit parent model (unless routing keyword forces auto-routing)
	if (!config.enabled && !routingKeywordCostPref) {
		return { ok: true, model: fallback, fallbacks: [], reason: "fallback" };
	}

	// 4. Auto-route: classify (or use hints), then select ranked candidates
	// Priority: per-call hints > routing keyword > global config
	const effectiveCostPref =
		hints?.costPreference ?? routingKeywordCostPref ?? config.costPreference;

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

	// Resolve model scope — constrains candidate pool to a model family
	const scopePool = hints?.modelScope ? resolveModelCandidates(hints.modelScope) : undefined;

	// Detect subscription providers for preferential tiebreaking
	const preferredProviders = getSubscriptionProviders();

	const selectionOptions: SelectionOptions = {
		pool: scopePool,
		preferredProviders: preferredProviders.length > 0 ? preferredProviders : undefined,
	};

	const ranked = selectModels(classification, effectiveCostPref, selectionOptions);
	if (ranked.length > 0) {
		return {
			ok: true,
			model: ranked[0],
			fallbacks: ranked.slice(1),
			reason: scopePool ? "scoped-auto-routed" : "auto-routed",
			classification,
		};
	}

	// 5. No candidates matched → fallback to parent model (or best from scope)
	if (scopePool && scopePool.length > 0) {
		// Scope had models but none met the complexity bar — use the best from scope
		return {
			ok: true,
			model: scopePool[0],
			fallbacks: scopePool.slice(1),
			reason: "scoped-auto-routed",
			classification,
		};
	}
	return { ok: true, model: fallback, fallbacks: [], reason: "fallback", classification };
}
