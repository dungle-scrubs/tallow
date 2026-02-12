/**
 * Model Resolver
 *
 * Maps short model aliases (sonnet, haiku, opus) to full Anthropic model IDs.
 * Passes through full model IDs and handles `inherit` as undefined.
 */

/** Static alias map from short names to full Anthropic model IDs. */
export const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	sonnet: "claude-sonnet-4-5-20250514",
	haiku: "claude-haiku-4-5-20250514",
	opus: "claude-opus-4-5-20250514",
});

/**
 * Resolves a model specifier to a full model ID.
 *
 * @param input - Short alias, full model ID, "inherit", or undefined
 * @returns Full model ID, or undefined if the subprocess should inherit the default
 */
export function resolveModel(input: string | undefined): string | undefined {
	if (input === undefined || input === "inherit") return undefined;
	return MODEL_ALIASES[input] ?? input;
}
