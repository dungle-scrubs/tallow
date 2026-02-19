/**
 * Centralized shell policy and process execution helpers.
 *
 * This module is the single policy gate for shell/process execution paths:
 * - Explicit user-intent tools: bash, bg_bash
 * - Implicit transforms/helpers: shell-interpolation, context-fork templates
 * - Internal helper commands: git/gh/which calls used by extensions
 *
 * It enforces:
 * - trust-level classification
 * - denylist/allowlist checks
 * - cwd guardrails
 * - timeout clamping
 * - audit trail recording
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	type ExpansionVars,
	evaluate as evaluatePermission,
	type LoadedPermissions,
	loadPermissionConfig,
	type PermissionConfig,
	parseRules,
} from "./permissions.js";
import { isProjectTrusted } from "./project-trust.js";

/** Trust classification for shell/process execution sources. */
export type ShellTrustLevel = "explicit" | "implicit" | "internal";

/** Known shell/process execution sources recorded in the audit trail. */
export type ShellSource =
	| "bash"
	| "bg_bash"
	| "shell-interpolation"
	| "context-fork"
	| "git-helper";

/** Recorded outcome values for shell policy and process execution events. */
export type ShellOutcome = "allowed" | "blocked" | "confirmed" | "bypassed" | "executed" | "failed";

/** Immutable audit entry for one command policy/execution event. */
export interface ShellAuditEntry {
	readonly timestamp: number;
	readonly command: string;
	readonly source: ShellSource;
	readonly trustLevel: ShellTrustLevel;
	readonly cwd: string;
	readonly outcome: ShellOutcome;
	readonly reason?: string;
	readonly exitCode?: number | null;
	readonly durationMs?: number;
}

/** Result of policy evaluation before a command executes. */
export interface ShellPolicyVerdict {
	readonly allowed: boolean;
	readonly requiresConfirmation: boolean;
	readonly trustLevel: ShellTrustLevel;
	readonly reason?: string;
	readonly normalizedCommand: string;
}

/** Process execution result with policy and runtime metadata. */
export interface ProcessRunResult {
	readonly ok: boolean;
	readonly blocked: boolean;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly reason?: string;
}

/** Options for running a non-shell process with policy checks. */
export interface RunCommandOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly source: ShellSource;
	readonly timeoutMs?: number;
	readonly maxBuffer?: number;
}

/** Options for running a shell command string with policy checks. */
export interface RunShellCommandOptions {
	readonly command: string;
	readonly cwd: string;
	readonly source: Extract<ShellSource, "shell-interpolation" | "context-fork">;
	readonly timeoutMs?: number;
	readonly maxBuffer?: number;
	readonly enforcePolicy?: boolean;
}

/** Hard timeout cap for command execution (30s). */
const MAX_TIMEOUT_MS = 30_000;

/** Default timeout for helper/internal process execution (5s). */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Default max buffered output for shell interpolation (1MB). */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** Maximum in-memory audit trail entries retained. */
const MAX_AUDIT_ENTRIES = 500;

/** Map command source to trust level classification. */
const SOURCE_TRUST: Readonly<Record<ShellSource, ShellTrustLevel>> = {
	bash: "explicit",
	bg_bash: "explicit",
	"shell-interpolation": "implicit",
	"context-fork": "implicit",
	"git-helper": "internal",
};

/** Prefix that identifies command boundaries for policy regex checks. */
const COMMAND_SEGMENT_PREFIX = String.raw`(?:^|(?:&&|\|\||[;|&])\s*|\n\s*)`;

/** Commands that are always denied regardless of trust level. */
const ALWAYS_BLOCK_PATTERNS: readonly RegExp[] = [
	new RegExp(`${COMMAND_SEGMENT_PREFIX}:\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:`, "i"), // fork bomb
	new RegExp(`${COMMAND_SEGMENT_PREFIX}rm\\s+-\\w*r\\w*\\s+/(?:\\*|\\s|$)`, "i"), // rm -rf / and rm -rf /*
	new RegExp(`${COMMAND_SEGMENT_PREFIX}mkfs(?:\\.\\w+)?\\b`, "i"),
	new RegExp(
		`${COMMAND_SEGMENT_PREFIX}dd\\b[^\\n]*\\bof\\s*=\\s*/dev/(?:sd|hd|nvme|loop|disk)\\w*`,
		"i"
	),
];

