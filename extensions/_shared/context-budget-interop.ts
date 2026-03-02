/**
 * Cross-extension interop for context-budget envelopes.
 *
 * A "planner" extension publishes a ContextBudgetApi via the event bus.
 * Consumer tools (web_fetch, read, etc.) take-and-consume envelopes
 * keyed by toolCallId — each envelope is single-use.
 *
 * Follows the same handshake pattern as promoteToBackgroundApi in
 * background-task-tool / bash-tool-enhanced.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Event bus channels for the context-budget API handshake. */
export const CONTEXT_BUDGET_API_CHANNELS = {
	/** Planner publishes its API object on this channel. */
	budgetApi: "interop.api.v1.context-budget.api",
	/** Consumer requests the API (for load-order independence). */
	budgetApiRequest: "interop.api.v1.context-budget.api-request",
} as const;

/** Default TTL for envelopes in milliseconds (30 seconds). */
export const ENVELOPE_DEFAULT_TTL_MS = 30_000;

/** Shared default policy values used by planner and tool consumers. */
export const CONTEXT_BUDGET_DEFAULTS = {
	maxPerToolBytes: 512 * 1024,
	minPerToolBytes: 4 * 1024,
	unknownUsageFallbackCapBytes: 32 * 1024,
} as const;

/**
 * A single-use budget envelope assigned to one tool call.
 *
 * Once taken, the envelope is consumed and cannot be retrieved again.
 */
export interface ContextBudgetEnvelope {
	/** Planner-suggested byte cap for this tool call's output. */
	readonly maxBytes: number;
	/** Number of tool calls in the current batch (1 when sequential). */
	readonly batchSize: number;
}

/**
 * Lifecycle metadata attached to stored envelopes for staleness tracking.
 */
export interface ContextBudgetEnvelopeMetadata {
	/** Wall-clock time when the envelope was created (Date.now()). */
	readonly createdAtMs: number;
	/** Turn index at which the envelope was created. */
	readonly turnIndex: number;
	/** Maximum lifetime in milliseconds before the envelope is considered stale. */
	readonly ttlMs: number;
}

/**
 * Internal storage entry pairing an envelope with its lifecycle metadata.
 */
export interface StoredEnvelope {
	readonly envelope: ContextBudgetEnvelope;
	readonly metadata: ContextBudgetEnvelopeMetadata;
}

/**
 * Check whether an envelope has exceeded its TTL.
 *
 * @param metadata - Envelope lifecycle metadata
 * @param nowMs - Current wall-clock time in milliseconds
 * @returns True when the envelope is expired
 */
export function isEnvelopeStale(metadata: ContextBudgetEnvelopeMetadata, nowMs: number): boolean {
	return nowMs - metadata.createdAtMs > metadata.ttlMs;
}

/**
 * Check whether an envelope belongs to the current turn.
 *
 * Envelopes created in a previous turn are invalid because the model
 * may have received different context since then.
 *
 * @param metadata - Envelope lifecycle metadata
 * @param currentTurnIndex - Active turn index from the framework
 * @returns True when the envelope's turn matches the current turn
 */
export function isEnvelopeTurnValid(
	metadata: ContextBudgetEnvelopeMetadata,
	currentTurnIndex: number
): boolean {
	return metadata.turnIndex === currentTurnIndex;
}

/**
 * Remove stale or turn-mismatched envelopes from a storage map.
 *
 * Iterates the map once and deletes entries that fail either the TTL
 * or turn-index check. Returns the number of entries removed.
 *
 * @param store - Mutable map of toolCallId → stored envelope
 * @param nowMs - Current wall-clock time in milliseconds
 * @param currentTurnIndex - Active turn index from the framework
 * @returns Number of envelopes removed
 */
export function cleanupStaleEnvelopes(
	store: Map<string, StoredEnvelope>,
	nowMs: number,
	currentTurnIndex: number
): number {
	let removed = 0;
	for (const [id, entry] of store) {
		if (
			isEnvelopeStale(entry.metadata, nowMs) ||
			!isEnvelopeTurnValid(entry.metadata, currentTurnIndex)
		) {
			store.delete(id);
			removed += 1;
		}
	}
	return removed;
}

/**
 * API surface a planner extension publishes on the event bus.
 *
 * `take` uses consume semantics: the first call for a given toolCallId
 * returns the envelope and deletes it; subsequent calls return undefined.
 */
export interface ContextBudgetApi {
	/**
	 * Take and consume the budget envelope for a tool call.
	 *
	 * @param toolCallId - Unique tool-call identifier from the framework
	 * @returns The envelope if one was allocated; undefined otherwise
	 */
	take(toolCallId: string): ContextBudgetEnvelope | undefined;
}

/**
 * Subscribe to the budget API and request it for load-order independence.
 *
 * Returns a getter that resolves to the latest published API (or null
 * if no planner extension is loaded).
 *
 * @param events - Shared extension event bus
 * @returns Getter for the current budget API
 */
export function subscribeToBudgetApi(
	events: ExtensionAPI["events"]
): () => ContextBudgetApi | null {
	let api: ContextBudgetApi | null = null;

	events.on(CONTEXT_BUDGET_API_CHANNELS.budgetApi, (data: unknown) => {
		const payload = data as { api?: ContextBudgetApi };
		if (payload?.api && typeof payload.api.take === "function") {
			api = payload.api;
		}
	});

	// Request in case the planner loaded before us.
	events.emit(CONTEXT_BUDGET_API_CHANNELS.budgetApiRequest, {});

	return () => api;
}
