/** Candidate executable for spawning an agent subprocess. */
export interface AgentRunnerCandidate {
	readonly command: string;
	readonly preArgs: readonly string[];
	readonly source: string;
}

/** Options for resolving agent runner candidates. */
export interface AgentRunnerResolutionOptions {
	/** Environment variable name used for explicit runner overrides. */
	readonly overrideEnvVar: string;
	/** Primary command name expected on PATH (for example `tallow`). */
	readonly primaryCommand?: string;
	/** Legacy fallback command names, tried after the primary command. */
	readonly legacyCommands?: readonly string[];
	/** Entry-point suffixes considered equivalent to the primary command. */
	readonly entrypointSuffixes?: readonly string[];
	/** Process env used for override lookups. Defaults to process.env. */
	readonly env?: NodeJS.ProcessEnv;
	/** Process argv used for current-process detection. Defaults to process.argv. */
	readonly argv?: readonly string[];
	/** Node executable path used for JS entrypoints. Defaults to process.execPath. */
	readonly execPath?: string;
}

/** Default primary command for tallow agent subprocesses. */
const DEFAULT_PRIMARY_COMMAND = "tallow";
/** Default legacy fallback command for backward compatibility. */
const DEFAULT_LEGACY_COMMANDS = ["pi"] as const;
/** Default entrypoint suffixes that identify tallow CLI scripts. */
const DEFAULT_ENTRYPOINT_SUFFIXES = ["/dist/cli.js"] as const;

/**
 * Normalize path-like values for comparison.
 *
 * @param value - Input path or command token
 * @returns Lowercased slash-normalized value
 */
function normalizePathToken(value: string): string {
	return value.replace(/\\/g, "/").toLowerCase();
}

/**
 * Return true when an entrypoint points to the active tallow CLI.
 *
 * @param entrypoint - argv[1] value from current process
 * @param primaryCommand - Primary command name (for example `tallow`)
 * @param entrypointSuffixes - Known script suffixes for this CLI
 * @returns True when the entrypoint appears to belong to the target CLI
 */
function isCurrentCliEntrypoint(
	entrypoint: string,
	primaryCommand: string,
	entrypointSuffixes: readonly string[]
): boolean {
	const normalizedEntrypoint = normalizePathToken(entrypoint);
	const normalizedPrimary = normalizePathToken(primaryCommand);

	if (normalizedEntrypoint === normalizedPrimary) return true;
	if (normalizedEntrypoint.includes(`/${normalizedPrimary}`)) return true;
	return entrypointSuffixes.some((suffix) =>
		normalizedEntrypoint.endsWith(normalizePathToken(suffix))
	);
}

/**
 * Resolve a runner candidate representing the currently executing CLI.
 *
 * @param options - Resolver options
 * @returns Candidate when current process matches the target CLI, else null
 */
function resolveCurrentProcessCandidate(
	options: AgentRunnerResolutionOptions
): AgentRunnerCandidate | null {
	const argv = options.argv ?? process.argv;
	const entrypoint = argv[1];
	if (!entrypoint) {
		return null;
	}

	const primaryCommand = options.primaryCommand ?? DEFAULT_PRIMARY_COMMAND;
	const entrypointSuffixes = options.entrypointSuffixes ?? DEFAULT_ENTRYPOINT_SUFFIXES;
	if (!isCurrentCliEntrypoint(entrypoint, primaryCommand, entrypointSuffixes)) {
		return null;
	}

	if (/\.(c|m)?js$/i.test(entrypoint)) {
		return {
			command: options.execPath ?? process.execPath,
			preArgs: [entrypoint],
			source: "current process",
		};
	}

	return {
		command: entrypoint,
		preArgs: [],
		source: "current process",
	};
}

/**
 * Deduplicate candidates while preserving stable order.
 *
 * @param candidates - Candidate list in priority order
 * @returns Deduplicated list with the first occurrence retained
 */
function dedupeCandidates(candidates: readonly AgentRunnerCandidate[]): AgentRunnerCandidate[] {
	const deduped: AgentRunnerCandidate[] = [];
	const seen = new Set<string>();

	for (const candidate of candidates) {
		const key = `${candidate.command}\u0000${candidate.preArgs.join("\u0000")}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(candidate);
	}

	return deduped;
}

/**
 * Resolve agent runner candidates with explicit precedence.
 *
 * Precedence:
 * 1) explicit env override
 * 2) current process executable (when it is the target CLI)
 * 3) primary command on PATH
 * 4) legacy fallback commands on PATH
 *
 * @param options - Runner resolution options
 * @returns Runner candidates in priority order
 */
export function resolveAgentRunnerCandidates(
	options: AgentRunnerResolutionOptions
): AgentRunnerCandidate[] {
	const env = options.env ?? process.env;
	const primaryCommand = options.primaryCommand ?? DEFAULT_PRIMARY_COMMAND;
	const legacyCommands = options.legacyCommands ?? DEFAULT_LEGACY_COMMANDS;
	const overrideValue = env[options.overrideEnvVar]?.trim();
	const candidates: AgentRunnerCandidate[] = [];

	if (overrideValue) {
		candidates.push({
			command: overrideValue,
			preArgs: [],
			source: options.overrideEnvVar,
		});
	}

	const currentProcess = resolveCurrentProcessCandidate(options);
	if (currentProcess) {
		candidates.push(currentProcess);
	}

	candidates.push({ command: primaryCommand, preArgs: [], source: "PATH" });
	for (const legacyCommand of legacyCommands) {
		candidates.push({ command: legacyCommand, preArgs: [], source: "PATH" });
	}

	return dedupeCandidates(candidates);
}

/**
 * Build an actionable runner-resolution failure message.
 *
 * @param candidates - Candidate runners attempted in order
 * @param overrideEnvVar - Override env var name shown in guidance
 * @param lastError - Optional trailing spawn error message
 * @returns User-facing diagnostic message
 */
export function formatMissingAgentRunnerError(
	candidates: readonly AgentRunnerCandidate[],
	overrideEnvVar: string,
	lastError?: string
): string {
	const attempted =
		candidates.length > 0 ? candidates.map((candidate) => candidate.command).join(", ") : "(none)";
	const errorSuffix = lastError ? ` Last error: ${lastError}` : "";
	return `Hook agent runner not found. Tried: ${attempted}. Set ${overrideEnvVar} to a valid tallow binary.${errorSuffix}`;
}