/** High-risk patterns: explicit sources require confirmation. */
const HIGH_RISK_PATTERNS: readonly RegExp[] = [
	new RegExp(`${COMMAND_SEGMENT_PREFIX}rm\\s+-\\w*r\\w*`, "i"),
	new RegExp(`${COMMAND_SEGMENT_PREFIX}sudo\\b`, "i"),
	new RegExp(`${COMMAND_SEGMENT_PREFIX}curl\\b[^\\n|]*\\|\\s*(?:ba)?sh\\b`, "i"),
	new RegExp(`${COMMAND_SEGMENT_PREFIX}wget\\b[^\\n|]*\\|\\s*(?:ba)?sh\\b`, "i"),
	new RegExp(`${COMMAND_SEGMENT_PREFIX}chmod\\s+-R\\s+777\\b`, "i"),
	new RegExp(`${COMMAND_SEGMENT_PREFIX}chown\\s+-R\\s+root\\b`, "i"),
	new RegExp(`${COMMAND_SEGMENT_PREFIX}git\\s+reset\\s+--hard\\b`, "i"),
	new RegExp(`${COMMAND_SEGMENT_PREFIX}git\\s+clean\\s+-f[dDxX]*\\b`, "i"),
	new RegExp(`${COMMAND_SEGMENT_PREFIX}dd\\s+if\\s*=`, "i"),
];

/** Implicit command allowlist (intentionally narrow). */
const IMPLICIT_ALLOWLIST: readonly RegExp[] = [
	/^echo(\s|$)/i,
	/^printf(\s|$)/i,
	/^pwd(\s|$)/i,
	/^ls(\s|$)/i,
	/^cat(\s|$)/i,
	/^head(\s|$)/i,
	/^tail(\s|$)/i,
	/^grep(\s|$)/i,
	/^rg(\s|$)/i,
	/^find(\s|$)/i,
	/^git\s+(status|log|diff|show|rev-parse|branch|ls-files)(\s|$)/i,
	/^which(\s|$)/i,
];

