/** Version marker for memory-release event payloads. */
export const MEMORY_RELEASE_EVENT_SCHEMA_VERSION = 1 as const;

/** Cross-extension event channels for manual memory release lifecycle. */
export const MEMORY_RELEASE_EVENTS = {
	completed: "interop.v1.memory-release.completed",
} as const;

/** Valid memory-release event channel names. */
export type MemoryReleaseEventName =
	(typeof MEMORY_RELEASE_EVENTS)[keyof typeof MEMORY_RELEASE_EVENTS];

/** Payload emitted after release-memory compaction completes. */
export interface MemoryReleaseCompletedEvent {
	readonly command: "release-memory";
	readonly reason: "manual";
	readonly schemaVersion: typeof MEMORY_RELEASE_EVENT_SCHEMA_VERSION;
	readonly source: "run_slash_command";
	readonly timestamp: number;
}

/**
 * Build a standardized memory-release completion payload.
 *
 * @returns Event payload for cross-extension cache cleanup listeners
 */
export function createMemoryReleaseCompletedEvent(): MemoryReleaseCompletedEvent {
	return {
		command: "release-memory",
		reason: "manual",
		schemaVersion: MEMORY_RELEASE_EVENT_SCHEMA_VERSION,
		source: "run_slash_command",
		timestamp: Date.now(),
	};
}
