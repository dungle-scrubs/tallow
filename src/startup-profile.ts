/** Startup profile for session initialization behavior. */
export type StartupProfile = "interactive" | "headless";

/**
 * Inputs used to resolve the startup profile for a CLI invocation.
 */
export interface StartupProfileResolutionInput {
	/** True when invocation will run a one-shot prompt path. */
	readonly hasPrintInput: boolean;
	/** Requested CLI mode (interactive, json, rpc, etc.). */
	readonly mode: string;
}

/**
 * Normalize an optional startup profile value.
 *
 * @param profile - Requested startup profile
 * @returns Resolved startup profile (defaults to "interactive")
 */
export function normalizeStartupProfile(profile: StartupProfile | undefined): StartupProfile {
	return profile ?? "interactive";
}

/**
 * Resolve startup profile from CLI mode and input routing.
 *
 * Headless profile is used for non-TUI execution paths:
 * - `--mode json`
 * - `--mode rpc`
 * - interactive mode with `-p` and/or piped stdin (print mode path)
 *
 * @param input - CLI routing inputs
 * @returns Startup profile for session initialization
 */
export function resolveStartupProfile(input: StartupProfileResolutionInput): StartupProfile {
	if (input.mode === "json" || input.mode === "rpc") {
		return "headless";
	}

	if (input.mode === "interactive" && input.hasPrintInput) {
		return "headless";
	}

	return "interactive";
}
