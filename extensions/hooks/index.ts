/**
 * Hooks Extension - Claude Code-style hooks for Pi events
 *
 * Supports three hook types:
 *   - command: Run a shell command
 *   - prompt: Single LLM call for evaluation (not yet implemented)
 *   - agent: Spawn a subagent with tool access
 *
 * Hooks can be sync (blocking, can return decisions) or async (background).
 *
 * Configuration in settings.json:
 * {
 *   "hooks": {
 *     "tool_result": [{
 *       "matcher": "write|edit",
 *       "hooks": [{
 *         "type": "agent",
 *         "agent": "reviewer",
 *         "prompt": "Verify changes: $ARGUMENTS",
 *         "async": false,
 *         "timeout": 60
 *       }]
 *     }]
 *   }
 * }
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type AgentRunnerCandidate,
	formatMissingAgentRunnerError,
	resolveAgentRunnerCandidates,
} from "../../src/agent-runner.js";
import { isProjectTrusted } from "../_shared/project-trust.js";
import { evaluateCommand } from "../_shared/shell-policy.js";
import { createHookStateManager, type HookStateManager } from "./state-manager.js";

/** Hook execution strategy: shell command, LLM prompt, or agent subprocess. */
export type HookType = "command" | "prompt" | "agent";

/** Configuration for a single hook action triggered by an event. */
export interface HookHandler {
	type: HookType;
	command?: string; // For type: "command"
	agent?: string; // For type: "agent" - agent name from agents dir
	prompt?: string; // For type: "agent" or "prompt" - use $ARGUMENTS for event data
	model?: string; // Model override
	timeout?: number; // Seconds, default: 60 for agent, 30 for prompt, 600 for command
	async?: boolean; // Run in background (command/agent only)
	statusMessage?: string; // Custom spinner message
	once?: boolean; // Run exactly once, then auto-disable (state persisted to hooks-state.json)
	_claudeSource?: boolean; // Internal: this hook originated from Claude Code config
	_claudeEventName?: string; // Internal: original Claude Code event name
}

/** Event matcher with associated hooks — runs hooks when matcher regex matches. */
export interface HookMatcher {
	matcher?: string; // Regex pattern, empty = match all
	hooks: HookHandler[];
}

/** Top-level hooks configuration keyed by event name. */
export interface HooksConfig {
	[eventName: string]: HookMatcher[];
}

/** Result from executing a hook — may block, allow, or provide additional context. */
export interface HookResult {
	ok: boolean;
	reason?: string;
	additionalContext?: string;
	decision?: "block" | "allow";
}

// Events that support blocking via hook decisions.
// "before_*" session events can cancel the operation via pi's return value.
const BLOCKABLE_EVENTS = new Set([
	"tool_call", // Can block before tool executes
	"input", // Can block user input
	"session_before_compact", // Can cancel compaction
	"session_before_switch", // Can cancel session switch
	"session_before_fork", // Can cancel session fork
	"session_before_tree", // Can cancel tree navigation
]);

/** Track prompt-type hooks that have already been warned about (once per command) */
const warnedPromptHooks = new Set<string>();

/** Default maximum buffered output per subprocess stream (1 MiB). */
const DEFAULT_HOOK_OUTPUT_MAX_BUFFER_BYTES = 1024 * 1024;

/** Default grace window after SIGTERM before forcing SIGKILL. */
const DEFAULT_HOOK_FORCE_KILL_GRACE_MS = 1000;

/** Optional env override for hook subprocess output cap. */
const HOOK_OUTPUT_MAX_BUFFER_BYTES_ENV = "TALLOW_HOOK_MAX_BUFFER_BYTES";

/** Optional env override for hook subprocess SIGTERM→SIGKILL grace window. */
const HOOK_FORCE_KILL_GRACE_MS_ENV = "TALLOW_HOOK_FORCE_KILL_GRACE_MS";

/** Marker appended once when subprocess output is truncated due to buffer cap. */
export const HOOK_OUTPUT_TRUNCATION_MARKER = "\n[output truncated]\n";

/** Optional env override for hook-agent runner binary/path. */
const HOOK_AGENT_RUNNER_ENV = "TALLOW_HOOK_AGENT_RUNNER";

/** Internal termination reasons for hook subprocesses. */
type HookTerminationReason = "abort" | "timeout";

/** Buffered output accumulator state for a single stream. */
interface HookOutputBuffer {
	bytes: number;
	text: string;
	truncated: boolean;
}

/** Controller returned by termination wiring for cleanup and status checks. */
interface HookTerminationController {
	cleanup: () => void;
	getReason: () => HookTerminationReason | null;
}

/**
 * Parse a positive integer from env with a safe fallback.
 *
 * @param envName - Environment variable name
 * @param fallback - Fallback value when unset/invalid
 * @returns Parsed positive integer value
 */