/** Shell metacharacters disallowed in implicit command paths. */
const IMPLICIT_FORBIDDEN_PATTERNS: readonly RegExp[] = [/&&|\|\|/, /[;|<>]/, /\$\(/, /`/];

/** Internal helper commands allowed by policy wrapper. */
const INTERNAL_COMMAND_ALLOWLIST = new Set(["git", "gh", "which"]);

/** Global in-memory audit trail (persists across extension reloads). */
const auditTrail: ShellAuditEntry[] =
	((globalThis as Record<string, unknown>).__piShellAuditTrail as ShellAuditEntry[]) ?? [];
(globalThis as Record<string, unknown>).__piShellAuditTrail = auditTrail;

// ── Permission Cache ─────────────────────────────────────────────────────────

/** Cached permission state, lazily loaded on first evaluateCommand() call. */
let cachedPermissions: LoadedPermissions | null = null;
/** CLI-provided permission config (set via setCliPermissionConfig). */
let cliPermissionConfig: PermissionConfig | undefined;
/** CWD used for the cached permission load. */
let cachedPermissionsCwd: string | null = null;

/**
 * Set CLI-provided permission rules (from --allowedTools / --disallowedTools flags).
 * Must be called before the first evaluateCommand() if CLI flags are present.
 *
 * @param config - CLI permission config
 * @returns void
 */
export function setCliPermissionConfig(config: PermissionConfig): void {
	cliPermissionConfig = config;
	cachedPermissions = null; // Force reload on next access
}

/**
 * Load CLI permission config from environment variables.
 * Called lazily on first permission access. The CLI passes rules as
 * JSON-encoded env vars since it can't import extensions directly.
 *
 * @returns CLI permission config, or undefined if no env vars set
 */
function loadCliPermissionConfigFromEnv(): PermissionConfig | undefined {
	const allowJson = process.env.TALLOW_ALLOWED_TOOLS;
	const denyJson = process.env.TALLOW_DISALLOWED_TOOLS;

	if (!allowJson && !denyJson) return undefined;

	const warnings: string[] = [];

	let allowEntries: unknown[] = [];
	let denyEntries: unknown[] = [];

	try {
		if (allowJson) allowEntries = JSON.parse(allowJson);
	} catch {
		warnings.push("Failed to parse TALLOW_ALLOWED_TOOLS env var");
	}

	try {
		if (denyJson) denyEntries = JSON.parse(denyJson);
	} catch {
		warnings.push("Failed to parse TALLOW_DISALLOWED_TOOLS env var");
	}

	for (const w of warnings) {
		console.error(`[permissions] ${w}`);
	}

	const allow = parseRules(allowEntries, warnings);
	const deny = parseRules(denyEntries, warnings);

	if (allow.length === 0 && deny.length === 0) return undefined;

	return { allow, deny, ask: [] };
}

/**
 * Get the currently loaded permission configuration.
 * Loads lazily on first access from settings files.
 * On first load, also checks env vars for CLI-provided permission rules.
 *
 * @param cwd - Current working directory
 * @returns Loaded permission state
 */
export function getPermissions(cwd: string): LoadedPermissions {
	if (cachedPermissions && cachedPermissionsCwd === cwd) {
		return cachedPermissions;
	}

	// On first load, check for CLI env vars
	if (!cliPermissionConfig) {
		cliPermissionConfig = loadCliPermissionConfigFromEnv();
	}

	const { loaded, warnings } = loadPermissionConfig(cwd, cliPermissionConfig);
	for (const w of warnings) {
		console.error(`[permissions] ${w}`);
	}
	cachedPermissions = loaded;
	cachedPermissionsCwd = cwd;
	return loaded;
}

/**
 * Force reload of permission configuration from disk.
 * Returns warnings from the reload attempt.
 *
 * @param cwd - Current working directory
 * @returns Array of warning messages from config parsing
 */
export function reloadPermissions(cwd: string): string[] {
	cachedPermissions = null;
	cachedPermissionsCwd = null;
	const { loaded, warnings } = loadPermissionConfig(cwd, cliPermissionConfig);
	cachedPermissions = loaded;
	cachedPermissionsCwd = cwd;
	return warnings;
}

/**
 * Reset permission cache. Intended for tests.
 *
 * @returns void
 */
export function resetPermissionCache(): void {
	cachedPermissions = null;
	cliPermissionConfig = undefined;
	cachedPermissionsCwd = null;
}

/**
 * Build expansion variables for the current environment.
 *
 * @param cwd - Current working directory
 * @returns Expansion variables for permission rule resolution
 */
function buildExpansionVars(cwd: string): ExpansionVars {
	const home = homedir();
	// Try to find git root for {project}
	let project = cwd;
	try {
		const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf-8",
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (result.status === 0 && result.stdout?.trim()) {
			project = result.stdout.trim();
		}
	} catch {
		// Not in a git repo — use cwd as project root
	}
	return { cwd, home, project };
}

/**
 * Clamp timeout values into the allowed execution range.
 *
 * @param timeoutMs - Requested timeout in milliseconds
 * @returns Timeout clamped to (0, MAX_TIMEOUT_MS], defaulting to DEFAULT_TIMEOUT_MS
 */
export function clampTimeout(timeoutMs: number | undefined): number {
	if (!timeoutMs || timeoutMs <= 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

/**
 * Append a shell audit entry and prune oldest entries beyond the retention cap.
 *
 * @param entry - Audit entry to append
 * @returns void
 */
export function recordAudit(entry: ShellAuditEntry): void {
	auditTrail.push(entry);
	if (auditTrail.length > MAX_AUDIT_ENTRIES) {
		auditTrail.splice(0, auditTrail.length - MAX_AUDIT_ENTRIES);
	}
}

/**
 * Get the shell audit trail snapshot.
 *
 * @returns Read-only shell audit entries in insertion order
 */
export function getAuditTrail(): readonly ShellAuditEntry[] {
	return auditTrail;
}

/**
 * Clear shell audit entries. Intended for tests.
 *
 * @returns void
 */
export function clearAuditTrail(): void {
	auditTrail.length = 0;
}

/**
 * Resolve trust level from command source.
 *
 * @param source - Shell/process source identifier
 * @returns Trust level for policy evaluation
 */
export function getTrustLevel(source: ShellSource): ShellTrustLevel {
	return SOURCE_TRUST[source];
}

/**
 * Strip quoted argument content so policy regexes evaluate command structure only.
 *
 * This prevents false positives like `grep -r "rm -rf" .` where dangerous text
 * appears as inert data, not an executable command segment.
 *
 * @param command - Raw command text
 * @returns Command text with quoted content replaced by spaces
 */
export function stripQuotedContent(command: string): string {
	let activeQuote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let output = "";

	for (const char of command) {
		if (activeQuote) {
			if (activeQuote !== "'" && char === "\\" && !escaped) {
				escaped = true;
				output += " ";
				continue;
			}
			if (char === activeQuote && !escaped) {
				activeQuote = undefined;
				output += " ";
				continue;
			}
			escaped = false;
			output += " ";
			continue;
		}

		if (char === "'" || char === '"' || char === "`") {
			activeQuote = char;
			output += " ";
			continue;
		}

		output += char;
	}

	return output;
}

