/**
 * Shell Interpolation Extension
 *
 * Expands !`command` patterns in user input by running shell commands
 * and replacing patterns with stdout.
 *
 * Runtime behavior is policy-gated:
 * - Disabled by default (opt-in required)
 * - Implicit command allowlist/denylist checks
 * - Timeout/cwd/audit enforcement through centralized shell policy helpers
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	enforceImplicitPolicy,
	isShellInterpolationEnabled,
	runShellCommandSync,
} from "../_shared/shell-policy.js";

/** Matches !`command` patterns. Global flag supports multiple occurrences. */
const PATTERN = /!`([^`]+)`/g;

/** Shell interpolation execution timeout in milliseconds. */
const TIMEOUT_MS = 5000;

/** Maximum stdout/stderr buffer size for interpolation commands (1 MB). */
const MAX_BUFFER = 1024 * 1024;

/** Sources allowed to trigger shell interpolation execution. */
export type InterpolationSource = "shell-interpolation" | "context-fork";

/**
 * Options for shell interpolation expansion.
 */
export interface ExpandShellCommandOptions {
	/** Source used for policy/audit metadata. */
	readonly source?: InterpolationSource;
	/**
	 * When true, apply implicit shell policy checks before execution.
	 * Default false for programmatic utility usage.
	 */
	readonly enforcePolicy?: boolean;
}

/**
 * Expand !`command` patterns in text by running shell commands and replacing
 * each pattern with stdout.
 *
 * Non-recursive by design: command output is not re-scanned for !`...`
 * patterns, preventing chained interpolation injection.
 *
 * @param text - Input text potentially containing !`command` patterns
 * @param cwd - Working directory used for command execution
 * @param options - Optional source and policy enforcement controls
 * @returns Text with interpolations replaced by command output or denial/error markers
 */
export function expandShellCommands(
	text: string,
	cwd: string,
	options: ExpandShellCommandOptions = {}
): string {
	if (!PATTERN.test(text)) return text;
	PATTERN.lastIndex = 0;

	const source = options.source ?? "shell-interpolation";
	const enforcePolicy = options.enforcePolicy === true;

	return text.replace(PATTERN, (_match, cmd: string) => {
		const trimmed = cmd.trim();
		if (!trimmed) return "[denied: command is empty]";

		if (enforcePolicy) {
			const policy = enforceImplicitPolicy(trimmed, source, cwd);
			if (!policy.allowed) {
				return `[denied: ${policy.reason ?? "blocked by policy"}]`;
			}
		}

		const result = runShellCommandSync({
			command: trimmed,
			cwd,
			source,
			timeoutMs: TIMEOUT_MS,
			maxBuffer: MAX_BUFFER,
			enforcePolicy: false,
		});
		if (result.ok) return result.stdout.trimEnd();
		if (result.blocked) return `[denied: ${result.reason ?? "blocked by policy"}]`;
		return `[error: command failed: ${trimmed}]`;
	});
}

/**
 * Register input transformation that performs shell interpolation before
 * prompts reach the model.
 *
 * Disabled by default. Enable explicitly via env/settings policy gate.
 *
 * @param pi - Extension API
 * @returns void
 */
export default function (pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		if (!isShellInterpolationEnabled(ctx.cwd)) {
			return { action: "continue" as const };
		}

		const result = expandShellCommands(event.text, ctx.cwd, {
			source: "shell-interpolation",
			enforcePolicy: true,
		});
		if (result === event.text) {
			return { action: "continue" as const };
		}
		return { action: "transform" as const, text: result };
	});
}
