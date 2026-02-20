/**
 * WezTerm Turn Status Extension
 *
 * Signals agent turn status to WezTerm via OSC 1337 SetUserVar sequences.
 * WezTerm Lua config reads `pi_status` from `pane:get_user_vars()` to drive
 * tab bar indicators — a spinner while the agent is working, and a color
 * change when it finishes.
 *
 * Gated behind `WEZTERM_PANE` — silent no-op outside WezTerm.
 *
 * A heartbeat (pi_heartbeat) fires every 500ms during a turn to trigger
 * WezTerm's `update-right-status` event, which advances the spinner frame.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Set a WezTerm user variable via OSC 1337 escape sequence.
 * WezTerm reads these in format-tab-title via `pane:get_user_vars()`.
 *
 * @param name - Variable name (e.g. "pi_status")
 * @param value - Variable value (will be base64-encoded)
 */
function setWezTermUserVar(name: string, value: string): void {
	const encoded = Buffer.from(value).toString("base64");
	process.stdout.write(`\x1b]1337;SetUserVar=${name}=${encoded}\x07`);
}

/**
 * Start a heartbeat that re-emits pi_heartbeat every 500ms.
 * Each write triggers WezTerm to re-render the tab bar, driving the
 * spinner animation in format-tab-title.
 *
 * @returns Cleanup function to stop the heartbeat
 */
function startHeartbeat(): () => void {
	let frame = 0;
	const interval = setInterval(() => {
		setWezTermUserVar("pi_heartbeat", String(frame++));
	}, 500);
	return () => clearInterval(interval);
}

/**
 * Register event handlers to signal turn status to WezTerm.
 * Only activates when `WEZTERM_PANE` is set.
 *
 * @param pi - Extension API for registering event handlers
 */
export default function weztermNotify(pi: ExtensionAPI): void {
	if (!process.env.WEZTERM_PANE) {
		return;
	}

	let stopHeartbeat: (() => void) | null = null;

	pi.on("turn_start", async () => {
		setWezTermUserVar("pi_status", "working");
		stopHeartbeat?.();
		stopHeartbeat = startHeartbeat();
	});

	pi.on("turn_end", async () => {
		stopHeartbeat?.();
		stopHeartbeat = null;
		setWezTermUserVar("pi_status", "done");
	});

	pi.on("input", async () => {
		stopHeartbeat?.();
		stopHeartbeat = null;
		setWezTermUserVar("pi_status", "");
		return { action: "continue" as const };
	});

	pi.on("session_start", async () => {
		stopHeartbeat?.();
		stopHeartbeat = null;
		setWezTermUserVar("pi_status", "");
	});

	pi.on("session_shutdown", async () => {
		stopHeartbeat?.();
		stopHeartbeat = null;
		setWezTermUserVar("pi_status", "");
	});
}
