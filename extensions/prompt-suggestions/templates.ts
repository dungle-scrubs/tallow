/**
 * Curated common task templates for idle prompt suggestions.
 *
 * These provide a starting point when the user hasn't typed anything.
 * Shown as ghost text — the user can hit Enter to accept or start typing.
 */

/** A prompt suggestion with optional context tags for relevance scoring. */
export interface PromptTemplate {
	/** The full suggestion text shown as ghost text */
	text: string;
	/** Tags for context-aware filtering (e.g. "git", "test", "error") */
	tags?: string[];
}

/**
 * General-purpose templates shown when no context signals are available.
 * Ordered by estimated usefulness.
 */
export const GENERAL_TEMPLATES: readonly PromptTemplate[] = [
	{ text: "Explain the project structure", tags: ["explore"] },
	{ text: "What does this codebase do?", tags: ["explore"] },
	{ text: "Find and fix any TypeScript errors", tags: ["fix", "typescript"] },
	{ text: "Run the tests and fix any failures", tags: ["test"] },
	{ text: "Review the recent changes for issues", tags: ["review", "git"] },
	{ text: "Summarize what changed in the last commit", tags: ["git"] },
	{ text: "Add missing JSDoc comments to exported functions", tags: ["docs"] },
	{ text: "Find TODO comments and address them", tags: ["fix"] },
	{ text: "Refactor duplicated code", tags: ["refactor"] },
	{ text: "Check for security vulnerabilities", tags: ["security"] },
	{ text: "Optimize the slowest parts of the code", tags: ["performance"] },
	{ text: "Add error handling where it's missing", tags: ["fix"] },
	{ text: "Write tests for uncovered code paths", tags: ["test"] },
	{ text: "Update dependencies to latest versions", tags: ["deps"] },
	{ text: "List all available slash commands", tags: ["help"] },
] as const;

/**
 * Context-aware templates shown when specific signals are detected.
 * These take priority over general templates when their tags match.
 */
export const CONTEXTUAL_TEMPLATES: readonly PromptTemplate[] = [
	{ text: "Fix the failing tests", tags: ["error", "test"] },
	{ text: "Fix the TypeScript errors", tags: ["error", "typescript"] },
	{ text: "Explain this error and suggest a fix", tags: ["error"] },
	{ text: "Continue where you left off", tags: ["continued"] },
	{ text: "What were we working on?", tags: ["continued"] },
] as const;
