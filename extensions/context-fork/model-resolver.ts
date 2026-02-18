/**
 * Model Resolver
 *
 * Resolves model specifiers using both fuzzy matching (for explicit picks)
 * and full model routing (for auto-routing with optional scope).
 * Delegates to synapse for resolution and subagent-tool for routing.
 */

import { resolveModelFuzzy } from "@dungle-scrubs/synapse";
import { type RoutingHints, routeModel } from "../subagent-tool/model-router.js";

/**
 * Resolves a model specifier to a full model ID (sync, explicit pick only).
 *
 * Uses fuzzy matching against all registered providers/models.
 * Falls back to passthrough if the registry has no match.
 *
 * @param input - Short alias, full model ID, "inherit", or undefined
 * @returns Full model ID, or undefined if the subprocess should inherit the default
 */
export function resolveModel(input: string | undefined): string | undefined {
	if (input === undefined || input === "inherit") return undefined;
	const resolved = resolveModelFuzzy(input);
	return resolved?.id ?? input;
}

/**
 * Routes a model using the full routing algorithm (async).
 *
 * Supports explicit model override, auto-routing, and scoped routing
 * via the same engine as subagents and teams.
 *
 * @param task - Task description for classification
 * @param modelOverride - Explicit model (fuzzy matched), skips auto-routing
 * @param parentModelId - Parent model ID for fallback inheritance
 * @param hints - Optional routing hints (modelScope, costPreference, etc.)
 * @returns Resolved model ID, or undefined on failure
 */
export async function routeForkedModel(
	task: string,
	modelOverride?: string,
	parentModelId?: string,
	hints?: RoutingHints
): Promise<string | undefined> {
	const routing = await routeModel(task, modelOverride, undefined, parentModelId, undefined, hints);
	if (!routing.ok) return modelOverride; // fallback to raw string
	return routing.model.id;
}