function getPositiveIntEnv(envName: string, fallback: number): number {
	const raw = process.env[envName];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

/**
 * Resolve the hook subprocess output cap in bytes.
 *
 * @returns Max bytes retained per stream
 */
function getHookOutputMaxBufferBytes(): number {
	return getPositiveIntEnv(HOOK_OUTPUT_MAX_BUFFER_BYTES_ENV, DEFAULT_HOOK_OUTPUT_MAX_BUFFER_BYTES);
}

/**
 * Resolve the grace period after SIGTERM before SIGKILL.
 *
 * @returns Grace period in milliseconds
 */
function getHookForceKillGraceMs(): number {
	return getPositiveIntEnv(HOOK_FORCE_KILL_GRACE_MS_ENV, DEFAULT_HOOK_FORCE_KILL_GRACE_MS);
}

/**
 * Resolve hook-agent runner candidates in priority order.
 *
 * @returns Deduplicated runner candidates
 */
export function resolveHookAgentRunnerCandidates(): AgentRunnerCandidate[] {
	return resolveAgentRunnerCandidates({
		overrideEnvVar: HOOK_AGENT_RUNNER_ENV,
	});
}

/** Runner resolver used by runAgentHook (overridable in tests). */
let hookAgentRunnerResolver: () => AgentRunnerCandidate[] = resolveHookAgentRunnerCandidates;
/** Spawn implementation used by runAgentHook (overridable in tests). */
let spawnHookAgentProcess: typeof spawn = spawn;

/**
 * Override hook-agent runner candidate resolution for tests.
 *
 * @param resolver - Optional resolver override (reset when omitted)
 * @returns Nothing
 */
export function setHookAgentRunnerResolverForTests(resolver?: () => AgentRunnerCandidate[]): void {
	hookAgentRunnerResolver = resolver ?? resolveHookAgentRunnerCandidates;
}

/**
 * Override hook-agent spawn implementation for tests.
 *
 * @param implementation - Optional spawn override (reset when omitted)
 * @returns Nothing
 */
export function setHookAgentSpawnForTests(implementation?: typeof spawn): void {
	spawnHookAgentProcess = implementation ?? spawn;
}

/**
 * Append chunk data to a bounded stream buffer.
 *
 * Once the cap is reached, further chunks are ignored and a truncation marker
 * is appended exactly once.
 *
 * @param buffer - Mutable output buffer state
 * @param chunk - Incoming stream chunk
 * @param maxBytes - Maximum bytes retained for this stream
 * @returns void
 */
function appendToHookBuffer(buffer: HookOutputBuffer, chunk: Buffer, maxBytes: number): void {
	if (buffer.truncated) return;

	const remainingBytes = maxBytes - buffer.bytes;
	if (remainingBytes <= 0) {
		buffer.truncated = true;
		buffer.text += HOOK_OUTPUT_TRUNCATION_MARKER;
		return;
	}

	if (chunk.byteLength <= remainingBytes) {
		buffer.text += chunk.toString();
		buffer.bytes += chunk.byteLength;
		return;
	}

	buffer.text += chunk.subarray(0, remainingBytes).toString();
	buffer.bytes = maxBytes;
	buffer.truncated = true;
	buffer.text += HOOK_OUTPUT_TRUNCATION_MARKER;
}

/**
 * Wire timeout/abort handling with SIGTERM→SIGKILL escalation.
 *
 * @param proc - Child process to terminate on timeout/abort
 * @param timeoutMs - Timeout window in milliseconds
 * @param signal - Optional abort signal
 * @returns Controller with cleanup and termination reason accessor
 */
function createHookTerminationController(
	proc: ChildProcess,
	timeoutMs: number,
	signal?: AbortSignal
): HookTerminationController {
	const forceKillGraceMs = getHookForceKillGraceMs();
	let terminatedBy: HookTerminationReason | null = null;
	let timeoutId: NodeJS.Timeout | null = null;
	let forceKillTimerId: NodeJS.Timeout | null = null;

	/**
	 * Start graceful termination and schedule forced kill.
	 *
	 * @param reason - Reason for termination
	 * @returns void
	 */
	const terminate = (reason: HookTerminationReason): void => {
		if (terminatedBy !== null) return;
		terminatedBy = reason;
		try {
			proc.kill("SIGTERM");
		} catch {
			// Process may already be gone.
		}
		forceKillTimerId = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Process already exited after SIGTERM.
			}
		}, forceKillGraceMs);
	};

	if (timeoutMs > 0) {
		timeoutId = setTimeout(() => terminate("timeout"), timeoutMs);
	}

	const onAbort = (): void => terminate("abort");
	if (signal) {
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	return {
		cleanup: () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
			if (forceKillTimerId) {
				clearTimeout(forceKillTimerId);
				forceKillTimerId = null;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
		},
		getReason: () => terminatedBy,
	};
}

// Map Pi events to what field the matcher filters on
const MATCHER_FIELDS: Record<string, string> = {
	tool_call: "toolName",
	tool_result: "toolName",
	teammate_idle: "teammate",
	task_completed: "assignee",
	setup: "trigger",
	subagent_start: "agent_type",
	subagent_stop: "agent_type",
	model_select: "source",
	user_bash: "command",
	notification: "type",
};

/** Claude Code event names translated to tallow/pi event names. */
export const CLAUDE_EVENT_MAP: Readonly<Record<string, string>> = {
	SessionStart: "session_start",
	UserPromptSubmit: "input",
	PreToolUse: "tool_call",
	PermissionRequest: "tool_call",
	PostToolUse: "tool_result",
	PostToolUseFailure: "tool_result",
	Notification: "notification",
	SubagentStart: "subagent_start",
	SubagentStop: "subagent_stop",
	Stop: "agent_end",
	TeammateIdle: "teammate_idle",
	TaskCompleted: "task_completed",
	PreCompact: "session_before_compact",
	SessionEnd: "session_shutdown",
} as const;

/** Claude Code tool names translated to tallow tool names for matchers. */
export const CLAUDE_TOOL_MAP: Readonly<Record<string, string>> = {
	Bash: "bash",
	Edit: "edit",
	Write: "write",
	Read: "read",
	Glob: "find",
	Grep: "grep",
	Task: "subagent",
	WebFetch: "web_fetch",
	WebSearch: "web_search",
} as const;

const CLAUDE_TOOL_EVENTS = new Set([
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PostToolUseFailure",
]);

/**
 * Returns true when a plain object-like value is provided.
 * @param value - Unknown value to check
 * @returns True when value can be safely treated as key/value object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Translates Claude Code tool matcher patterns to tallow tool names.
 *
 * Examples:
 * - Bash -> bash
 * - Edit|Write -> edit|write
 * - mcp__github__.* -> unchanged
 *
 * @param matcher - Optional matcher regex/string
 * @returns Matcher translated to tallow tool names
 */
export function translateClaudeToolMatcher(matcher?: string): string | undefined {
	if (!matcher || matcher === "" || matcher === "*") return matcher;

	return matcher
		.split("|")
		.map((part) => {
			const trimmed = part.trim();
			return CLAUDE_TOOL_MAP[trimmed] ?? trimmed;
		})
		.join("|");
}

