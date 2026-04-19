import { resetCapabilitiesCache } from "../terminal-image.js";

const CAPABILITY_ENV_KEYS = [
	"COLORTERM",
	"GHOSTTY_RESOURCES_DIR",
	"ITERM_SESSION_ID",
	"KITTY_WINDOW_ID",
	"TERM",
	"TERM_PROGRAM",
	"TMUX",
	"WEZTERM_PANE",
] as const;

type CapabilityEnvOverrides = Readonly<Record<string, string | undefined>>;

/**
 * Run a callback with controlled terminal capability environment variables.
 *
 * Resets the terminal capability cache before and after the callback so test
 * assertions always reflect the requested environment.
 *
 * @param overrides - Temporary environment variable overrides
 * @param run - Callback executed with overrides applied
 * @returns Callback return value
 */
export function withCapabilityEnv<T>(overrides: CapabilityEnvOverrides, run: () => T): T {
	const previous: Partial<Record<(typeof CAPABILITY_ENV_KEYS)[number], string | undefined>> = {};

	for (const key of CAPABILITY_ENV_KEYS) {
		previous[key] = process.env[key];
		if (Object.hasOwn(overrides, key)) {
			const value = overrides[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		} else {
			delete process.env[key];
		}
	}

	resetCapabilitiesCache();
	try {
		return run();
	} finally {
		for (const key of CAPABILITY_ENV_KEYS) {
			const value = previous[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		resetCapabilitiesCache();
	}
}
