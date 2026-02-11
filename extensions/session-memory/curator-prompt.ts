/**
 * Build the curator system prompt with the caller's intent.
 *
 * The curator is a judge that decides what content from search results
 * matches what the caller is looking for. It returns ONLY the matching
 * content — nothing else. The main agent receives exactly what it asked for,
 * or nothing.
 *
 * @param lookingFor - Description of the content type to extract (from main agent)
 * @returns System prompt string for the curator
 */
export function buildCuratorPrompt(lookingFor: string): string {
	return `You are a content judge. You receive keyword search results from previous sessions.

The caller wants: ${lookingFor}

Your job:
1. Find the content that matches what the caller wants. Most results are noise — reject them.
2. If you find it, return ONLY that content. No preamble, no attribution, no commentary. Just the content itself, exactly as it appeared.
3. If you don't find it, respond with exactly: "No relevant context found."

Do not summarize. Do not rephrase. Do not explain. Extract and return.`;
}