/**
 * Translates Claude Code hook config into native tallow hook config.
 *
 * The translated config keeps original event metadata on each hook handler so
 * runtime input/output adapters can preserve Claude-compatible payload shapes.
 *
 * @param config - Hook config loaded from Claude settings
 * @param sourceLabel - Human-readable source path for warning messages
 * @returns Config keyed by tallow event names
 */
export function translateClaudeHooks(
	config: HooksConfig,
	sourceLabel = ".claude/settings.json"
): HooksConfig {
	const translated: HooksConfig = {};

	for (const [eventName, matchers] of Object.entries(config)) {
		if (eventName === "PermissionRequest") {
			console.warn(
				`[hooks] PermissionRequest in ${sourceLabel} has no tallow equivalent and will be skipped`
			);
			continue;
		}

		const mappedEventName = CLAUDE_EVENT_MAP[eventName] ?? eventName;
		const shouldTranslateMatcher = CLAUDE_TOOL_EVENTS.has(eventName);
		const normalizedMatchers = matchers.map((matcher) => ({
			...matcher,
			matcher: shouldTranslateMatcher
				? translateClaudeToolMatcher(matcher.matcher)
				: matcher.matcher,
			hooks: matcher.hooks.map((handler) => ({
				...handler,
				_claudeEventName: eventName,
				_claudeSource: true,
			})),
		}));

		if (!translated[mappedEventName]) {
			translated[mappedEventName] = [];
		}
		translated[mappedEventName].push(...normalizedMatchers);
	}

	return translated;
}

/**
 * Adapts tallow event payloads to Claude Code-style hook stdin payloads.
 *
 * @param eventName - Native tallow event name currently being processed
 * @param eventData - Native event payload
 * @param handler - Hook handler metadata
 * @param cwd - Current working directory
 * @returns Payload sent to the hook command
 */
export function adaptEventDataForHook(
	eventName: string,
	eventData: Record<string, unknown>,
	handler: HookHandler,
	cwd: string
): Record<string, unknown> {
	if (!handler._claudeSource) return eventData;

	const hookEventName = handler._claudeEventName ?? eventName;
	const adapted: Record<string, unknown> = {
		...eventData,
		cwd,
		hook_event_name: hookEventName,
	};

	if (hookEventName === "PreToolUse") {
		adapted.tool_input = eventData.input;
		adapted.tool_name = eventData.toolName;
		return adapted;
	}

	if (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") {
		adapted.tool_input = eventData.input;
		adapted.tool_name = eventData.toolName;
		adapted.tool_response = eventData.content;
		return adapted;
	}

	if (hookEventName === "UserPromptSubmit") {
		adapted.prompt = eventData.text;
		return adapted;
	}

	return adapted;
}

/**
 * Translates Claude Code hook JSON output into tallow hook result format.
 *
 * @param result - Parsed stdout JSON from hook command
 * @returns Normalized tallow hook result
 */
export function translateClaudeOutput(result: Record<string, unknown>): HookResult {
	const specific = isRecord(result.hookSpecificOutput) ? result.hookSpecificOutput : undefined;

	if (specific?.permissionDecision === "deny") {
		return {
			ok: false,
			decision: "block",
			reason:
				typeof specific.permissionDecisionReason === "string"
					? specific.permissionDecisionReason
					: "Blocked by Claude hook",
		};
	}

	if (specific?.permissionDecision === "allow") {
		return { ok: true };
	}

	if (typeof specific?.additionalContext === "string") {
		return { ok: true, additionalContext: specific.additionalContext };
	}

	if (result.decision === "block") {
		return {
			ok: false,
			decision: "block",
			reason: typeof result.reason === "string" ? result.reason : "Blocked by hook",
		};
	}

	if (result.continue === false) {
		return {
			ok: false,
			reason: typeof result.stopReason === "string" ? result.stopReason : "Stopped by hook",
		};
	}

	return {
		ok: typeof result.ok === "boolean" ? result.ok : true,
		additionalContext:
			typeof result.additionalContext === "string" ? result.additionalContext : undefined,
		reason: typeof result.reason === "string" ? result.reason : undefined,
		decision:
			result.decision === "allow" || result.decision === "block" ? result.decision : undefined,
	};
}

/**
 * Returns whether a Claude tool_result hook should be skipped for this event payload.
 *
 * @param eventName - Current tallow event name
 * @param eventData - Event payload
 * @param handler - Hook handler metadata
 * @returns True when handler should not run
 */
export function shouldSkipClaudeToolResultHandler(
	eventName: string,
	eventData: Record<string, unknown>,
	handler: HookHandler
): boolean {
	if (eventName !== "tool_result" || !handler._claudeSource) return false;
	if (handler._claudeEventName === "PostToolUseFailure") return eventData.isError !== true;
	if (handler._claudeEventName === "PostToolUse") return eventData.isError === true;
	return false;
}

/**
 * Merges hooks from a source into the target config.
 * Matchers are concatenated per event — no replacement.
 */
function mergeHooks(target: HooksConfig, source: HooksConfig): void {
	for (const [event, matchers] of Object.entries(source)) {
		if (!target[event]) {
			target[event] = [];
		}
		target[event].push(...matchers);
	}
}

/**
 * Reads hooks from a JSON file (standalone hooks.json or settings.json with hooks key).
 * Returns null if the file doesn't exist or can't be parsed.
 */
function readHooksFile(filePath: string): HooksConfig | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		// Standalone hooks.json has event keys at top level.
		// settings.json wraps them under a "hooks" key.
		return (
			content.hooks ??
			(content.tool_call || content.tool_result || content.agent_end ? content : null)
		);
	} catch {
		return null;
	}
}

/**
 * Scans a directory for extension hooks.json files.
 * Looks for <dir>/<ext>/hooks.json in each subdirectory.
 */
