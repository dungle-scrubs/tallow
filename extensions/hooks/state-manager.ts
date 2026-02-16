/**
 * Persistent state tracking for once-hooks.
 *
 * Stores executed hook identifiers in `~/.tallow/hooks-state.json`.
 * Each hook is identified by a hash of its configuration
 * (event, matcher, type, command/agent) so the same hook config
 * always maps to the same identifier.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Persisted state tracking which once-hooks have executed. */
interface HookState {
	executedHooks: string[];
}

const STATE_FILE = "hooks-state.json";

/**
 * Computes a stable identifier for a hook handler based on its configuration.
 * Uses a truncated SHA-256 hash of the serialized hook identity fields.
 *
 * @param event - The event name (e.g. "tool_call", "session_start")
 * @param matcher - The matcher regex pattern (empty string if unset)
 * @param handler - The hook handler with type and command/agent fields
 * @returns 16-character hex hash identifying this hook
 */
function computeHookId(
	event: string,
	matcher: string | undefined,
	handler: { type: string; command?: string; agent?: string }
): string {
	const key = JSON.stringify({
		event,
		matcher: matcher ?? "",
		type: handler.type,
		command: handler.command ?? "",
		agent: handler.agent ?? "",
	});
	return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Loads hook execution state from disk.
 * Returns empty state on missing/corrupt files.
 *
 * @param tallowHome - Path to the .tallow home directory
 * @returns Parsed hook state or empty default
 */
function loadState(tallowHome: string): HookState {
	const statePath = path.join(tallowHome, STATE_FILE);
	try {
		if (fs.existsSync(statePath)) {
			const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
			if (Array.isArray(content.executedHooks)) {
				return content as HookState;
			}
		}
	} catch {
		// Corruption — reset to empty state
	}
	return { executedHooks: [] };
}

/**
 * Persists hook execution state to disk.
 * Best-effort — silently ignores write failures.
 *
 * @param tallowHome - Path to the .tallow home directory
 * @param state - State to persist
 */
function saveState(tallowHome: string, state: HookState): void {
	const statePath = path.join(tallowHome, STATE_FILE);
	try {
		fs.mkdirSync(tallowHome, { recursive: true });
		fs.writeFileSync(statePath, JSON.stringify(state, null, "\t"));
	} catch {
		// Best-effort — don't crash on write failure
	}
}

/**
 * Creates a hook state manager for tracking once-hook execution.
 * Loads persisted state on creation and caches it in memory.
 *
 * @param tallowHome - Path to the .tallow home directory (e.g. ~/.tallow)
 * @returns Manager with methods to check, mark, and compute hook identifiers
 */
export function createHookStateManager(tallowHome: string) {
	let state: HookState = loadState(tallowHome);

	return {
		/**
		 * Computes a stable identifier for a hook handler.
		 *
		 * @param event - Event name
		 * @param matcher - Matcher pattern
		 * @param handler - Hook handler config
		 * @returns 16-char hex hook identifier
		 */
		computeHookId,

		/**
		 * Checks if a once-hook has already been executed.
		 *
		 * @param hookId - The hook identifier from computeHookId
		 * @returns True if the hook has already run
		 */
		hasRun(hookId: string): boolean {
			return state.executedHooks.includes(hookId);
		},

		/**
		 * Marks a once-hook as executed and persists state to disk.
		 * No-op if the hook was already marked.
		 *
		 * @param hookId - The hook identifier from computeHookId
		 */
		markAsRun(hookId: string): void {
			if (!state.executedHooks.includes(hookId)) {
				state.executedHooks.push(hookId);
				saveState(tallowHome, state);
			}
		},

		/**
		 * Reloads state from disk. Useful after external modifications.
		 */
		reload(): void {
			state = loadState(tallowHome);
		},
	};
}

export type HookStateManager = ReturnType<typeof createHookStateManager>;
