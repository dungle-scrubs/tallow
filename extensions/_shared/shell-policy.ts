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

/** Commands that are always denied regardless of trust level. */
const ALWAYS_BLOCK_PATTERNS: readonly RegExp[] = [
	/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
	/\brm\s+-\w*r\w*\s+\/(?:\*|\s|$)/, // rm -rf / and rm -rf /*
	/\bmkfs(\.\w+)?\b/i,
	/\bdd\b[^\n]*\bof\s*=\s*\/dev\/(sd|hd|nvme|loop|disk)\w*/i,
];

/** High-risk patterns: explicit sources require confirmation. */
const HIGH_RISK_PATTERNS: readonly RegExp[] = [
	/\brm\s+-\w*r\w*/i,
	/\bsudo\b/i,
	/\bcurl\b[^\n|]*\|\s*(ba)?sh\b/i,
	/\bwget\b[^\n|]*\|\s*(ba)?sh\b/i,
	/\bchmod\s+-R\s+777\b/i,
	/\bchown\s+-R\s+root\b/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-f[dDxX]*\b/i,
	/\bdd\s+if\s*=/i,
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
 * Check whether a command matches unconditional denylist patterns.
 *
 * @param command - Command text to evaluate
 * @returns True when command is always blocked
 */
export function isDenied(command: string): boolean {
	return ALWAYS_BLOCK_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Check whether a command matches high-risk patterns.
 *
 * @param command - Command text to evaluate
 * @returns True when command requires explicit confirmation for explicit sources
 */
export function isHighRisk(command: string): boolean {
	return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command));
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
 * @param cwd - Current working directory (used for project settings lookup)
 * @returns True when interpolation is explicitly enabled
 */
export function isShellInterpolationEnabled(cwd: string = process.cwd()): boolean {
	if (process.env.TALLOW_ENABLE_SHELL_INTERPOLATION === "1") return true;
	if (process.env.TALLOW_SHELL_INTERPOLATION === "1") return true;

	const projectSettingsPath = join(cwd, ".tallow", "settings.json");
	const globalSettingsPath = join(homedir(), ".tallow", "settings.json");

	for (const settingsPath of [projectSettingsPath, globalSettingsPath]) {
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
	confirmFn: (message: string) => Promise<boolean>
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

	const confirmed = await confirmFn(
		`High-risk shell command detected:\n\n${verdict.normalizedCommand}\n\nRun this command?`
	);
	if (!confirmed) {
		recordAudit({
			timestamp: Date.now(),
			command: verdict.normalizedCommand,
			source,
			trustLevel: verdict.trustLevel,
			cwd,
			outcome: "blocked",
			reason: "User denied high-risk command",
		});
		return { block: true, reason: "User denied high-risk command" };
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