function scanExtensionHooks(extensionsDir: string): HooksConfig {
	const merged: HooksConfig = {};
	try {
		if (!fs.existsSync(extensionsDir)) return merged;
		const entries = fs.readdirSync(extensionsDir);
		for (const entry of entries) {
			const hooksPath = path.join(extensionsDir, entry, "hooks.json");
			const hooks = readHooksFile(hooksPath);
			if (hooks) {
				mergeHooks(merged, hooks);
			}
		}
	} catch {
		// Ignore scan errors
	}
	return merged;
}

/**
 * Resolves a path that may start with ~ to an absolute path.
 * @param p - Path that may contain ~ prefix
 * @returns Resolved absolute path
 */
function resolvePath(p: string): string {
	const trimmed = p.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	return path.resolve(trimmed);
}

/**
 * Reads settings.json and returns hooks.json paths from installed packages.
 * Scans each local package path for a hooks.json file.
 * @param settingsPath - Path to settings.json
 * @returns Array of HooksConfig objects found in packages
 */
function getPackageHooks(settingsPath: string): HooksConfig[] {
	const results: HooksConfig[] = [];
	if (!fs.existsSync(settingsPath)) return results;

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { packages?: Array<string | { source: string }> };
		if (!Array.isArray(settings.packages)) return results;

		const settingsDir = path.dirname(settingsPath);

		for (const pkg of settings.packages) {
			const source =
				typeof pkg === "string"
					? pkg
					: typeof pkg === "object" && pkg !== null && "source" in pkg
						? pkg.source
						: null;
			if (!source || typeof source !== "string") continue;
			// Only handle local paths (not npm: or git:)
			if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("https://"))
				continue;

			const resolved = resolvePath(
				source.startsWith("./") || source.startsWith("../")
					? path.resolve(settingsDir, source)
					: source
			);

			const hooksFile = path.join(resolved, "hooks.json");
			const hooks = readHooksFile(hooksFile);
			if (hooks) {
				results.push(hooks);
			}
		}
	} catch {
		// Ignore parse errors
	}

	return results;
}

/**
 * Loads and merges hooks from all sources.
 *
 * Scan order:
 *   1. hooks.json from packages in settings.json (global, always)
 *   2. ~/.tallow/hooks.json                     (global standalone)
 *   3. ~/.tallow/settings.json                  (global settings)
 *   4. .tallow/hooks.json                       (project standalone, trusted only)
 *   5. .tallow/settings.json                    (project settings, trusted only)
 *   6. ~/.tallow/extensions/∗/hooks.json        (global extension hooks)
 *   7. .tallow/extensions/∗/hooks.json          (project extension hooks, trusted only)
 *   8. .claude/settings.json                    (project Claude hooks, translated)
 *   9. ~/.claude/settings.json                  (global Claude hooks, translated)
 *
 * All sources are merged additively — matchers are concatenated per event.
 * Runtime hooks from other extensions are merged later via the hooks:merge
 * event bus.
 *
 * @param cwd - Current working directory for project-local paths
 * @returns Merged hooks configuration
 */
export function loadHooksConfig(cwd: string): HooksConfig {
	const home = process.env.HOME || "";
	const merged: HooksConfig = {};
	const allowProjectSources = isProjectTrusted();

	// 1. Package hooks (lowest priority)
	const globalSettingsPath = path.join(home, ".tallow", "settings.json");
	const projectSettingsPath = path.join(cwd, ".tallow", "settings.json");
	for (const hooks of getPackageHooks(globalSettingsPath)) {
		mergeHooks(merged, hooks);
	}
	if (allowProjectSources) {
		for (const hooks of getPackageHooks(projectSettingsPath)) {
			mergeHooks(merged, hooks);
		}
	}

	// 2–3. Global hooks (standalone + settings)
	const globalHooks = readHooksFile(path.join(home, ".tallow", "hooks.json"));
	if (globalHooks) mergeHooks(merged, globalHooks);

	const globalSettings = readHooksFile(globalSettingsPath);
	if (globalSettings) mergeHooks(merged, globalSettings);

	// 4–5. Project hooks (standalone + settings)
	if (allowProjectSources) {
		const projectHooks = readHooksFile(path.join(cwd, ".tallow", "hooks.json"));
		if (projectHooks) mergeHooks(merged, projectHooks);

		const projectSettings = readHooksFile(projectSettingsPath);
		if (projectSettings) mergeHooks(merged, projectSettings);
	}

	// 6. Global extension hooks
	const globalExtHooks = scanExtensionHooks(path.join(home, ".tallow", "extensions"));
	mergeHooks(merged, globalExtHooks);

	// 7. Project extension hooks
	if (allowProjectSources) {
		const projectExtHooks = scanExtensionHooks(path.join(cwd, ".tallow", "extensions"));
		mergeHooks(merged, projectExtHooks);
	}

	// 8. Claude project settings hooks (translated)
	const claudeProjectPath = path.join(cwd, ".claude", "settings.json");
	const claudeProjectSettings = readHooksFile(claudeProjectPath);
	if (claudeProjectSettings) {
		mergeHooks(merged, translateClaudeHooks(claudeProjectSettings, claudeProjectPath));
	}

	// 9. Claude global settings hooks (translated)
	const claudeGlobalPath = path.join(home, ".claude", "settings.json");
	const claudeGlobalSettings = readHooksFile(claudeGlobalPath);
	if (claudeGlobalSettings) {
		mergeHooks(merged, translateClaudeHooks(claudeGlobalSettings, claudeGlobalPath));
	}

	return merged;
}

/**
 * Checks if a value matches a regex pattern.
 * @param value - Value to test
 * @param pattern - Regex pattern (empty/undefined matches all)
 * @returns True if value matches pattern
 */
function matchesPattern(value: string | undefined, pattern: string | undefined): boolean {
	if (!pattern || pattern === "" || pattern === "*") return true;
	if (!value) return false;
	try {
		return new RegExp(pattern).test(value);
	} catch {
		return value === pattern;
	}
}