/**
 * Check whether a command matches unconditional denylist patterns.
 *
 * @param command - Command text to evaluate
 * @returns True when command is always blocked
 */
export function isDenied(command: string): boolean {
	const normalized = command.trim();
	if (!normalized) return false;
	const policyInput = stripQuotedContent(normalized);
	return ALWAYS_BLOCK_PATTERNS.some((pattern) => pattern.test(policyInput));
}

/**
 * Check whether a command matches high-risk patterns.
 *
 * @param command - Command text to evaluate
 * @returns True when command requires explicit confirmation for explicit sources
 */
export function isHighRisk(command: string): boolean {
	const normalized = command.trim();
	if (!normalized) return false;
	const policyInput = stripQuotedContent(normalized);
	return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(policyInput));
}

/**
 * Check whether implicit shell interpolation is enabled.
 *
 * Enable via either:
 * - TALLOW_ENABLE_SHELL_INTERPOLATION=1
 * - TALLOW_SHELL_INTERPOLATION=1 (legacy alias)
 * - settings.json: { "shellInterpolation": true }
 * - settings.json: { "shellInterpolation": { "enabled": true } }
 *
 * Project `.tallow/settings.json` values are honored only when the project
 * trust status is `trusted`.
 *
 * @param cwd - Current working directory (used for project settings lookup)
 * @returns True when interpolation is explicitly enabled
 */
export function isShellInterpolationEnabled(cwd: string = process.cwd()): boolean {
	if (process.env.TALLOW_ENABLE_SHELL_INTERPOLATION === "1") return true;
	if (process.env.TALLOW_SHELL_INTERPOLATION === "1") return true;

	const globalSettingsPath = join(homedir(), ".tallow", "settings.json");
	const settingsPaths = isProjectTrusted()
		? [join(cwd, ".tallow", "settings.json"), globalSettingsPath]
		: [globalSettingsPath];

	for (const settingsPath of settingsPaths) {
		const value = readShellInterpolationSetting(settingsPath);
		if (value !== null) return value;
	}

	return false;
}

/**
 * Read shellInterpolation setting from a settings.json file.
 *
 * @param settingsPath - Absolute settings file path
 * @returns Boolean when configured, null when absent/unreadable
 */
