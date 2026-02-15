/**
 * Model Resolver
 *
 * Resolves model specifiers using fuzzy matching against the registry.
 * Delegates to the shared resolver in subagent-tool; handles `inherit`
 * as undefined and preserves the original API surface.
 */

import { resolveModelFuzzy } from "../subagent-tool/model-resolver.js";

/**
 * Resolves a model specifier to a full model ID.
 *
 * Uses fuzzy matching against all registered providers/models.
 * Falls back to passthrough if the registry has no match (the model
 * string may still be valid for the subprocess).
 *
 * @param input - Short alias, full model ID, "inherit", or undefined
 * @returns Full model ID, or undefined if the subprocess should inherit the default
 */
export function resolveModel(input: string | undefined): string | undefined {
	if (input === undefined || input === "inherit") return undefined;
	const resolved = resolveModelFuzzy(input);
	return resolved?.id ?? input;
}
