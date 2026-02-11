/**
 * Global type declarations for pi-code extensions.
 *
 * Extensions use globalThis properties for cross-reload state persistence
 * and inter-extension communication. These declarations make TypeScript
 * aware of the custom properties.
 */

declare global {
	/** Generic Map-like type used for globalThis stores */
	type GlobalMap = Map<string, unknown>;
	// background-task-tool extension
	var __piBackgroundTasks: GlobalMap | undefined;

	// subagent-tool extension
	var __piBackgroundSubagents: GlobalMap | undefined;
	var __piRunningSubagents: GlobalMap | undefined;
	var __piSubagentWidgetInterval: ReturnType<typeof setInterval> | null | undefined;

	// git-status extension
	var __piGitStatusInterval: ReturnType<typeof setInterval> | null | undefined;

	// session-memory extension
	var __piSessionIndexer: unknown | undefined;

	// tasks extension
	var __piTasksInterval: ReturnType<typeof setInterval> | undefined;
}

export {};
