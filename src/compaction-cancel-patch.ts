import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Minimal shape of AgentSession prototype methods we patch. */
interface AgentSessionPrototypeLike {
	__tallow_compaction_cancel_patch_applied__?: boolean;
	abortCompaction?: () => void;
	newSession?: (options?: unknown) => Promise<boolean>;
	switchSession?: (sessionPath: string) => Promise<boolean>;
}

const APPLY_FLAG = "__tallow_compaction_cancel_patch_applied_global__";

/**
 * Patch AgentSession prototype to cancel in-flight compaction before
 * session boundary transitions (newSession, switchSession).
 *
 * Without this patch, an ongoing compaction can race with the session
 * switch and corrupt the new session's context or cause stale UI state.
 *
 * The patch is idempotent at both the prototype level (sentinel property)
 * and the apply-function level (global flag on globalThis).
 *
 * @param prototype - AgentSession prototype object
 * @returns Nothing
 */
export function patchAgentSessionCompactionCancel(prototype: AgentSessionPrototypeLike): void {
	if (prototype.__tallow_compaction_cancel_patch_applied__) return;
	prototype.__tallow_compaction_cancel_patch_applied__ = true;

	const originalNewSession = prototype.newSession;
	if (typeof originalNewSession === "function") {
		prototype.newSession = async function (
			this: AgentSessionPrototypeLike,
			options?: unknown
		): Promise<boolean> {
			this.abortCompaction?.();
			return originalNewSession.call(this, options);
		};
	}

	const originalSwitchSession = prototype.switchSession;
	if (typeof originalSwitchSession === "function") {
		prototype.switchSession = async function (
			this: AgentSessionPrototypeLike,
			sessionPath: string
		): Promise<boolean> {
			this.abortCompaction?.();
			return originalSwitchSession.call(this, sessionPath);
		};
	}
}

/**
 * Apply the compaction-cancel patch to pi-coding-agent AgentSession.
 *
 * Uses a direct file import via resolved package path because the AgentSession
 * subpath is not exported from the package. Same pattern as the interactive-mode
 * stale UI patch.
 *
 * @returns Nothing
 */
export async function applyAgentSessionCompactionCancelPatch(): Promise<void> {
	const globals = globalThis as Record<string, unknown>;
	if (globals[APPLY_FLAG] === true) return;

	try {
		const require = createRequire(import.meta.url);
		const packageJsonPath = require.resolve("@mariozechner/pi-coding-agent/package.json");
		const packageRoot = dirname(packageJsonPath);
		const agentSessionPath = join(packageRoot, "dist", "core", "agent-session.js");
		const moduleUrl = pathToFileURL(agentSessionPath).href;
		const mod = (await import(moduleUrl)) as {
			AgentSession?: { prototype?: AgentSessionPrototypeLike };
		};
		const prototype = mod.AgentSession?.prototype;
		if (!prototype) return;
		patchAgentSessionCompactionCancel(prototype);
		globals[APPLY_FLAG] = true;
	} catch {
		// Non-fatal: patching is a runtime compatibility improvement.
	}
}