/**
 * Runs a command-type hook as a subprocess.
 * @param handler - Hook handler configuration
 * @param eventData - Event data to pass to the command
 * @param cwd - Working directory for the command
 * @param signal - Optional abort signal
 * @returns Hook result with ok status and optional context
 */
export async function runCommandHook(
	handler: HookHandler,
	eventData: Record<string, unknown>,
	cwd: string,
	signal?: AbortSignal
): Promise<HookResult> {
	if (!handler.command) return { ok: true };

	// B12 hardening: check permission rules before spawning shell commands.
	// Hooks run non-interactively, so ask-tier rules are treated as deny
	// (hooks can't prompt the user).
	// Source is "bash" (explicit trust) because hook commands come from user-authored
	// config files (hooks.json / settings.json), not from LLM output. Using
	// "shell-interpolation" (implicit trust) would block all hooks unless the user
	// explicitly enables shell interpolation — which is unrelated to hooks.
	const policyVerdict = evaluateCommand(handler.command, "bash", cwd);
	if (!policyVerdict.allowed) {
		console.error(
			`[hooks] Blocked hook command by permission rule: ${handler.command} — ${policyVerdict.reason}`
		);
		return {
			ok: false,
			reason: `Hook command blocked by permission rule: ${policyVerdict.reason}`,
		};
	}
	if (policyVerdict.requiresConfirmation) {
		// Hooks can't prompt — skip with warning
		console.error(
			`[hooks] Skipped hook command (requires confirmation, non-interactive): ${handler.command}`
		);
		return {
			ok: false,
			reason: "Hook command requires confirmation but hooks run non-interactively",
		};
	}

	const timeoutMs = (handler.timeout ?? 600) * 1000;
	const maxBufferBytes = getHookOutputMaxBufferBytes();
	const hookEventJson = JSON.stringify(eventData);
	const commandEnv: Record<string, string> = {
		...process.env,
		PI_HOOK_EVENT: hookEventJson,
	} as Record<string, string>;

	if (handler._claudeSource) {
		commandEnv.CLAUDE_CODE_REMOTE = process.env.CLAUDE_CODE_REMOTE ?? "false";
		commandEnv.CLAUDE_PLUGIN_ROOT = path.join(os.homedir(), ".claude");
		commandEnv.CLAUDE_PROJECT_DIR = cwd;
	}

	return new Promise((resolve) => {
		if (!handler.command) {
			resolve({ ok: true });
			return;
		}

		// shell: true is required for user-authored hook commands (pipes, redirects,
		// env expansion). Commands come from settings.json, NOT from LLM input, so
		// this is not an injection vector. Permission rules provide defense-in-depth.
		const proc = spawn(handler.command, {
			cwd,
			env: commandEnv,
			shell: true,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdout: HookOutputBuffer = { bytes: 0, text: "", truncated: false };
		const stderr: HookOutputBuffer = { bytes: 0, text: "", truncated: false };
		const termination = createHookTerminationController(proc, timeoutMs, signal);
		let settled = false;

		/**
		 * Resolve exactly once and clean up process listeners/timers.
		 *
		 * @param result - Hook execution result
		 * @returns void
		 */
		const settle = (result: HookResult): void => {
			if (settled) return;
			settled = true;
			termination.cleanup();
			resolve(result);
		};

		proc.stdout.on("data", (chunk: Buffer) => {
			appendToHookBuffer(stdout, chunk, maxBufferBytes);
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			appendToHookBuffer(stderr, chunk, maxBufferBytes);
		});

		try {
			proc.stdin.write(hookEventJson);
			proc.stdin.end();
		} catch {
			// Ignore stdin write errors (process may have already exited).
		}

		proc.once("error", (error) => {
			settle({ ok: false, reason: error.message || "Hook command failed to start" });
		});

		proc.once("close", (code) => {
			const terminatedBy = termination.getReason();
			if (terminatedBy !== null) {
				settle({ ok: false, reason: "Hook timed out or was aborted" });
				return;
			}

			const stderrText = stderr.text.trim();
			const stdoutText = stdout.text.trim();

			// Exit code 2 = blocking error
			if (code === 2) {
				settle({ ok: false, reason: stderrText || "Blocked by hook", decision: "block" });
				return;
			}

			// Exit code 0 = success, parse JSON output
			if (code === 0 && stdoutText) {
				try {
					const parsed = JSON.parse(stdoutText);
					if (isRecord(parsed) && handler._claudeSource) {
						settle(translateClaudeOutput(parsed));
						return;
					}
					if (isRecord(parsed)) {
						settle({
							ok: parsed.ok !== false,
							reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
							additionalContext:
								typeof parsed.additionalContext === "string" ? parsed.additionalContext : undefined,
							decision:
								parsed.decision === "allow" || parsed.decision === "block"
									? parsed.decision
									: undefined,
						});
						return;
					}
				} catch {
					// Not JSON, treat as additional context
					settle({ ok: true, additionalContext: stdoutText });
					return;
				}
			}

			settle({ ok: true });
		});
	});
}

/**
 * Runs an agent-type hook by spawning a resolved tallow-compatible subprocess.
 * @param handler - Hook handler configuration
 * @param eventData - Event data to include in prompt
 * @param cwd - Working directory for the agent
 * @param agentsDir - Directory containing agent definitions
 * @param signal - Optional abort signal
 * @returns Hook result with ok status and optional context
 */
export async function runAgentHook(
	handler: HookHandler,
	eventData: Record<string, unknown>,
	cwd: string,
	agentsDir: string,
	signal?: AbortSignal
): Promise<HookResult> {
	const timeoutMs = (handler.timeout ?? 60) * 1000;
	const maxBufferBytes = getHookOutputMaxBufferBytes();

	// Build the prompt
	let prompt =
		handler.prompt ||
		"Evaluate the following event and return JSON: { ok: true/false, reason: '...' }";
	prompt = prompt.replace(/\$ARGUMENTS/g, JSON.stringify(eventData, null, 2));

	// Build CLI args
	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	if (handler.model) {
		args.push("--model", handler.model);
	}

	if (handler.agent) {
		const agentPath = path.join(agentsDir, `${handler.agent}.md`);
		if (fs.existsSync(agentPath)) {
			args.push("--append-system-prompt", agentPath);
		}
	}

	args.push(prompt);

	return new Promise((resolve) => {
		const runners = hookAgentRunnerResolver();
		if (runners.length === 0) {
			resolve({
				ok: false,
				reason: formatMissingAgentRunnerError(runners, HOOK_AGENT_RUNNER_ENV),
			});
			return;
		}

		const stdout: HookOutputBuffer = { bytes: 0, text: "", truncated: false };
		const stderr: HookOutputBuffer = { bytes: 0, text: "", truncated: false };
		let settled = false;
		let lastSpawnError: NodeJS.ErrnoException | null = null;

		/**
		 * Resolve exactly once.
		 *
		 * @param result - Hook execution result
		 * @returns void
		 */
		const settle = (result: HookResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		/**
		 * Spawn the next runner candidate until one starts or all fail.
		 *
		 * @param index - Candidate index
		 * @returns void
		 */
		const spawnWithRunner = (index: number): void => {
			const runner = runners[index];
			if (!runner) {
				settle({
					ok: false,
					reason: formatMissingAgentRunnerError(
						runners,
						HOOK_AGENT_RUNNER_ENV,
						lastSpawnError?.message
					),
				});
				return;
			}

			const launchArgs = [...runner.preArgs, ...args];
			const proc = spawnHookAgentProcess(runner.command, launchArgs, {
				cwd,
				env: { ...process.env, PI_IS_HOOK_AGENT: "1" },
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const termination = createHookTerminationController(proc, timeoutMs, signal);
			let startupFailed = false;

			proc.stdout.on("data", (chunk: Buffer) => {
				appendToHookBuffer(stdout, chunk, maxBufferBytes);
			});
			proc.stderr.on("data", (chunk: Buffer) => {
				appendToHookBuffer(stderr, chunk, maxBufferBytes);
			});

			proc.once("error", (error) => {
				startupFailed = true;
				termination.cleanup();
				const spawnError = error as NodeJS.ErrnoException;
				if (spawnError.code === "ENOENT") {
					lastSpawnError = spawnError;
					spawnWithRunner(index + 1);
					return;
				}
				settle({
					ok: false,
					reason:
						spawnError.message ||
						`Hook agent failed to start with runner ${runner.command} (${runner.source})`,
				});
			});

			proc.once("close", (code) => {
				if (startupFailed) {
					return;
				}
				termination.cleanup();
				const terminatedBy = termination.getReason();
				if (terminatedBy !== null) {
					settle({ ok: false, reason: "Hook agent timed out or was aborted" });
					return;
				}

				const output = stdout.text.trim();
				const lines = output.split("\n");
				for (let i = lines.length - 1; i >= 0; i--) {
					try {
						const event = JSON.parse(lines[i]);
						if (event.type === "message_end" && event.message?.role === "assistant") {
							for (const part of event.message.content) {
								if (part.type !== "text") continue;
								const jsonMatch = part.text.match(/\{[\s\S]*"ok"\s*:\s*(true|false)[\s\S]*\}/);
								if (!jsonMatch) continue;
								try {
									const result = JSON.parse(jsonMatch[0]);
									settle({
										additionalContext: result.additionalContext,
										ok: result.ok ?? true,
										reason: result.reason,
									});
									return;
								} catch {
									// Continue searching for parseable hook result JSON.
								}
							}
						}
					} catch {
						// Not JSON, continue.
					}
				}

				if (code !== 0) {
					const stderrText = stderr.text.trim();
					if (stderrText) {
						settle({ ok: false, reason: stderrText });
						return;
					}
				}

				// Preserve existing semantics: no parsed decision -> map process exit code.
				settle({ ok: code === 0 });
			});
		};

		spawnWithRunner(0);
	});
}

/**
 * Registers Claude Code-style hooks for Pi events.
 * @param pi - Extension API for registering event handlers
 */
export default function (pi: ExtensionAPI) {
	let hooksConfig: HooksConfig = {};
	let agentsDir = "";
	let currentCwd = "";
	let ctx: ExtensionContext | null = null;
	let stateManager: HookStateManager | null = null;

	// Pending async hook results to deliver on next turn
	const pendingAsyncResults: Array<{ event: string; result: HookResult }> = [];

	// ── Named event listener functions (removable on reload) ────

	/** Merge hook config from other extensions at runtime. */
	const onHooksMerge = (data: unknown) => {
		const matchers = data as Array<{
			piEvent: string;
			matcher?: string;
			hooks: Array<{ type: string; command?: string; [key: string]: unknown }>;
		}>;
		for (const m of matchers) {
			if (!hooksConfig[m.piEvent]) {
				hooksConfig[m.piEvent] = [];
			}
			hooksConfig[m.piEvent].push({
				matcher: m.matcher,
				hooks: m.hooks as HookHandler[],
			});
		}
	};

	/** Forward teammate_idle events to hook handlers. */
	const onTeammateIdle = (data: unknown) => {
		const event = data as { team: string; teammate: string; role: string };
		runHooks("teammate_idle", event);
	};

	/** Forward task_completed events to hook handlers. */
	const onTaskCompleted = (data: unknown) => {
		const event = data as {
			team: string;
			task_id: string;
			task_title: string;
			assignee: string;
			result: string;
		};
		runHooks("task_completed", event);
	};

	/** Forward subagent_start events from EventBus to hook handlers. */
	const onSubagentStart = (data: unknown) => {
		const event = data as {
			agent_id: string;
			agent_type: string;
			task: string;
			cwd: string;
			background: boolean;
		};
		runHooks("subagent_start", event);
	};

	/** Forward subagent_stop events from EventBus to hook handlers. */
	const onSubagentStop = (data: unknown) => {
		const event = data as {
			agent_id: string;
			agent_type: string;
			task: string;
			exit_code: number;
			result: string;
			background: boolean;
		};
		runHooks("subagent_stop", event);
	};

	/** Forward notification events from EventBus to hook handlers. */
	const onNotification = (data: unknown) => {
		const event = data as {
			message: string;
			type: string;
			source?: string;
		};
		runHooks("notification", event);
	};

	// ── Session lifecycle ────────────────────────────────────────

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		currentCwd = context.cwd;
		hooksConfig = loadHooksConfig(currentCwd);
		agentsDir = path.join(process.env.HOME || "", ".tallow", "agents");

		// Initialize once-hook state manager
		const tallowHome = path.join(process.env.HOME || "", ".tallow");
		stateManager = createHookStateManager(tallowHome);

		// Check for project-local agents dir
		const projectAgentsDir = path.join(currentCwd, ".tallow", "agents");
		if (fs.existsSync(projectAgentsDir)) {
			agentsDir = projectAgentsDir;
		}

		// Clean up previous event listeners on reload to prevent leaks.
		// pi.events persists across reloads — old listeners must be removed
		// before re-registering, otherwise each reload adds duplicates.
		const G = globalThis as Record<string, unknown>;
		if (G.__hooksEventCleanup) {
			(G.__hooksEventCleanup as () => void)();
		}

		// Register event listeners — on() returns unsubscribe functions
		const unsub1 = pi.events.on("hooks:merge", onHooksMerge);
		const unsub2 = pi.events.on("teammate_idle", onTeammateIdle);
		const unsub3 = pi.events.on("task_completed", onTaskCompleted);
		const unsub4 = pi.events.on("subagent_start", onSubagentStart);
		const unsub5 = pi.events.on("subagent_stop", onSubagentStop);
		const unsub6 = pi.events.on("notification", onNotification);
		G.__hooksEventCleanup = () => {
			unsub1();
			unsub2();
			unsub3();
			unsub4();
			unsub5();
			unsub6();
		};

		// Run setup hooks if triggered by --init, --init-only, or --maintenance CLI flags.
		// The env var is set by cli.ts before session creation and consumed here (one-shot).
		const setupTrigger = process.env.TALLOW_SETUP_TRIGGER;
		if (setupTrigger) {
			delete process.env.TALLOW_SETUP_TRIGGER;
			await runHooks("setup", {
				hook_event_name: "setup",
				trigger: setupTrigger,
				session_id: context.sessionManager.getSessionId(),
				cwd: currentCwd,
			});
		}
	});

	// Deliver pending async results at turn start
	pi.on("turn_start", async () => {
		if (pendingAsyncResults.length > 0 && ctx) {
			const results = pendingAsyncResults.splice(0);
			for (const { event, result } of results) {
				if (result.additionalContext || result.reason) {
					pi.sendMessage(
						{
							customType: "hook-result",
							content: result.additionalContext || result.reason || "",
							display: true,
							details: { event, ok: result.ok },
						},
						{ deliverAs: "nextTurn" }
					);
				}
			}
		}
	});

	// Helper to run hooks for an event
	async function runHooks(
		eventName: string,
		eventData: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<{ block: boolean; reason?: string; additionalContext?: string }> {
		const matchers = hooksConfig[eventName];
		if (!matchers || matchers.length === 0) {
			return { block: false };
		}

		const matcherField = MATCHER_FIELDS[eventName];
		const matchValue = matcherField ? (eventData[matcherField] as string) : undefined;

		const canBlock = BLOCKABLE_EVENTS.has(eventName);
		let shouldBlock = false;
		let blockReason: string | undefined;
		let additionalContext: string | undefined;

		for (const matcher of matchers) {
			if (!matchesPattern(matchValue, matcher.matcher)) {
				continue;
			}

			for (const handler of matcher.hooks) {
				// Skip already-executed once-hooks
				if (handler.once && stateManager) {
					const hookId = stateManager.computeHookId(eventName, matcher.matcher, handler);
					if (stateManager.hasRun(hookId)) {
						continue;
					}
				}

				if (shouldSkipClaudeToolResultHandler(eventName, eventData, handler)) {
					continue;
				}

				const hookEventData = adaptEventDataForHook(eventName, eventData, handler, currentCwd);

				// Async hooks run in background, cannot block
				if (handler.async) {
					// For async once-hooks, mark immediately to prevent race conditions.
					// Multiple events could fire before the first async hook completes,
					// so we claim the slot eagerly rather than waiting for completion.
					if (handler.once && stateManager) {
						const hookId = stateManager.computeHookId(eventName, matcher.matcher, handler);
						stateManager.markAsRun(hookId);
					}

					// Fire and forget
					(async () => {
						let result: HookResult;
						if (handler.type === "command") {
							result = await runCommandHook(handler, hookEventData, currentCwd);
						} else if (handler.type === "agent") {
							result = await runAgentHook(handler, hookEventData, currentCwd, agentsDir);
						} else {
							return; // prompt type not yet supported async
						}

						// Queue result for next turn
						if (result.additionalContext || result.reason) {
							pendingAsyncResults.push({ event: eventName, result });
						}
					})();
					continue;
				}

				// Sync hooks - run and potentially block
				let result: HookResult;

				if (handler.type === "command") {
					result = await runCommandHook(handler, hookEventData, currentCwd, signal);
				} else if (handler.type === "agent") {
					result = await runAgentHook(handler, hookEventData, currentCwd, agentsDir, signal);
				} else if (handler.type === "prompt") {
					// TODO: implement single LLM call for prompt-type hooks
					if (!warnedPromptHooks.has(handler.command ?? "")) {
						warnedPromptHooks.add(handler.command ?? "");
						console.error(
							`Hook "${handler.command ?? "unknown"}" uses type "prompt" which is not yet implemented. Use type "command" or "agent" instead.`
						);
					}
					continue;
				} else {
					continue;
				}

				// Mark sync once-hooks as run after successful execution
				if (handler.once && result.ok && stateManager) {
					const hookId = stateManager.computeHookId(eventName, matcher.matcher, handler);
					stateManager.markAsRun(hookId);
				}

				if (result.additionalContext) {
					additionalContext = `${(additionalContext || "") + result.additionalContext}\n`;
				}

				if (!result.ok && canBlock) {
					shouldBlock = true;
					blockReason = result.reason;
					break; // First blocking hook wins
				}
			}

			if (shouldBlock) break;
		}

		return {
			block: shouldBlock,
			reason: blockReason,
			additionalContext: additionalContext?.trim(),
		};
	}

	// Hook into tool_call events
	pi.on("tool_call", async (event, ctx) => {
		const result = await runHooks("tool_call", {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			input: event.input,
		});

		if (result.block) {
			const reason = result.reason || "Blocked by hook";
			ctx.ui?.notify(`⛔ Hook blocked tool_call (${event.toolName}): ${reason}`, "error");
			return { block: true, reason };
		}
	});

	// Hook into tool_result events
	pi.on("tool_result", async (event) => {
		await runHooks("tool_result", {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			input: event.input,
			content: event.content,
			isError: event.isError,
		});
		// tool_result cannot block (tool already ran)
	});

	// Hook into agent_end events
	pi.on("agent_end", async (event) => {
		await runHooks("agent_end", {
			messages: event.messages,
		});
	});

	// Hook into input events
	pi.on("input", async (event, ctx) => {
		const result = await runHooks("input", {
			text: event.text,
			source: event.source,
		});

		if (result.block) {
			const reason = result.reason || "Blocked by hook";
			ctx.ui?.notify(`⛔ Hook blocked input: ${reason}`, "error");
			return { action: "handled" as const }; // Block the input
		}
	});

	// ── Agent lifecycle events ───────────────────────────────────

	// Hook into before_agent_start — fires after user submits but before agent loop
	pi.on("before_agent_start", async (event) => {
		await runHooks("before_agent_start", {
			prompt: event.prompt,
			systemPrompt: event.systemPrompt,
			hasImages: (event.images?.length ?? 0) > 0,
		});
	});

	// Hook into agent_start events
	pi.on("agent_start", async () => {
		await runHooks("agent_start", {});
	});

	// Hook into turn_end events
	pi.on("turn_end", async (event) => {
		await runHooks("turn_end", {
			turnIndex: event.turnIndex,
		});
	});

	// ── Session lifecycle events ─────────────────────────────────

	// Hook into session_shutdown — fires on process exit
	pi.on("session_shutdown", async () => {
		await runHooks("session_shutdown", {});
	});

	// Hook into session_before_compact — fires before context compaction (can cancel)
	pi.on("session_before_compact", async (event, ctx) => {
		const result = await runHooks(
			"session_before_compact",
			{
				tokensBefore: event.preparation.tokensBefore,
				isSplitTurn: event.preparation.isSplitTurn,
			},
			event.signal
		);

		if (result.block) {
			const reason = result.reason || "Blocked by hook";
			ctx.ui?.notify(`⛔ Hook blocked compaction: ${reason}`, "error");
			return { cancel: true };
		}
	});

	// Hook into session_compact — fires after compaction completes
	pi.on("session_compact", async (event) => {
		await runHooks("session_compact", {
			fromExtension: event.fromExtension,
		});
	});

	// Hook into session_before_switch — fires before switching sessions (can cancel)
	pi.on("session_before_switch", async (event, ctx) => {
		const result = await runHooks("session_before_switch", {
			reason: event.reason,
			targetSessionFile: event.targetSessionFile,
		});

		if (result.block) {
			const reason = result.reason || "Blocked by hook";
			ctx.ui?.notify(`⛔ Hook blocked session switch: ${reason}`, "error");
			return { cancel: true };
		}
	});

	// Hook into session_switch — fires after switching sessions
	pi.on("session_switch", async (event) => {
		await runHooks("session_switch", {
			reason: event.reason,
			previousSessionFile: event.previousSessionFile,
		});
	});

	// Hook into session_before_fork — fires before forking (can cancel)
	pi.on("session_before_fork", async (event, ctx) => {
		const result = await runHooks("session_before_fork", {
			entryId: event.entryId,
		});

		if (result.block) {
			const reason = result.reason || "Blocked by hook";
			ctx.ui?.notify(`⛔ Hook blocked session fork: ${reason}`, "error");
			return { cancel: true };
		}
	});

	// Hook into session_fork — fires after forking
	pi.on("session_fork", async (event) => {
		await runHooks("session_fork", {
			previousSessionFile: event.previousSessionFile,
		});
	});

	// Hook into session_before_tree — fires before tree navigation (can cancel)
	pi.on("session_before_tree", async (event, ctx) => {
		const result = await runHooks(
			"session_before_tree",
			{
				targetId: event.preparation.targetId,
				oldLeafId: event.preparation.oldLeafId,
			},
			event.signal
		);

		if (result.block) {
			const reason = result.reason || "Blocked by hook";
			ctx.ui?.notify(`⛔ Hook blocked tree navigation: ${reason}`, "error");
			return { cancel: true };
		}
	});

	// Hook into session_tree — fires after tree navigation
	pi.on("session_tree", async (event) => {
		await runHooks("session_tree", {
			newLeafId: event.newLeafId,
			oldLeafId: event.oldLeafId,
		});
	});

	// ── Other events ─────────────────────────────────────────────

	// Hook into context — fires before each LLM call with messages
	pi.on("context", async (event) => {
		await runHooks("context", {
			messageCount: event.messages.length,
		});
	});

	// Hook into model_select — fires when model changes
	pi.on("model_select", async (event) => {
		await runHooks("model_select", {
			modelId: event.model.id,
			modelName: event.model.name,
			previousModelId: event.previousModel?.id,
			source: event.source,
		});
	});

	// Hook into user_bash — fires when user runs ! or !! commands
	pi.on("user_bash", async (event) => {
		await runHooks("user_bash", {
			command: event.command,
			excludeFromContext: event.excludeFromContext,
			cwd: event.cwd,
		});
	});
}