function readShellInterpolationSetting(settingsPath: string): boolean | null {
	if (!existsSync(settingsPath)) return null;
	try {
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as {
			shellInterpolation?: boolean | { enabled?: boolean };
		};
		if (typeof settings.shellInterpolation === "boolean") {
			return settings.shellInterpolation;
		}
		if (
			typeof settings.shellInterpolation === "object" &&
			settings.shellInterpolation !== null &&
			typeof settings.shellInterpolation.enabled === "boolean"
		) {
			return settings.shellInterpolation.enabled;
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Check whether non-interactive high-risk command bypass is enabled.
 *
 * @returns True when TALLOW_ALLOW_UNSAFE_SHELL=1
 */
export function isNonInteractiveBypassEnabled(): boolean {
	return process.env.TALLOW_ALLOW_UNSAFE_SHELL === "1";
}

/**
 * Evaluate command against centralized policy rules.
 *
 * @param command - Raw command text
 * @param source - Command source
 * @param cwd - Working directory
 * @returns Policy verdict with allow/block/confirm decision
 */
export function evaluateCommand(
	command: string,
	source: ShellSource,
	cwd: string
): ShellPolicyVerdict {
	const trustLevel = getTrustLevel(source);
	const normalizedCommand = command.trim();

	if (!normalizedCommand) {
		return {
			allowed: false,
			requiresConfirmation: false,
			trustLevel,
			reason: "Command is empty",
			normalizedCommand,
		};
	}

	if (!isAbsolute(cwd)) {
		return {
			allowed: false,
			requiresConfirmation: false,
			trustLevel,
			reason: `Invalid cwd: ${cwd}`,
			normalizedCommand,
		};
	}

	if (isDenied(normalizedCommand)) {
		return {
			allowed: false,
			requiresConfirmation: false,
			trustLevel,
			reason: "Command matches denylist",
			normalizedCommand,
		};
	}

	// ── User permission rules (after hardcoded denylist, before trust-level logic) ──
	const permissions = getPermissions(cwd);
	if (
		permissions.merged.deny.length > 0 ||
		permissions.merged.ask.length > 0 ||
		permissions.merged.allow.length > 0
	) {
		const vars = buildExpansionVars(cwd);
		const settingsDir = join(cwd, ".tallow");
		const verdict = evaluatePermission(
			"bash",
			{ command: normalizedCommand },
			permissions.merged,
			vars,
			settingsDir
		);

		if (verdict.action === "deny") {
			return {
				allowed: false,
				requiresConfirmation: false,
				trustLevel,
				reason: verdict.reason ?? "Blocked by permission rule",
				normalizedCommand,
			};
		}

		if (verdict.action === "ask") {
			return {
				allowed: true,
				requiresConfirmation: true,
				trustLevel,
				reason: verdict.reason ?? "Requires confirmation per permission rule",
				normalizedCommand,
			};
		}

		if (verdict.action === "allow") {
			// Explicit allow skips trust-level prompting
			return {
				allowed: true,
				requiresConfirmation: false,
				trustLevel,
				reason: verdict.reason,
				normalizedCommand,
			};
		}

		// "default" — fall through to trust-level logic
	}

	if (trustLevel === "internal") {
		const commandName = normalizedCommand.split(/\s+/)[0] ?? "";
		if (!INTERNAL_COMMAND_ALLOWLIST.has(commandName)) {
			return {
				allowed: false,
				requiresConfirmation: false,
				trustLevel,
				reason: `Internal command not allowlisted: ${commandName}`,
				normalizedCommand,
			};
		}
		return {
			allowed: true,
			requiresConfirmation: false,
			trustLevel,
			normalizedCommand,
		};
	}

	if (trustLevel === "implicit") {
		if (!isShellInterpolationEnabled(cwd)) {
			return {
				allowed: false,
				requiresConfirmation: false,
				trustLevel,
				reason: "Shell interpolation is disabled",
				normalizedCommand,
			};
		}

		if (IMPLICIT_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalizedCommand))) {
			return {
				allowed: false,
				requiresConfirmation: false,
				trustLevel,
				reason: "Implicit command contains forbidden shell operators",
				normalizedCommand,
			};
		}

		if (!IMPLICIT_ALLOWLIST.some((pattern) => pattern.test(normalizedCommand))) {
			return {
				allowed: false,
				requiresConfirmation: false,
				trustLevel,
				reason: "Implicit command is not allowlisted",
				normalizedCommand,
			};
		}

		if (isHighRisk(normalizedCommand)) {
			return {
				allowed: false,
				requiresConfirmation: false,
				trustLevel,
				reason: "High-risk commands are blocked for implicit execution",
				normalizedCommand,
			};
		}

		return {
			allowed: true,
			requiresConfirmation: false,
			trustLevel,
			normalizedCommand,
		};
	}

	if (isHighRisk(normalizedCommand)) {
		return {
			allowed: true,
			requiresConfirmation: true,
			trustLevel,
			reason: "Command matches high-risk pattern",
			normalizedCommand,
		};
	}

	return {
		allowed: true,
		requiresConfirmation: false,
		trustLevel,
		normalizedCommand,
	};
}

/**
 * Enforce explicit-command policy for bash/bg_bash tool calls.
 *
 * @param command - Command text
 * @param source - Explicit source (bash or bg_bash)
 * @param cwd - Working directory
 * @param interactive - Whether interactive confirmation is available
 * @param confirmFn - Confirmation callback for high-risk commands
 * @returns Block object when denied, otherwise undefined
 */
export async function enforceExplicitPolicy(
	command: string,
	source: "bash" | "bg_bash",
	cwd: string,
	interactive: boolean,
	confirmFn: (message: string) => Promise<boolean | undefined>
): Promise<{ block: true; reason: string } | undefined> {
	const verdict = evaluateCommand(command, source, cwd);
	if (!verdict.allowed) {
		recordAudit({
			timestamp: Date.now(),
			command: verdict.normalizedCommand,
			source,
			trustLevel: verdict.trustLevel,
			cwd,
			outcome: "blocked",
			reason: verdict.reason,
		});
		return { block: true, reason: verdict.reason ?? "Blocked by shell policy" };
	}

	if (!verdict.requiresConfirmation) {
		recordAudit({
			timestamp: Date.now(),
			command: verdict.normalizedCommand,
			source,
			trustLevel: verdict.trustLevel,
			cwd,
			outcome: "allowed",
		});
		return undefined;
	}

	if (!interactive) {
		if (!isNonInteractiveBypassEnabled()) {
			recordAudit({
				timestamp: Date.now(),
				command: verdict.normalizedCommand,
				source,
				trustLevel: verdict.trustLevel,
				cwd,
				outcome: "blocked",
				reason: "High-risk command requires TALLOW_ALLOW_UNSAFE_SHELL=1 in non-interactive mode",
			});
			return {
				block: true,
				reason:
					"High-risk command blocked in non-interactive mode. Set TALLOW_ALLOW_UNSAFE_SHELL=1 to allow.",
			};
		}

		recordAudit({
			timestamp: Date.now(),
			command: verdict.normalizedCommand,
			source,
			trustLevel: verdict.trustLevel,
			cwd,
			outcome: "bypassed",
			reason: "Non-interactive bypass enabled",
		});
		return undefined;
	}

	let confirmed: boolean | undefined;
	try {
		confirmed = await confirmFn(
			`High-risk shell command detected:\n\n${verdict.normalizedCommand}\n\nRun this command?`
		);
	} catch (error) {
		const reason =
			error instanceof Error
				? `Confirmation interrupted: ${error.message}`
				: "Confirmation interrupted";
		recordAudit({
			timestamp: Date.now(),
			command: verdict.normalizedCommand,
			source,
			trustLevel: verdict.trustLevel,
			cwd,
			outcome: "blocked",
			reason,
		});
		return { block: true, reason };
	}

	if (confirmed !== true) {
		const reason =
			confirmed === false ? "User denied high-risk command" : "Confirmation was canceled";
		recordAudit({
			timestamp: Date.now(),
			command: verdict.normalizedCommand,
			source,
			trustLevel: verdict.trustLevel,
			cwd,
			outcome: "blocked",
			reason,
		});
		return { block: true, reason };
	}

	recordAudit({
		timestamp: Date.now(),
		command: verdict.normalizedCommand,
		source,
		trustLevel: verdict.trustLevel,
		cwd,
		outcome: "confirmed",
	});
	return undefined;
}

/**
 * Enforce implicit-command policy for shell interpolation paths.
 *
 * @param command - Command text
 * @param source - Implicit source (shell-interpolation or context-fork)
 * @param cwd - Working directory
 * @returns Allow/deny decision with optional reason
 */
export function enforceImplicitPolicy(
	command: string,
	source: "shell-interpolation" | "context-fork",
	cwd: string
): { allowed: boolean; reason?: string } {
	const verdict = evaluateCommand(command, source, cwd);
	recordAudit({
		timestamp: Date.now(),
		command: verdict.normalizedCommand,
		source,
		trustLevel: verdict.trustLevel,
		cwd,
		outcome: verdict.allowed ? "allowed" : "blocked",
		reason: verdict.reason,
	});
	return { allowed: verdict.allowed, reason: verdict.reason };
}

/**
 * Run a non-shell process with centralized policy and audit logging.
 *
 * @param options - Process invocation options
 * @returns Structured process result including policy-blocked state
 */
export function runCommandSync(options: RunCommandOptions): ProcessRunResult {
	const commandLine = [options.command, ...options.args].join(" ").trim();
	const verdict = evaluateCommand(commandLine, options.source, options.cwd);
	if (!verdict.allowed) {
		recordAudit({
			timestamp: Date.now(),
			command: verdict.normalizedCommand,
			source: options.source,
			trustLevel: verdict.trustLevel,
			cwd: options.cwd,
			outcome: "blocked",
			reason: verdict.reason,
		});
		return {
			ok: false,
			blocked: true,
			stdout: "",
			stderr: "",
			exitCode: null,
			reason: verdict.reason,
		};
	}

	const timeoutMs = clampTimeout(options.timeoutMs);
	const startedAt = Date.now();
	const result = spawnSync(options.command, [...options.args], {
		cwd: options.cwd,
		encoding: "utf-8",
		timeout: timeoutMs,
		maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const stdout = (result.stdout ?? "").toString();
	const stderr = (result.stderr ?? "").toString();
	const exitCode = result.status ?? null;
	const durationMs = Date.now() - startedAt;

	if (result.error || exitCode !== 0) {
		recordAudit({
			timestamp: Date.now(),
			command: verdict.normalizedCommand,
			source: options.source,
			trustLevel: verdict.trustLevel,
			cwd: options.cwd,
			outcome: "failed",
			reason: result.error?.message,
			exitCode,
			durationMs,
		});
		return {
			ok: false,
			blocked: false,
			stdout,
			stderr,
			exitCode,
			reason: result.error?.message,
		};
	}

	recordAudit({
		timestamp: Date.now(),
		command: verdict.normalizedCommand,
		source: options.source,
		trustLevel: verdict.trustLevel,
		cwd: options.cwd,
		outcome: "executed",
		exitCode,
		durationMs,
	});

	return {
		ok: true,
		blocked: false,
		stdout,
		stderr,
		exitCode,
	};
}

/**
 * Run a git command through centralized policy and process wrapper.
 *
 * @param args - Git arguments
 * @param cwd - Working directory
 * @param timeoutMs - Optional timeout override
 * @returns Trimmed stdout on success, null otherwise
 */
export function runGitCommandSync(
	args: readonly string[],
	cwd: string,
	timeoutMs?: number
): string | null {
	const result = runCommandSync({
		command: "git",
		args,
		cwd,
		source: "git-helper",
		timeoutMs,
	});
	if (!result.ok) return null;
	return result.stdout.trim();
}

/**
 * Check whether an executable exists on PATH using policy-wrapped process execution.
 *
 * @param executable - Executable to resolve via `which`
 * @param cwd - Working directory
 * @returns True when executable is found
 */
export function commandExistsOnPath(executable: string, cwd: string): boolean {
	const result = runCommandSync({
		command: "which",
		args: [executable],
		cwd,
		source: "git-helper",
		timeoutMs: 1500,
	});
	return result.ok;
}

/**
 * Run a shell command string for implicit interpolation paths.
 *
 * Uses `bash -lc` intentionally to preserve command semantics expected by
 * interpolation syntax. This is the only place where `-c` is used, and it is
 * guarded by explicit policy checks.
 *
 * @param options - Shell command execution options
 * @returns Structured execution result
 */
export function runShellCommandSync(options: RunShellCommandOptions): ProcessRunResult {
	const trimmed = options.command.trim();
	if (!trimmed) {
		return {
			ok: false,
			blocked: true,
			stdout: "",
			stderr: "",
			exitCode: null,
			reason: "Command is empty",
		};
	}

	if (options.enforcePolicy === true) {
		const verdict = evaluateCommand(trimmed, options.source, options.cwd);
		if (!verdict.allowed) {
			recordAudit({
				timestamp: Date.now(),
				command: verdict.normalizedCommand,
				source: options.source,
				trustLevel: verdict.trustLevel,
				cwd: options.cwd,
				outcome: "blocked",
				reason: verdict.reason,
			});
			return {
				ok: false,
				blocked: true,
				stdout: "",
				stderr: "",
				exitCode: null,
				reason: verdict.reason,
			};
		}
	}

	const shell = process.env.SHELL || "/bin/bash";
	const startedAt = Date.now();
	const result = spawnSync(shell, ["-lc", trimmed], {
		cwd: options.cwd,
		encoding: "utf-8",
		timeout: clampTimeout(options.timeoutMs),
		maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const stdout = (result.stdout ?? "").toString();
	const stderr = (result.stderr ?? "").toString();
	const exitCode = result.status ?? null;
	const durationMs = Date.now() - startedAt;

	if (result.error || exitCode !== 0) {
		recordAudit({
			timestamp: Date.now(),
			command: trimmed,
			source: options.source,
			trustLevel: getTrustLevel(options.source),
			cwd: options.cwd,
			outcome: "failed",
			reason: result.error?.message,
			exitCode,
			durationMs,
		});
		return {
			ok: false,
			blocked: false,
			stdout,
			stderr,
			exitCode,
			reason: result.error?.message,
		};
	}

	recordAudit({
		timestamp: Date.now(),
		command: trimmed,
		source: options.source,
		trustLevel: getTrustLevel(options.source),
		cwd: options.cwd,
		outcome: "executed",
		exitCode,
		durationMs,
	});

	return {
		ok: true,
		blocked: false,
		stdout,
		stderr,
		exitCode,
	};
}
