/**
 * WezTerm Agent Status Extension
 *
 * Signals agent lifecycle status to WezTerm via OSC 1337 SetUserVar sequences.
 * WezTerm Lua config reads `pi_status` from `pane:get_user_vars()` to drive
 * tab bar indicators — a spinner while the agent is working, and a color
 * change when it finishes.
 *
 * Gated behind `WEZTERM_PANE` — silent no-op outside WezTerm.
 *
 * A heartbeat (`pi_heartbeat`) fires every 500ms while the agent is working
 * to trigger WezTerm's `update-right-status` event, which advances spinner
 * frames in the tab title formatter.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** WezTerm user-var key for status updates. */
const STATUS_VAR_NAME = "pi_status";
/** WezTerm user-var key used to drive spinner animation ticks. */
const HEARTBEAT_VAR_NAME = "pi_heartbeat";
/** Heartbeat period in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 500;

/** Allowed status values written to `pi_status`. */
export type WeztermStatus = "" | "done" | "working";

/** Callback that starts a recurring heartbeat and returns a cleanup function. */
export type WeztermHeartbeatStarter = (tick: () => void) => () => void;

/** Dependencies for the wezterm lifecycle controller. */
export interface WeztermNotifyLifecycleDeps {
	readonly setUserVar: (name: string, value: string) => void;
	readonly startHeartbeat: WeztermHeartbeatStarter;
}

/** Lifecycle handlers used by the extension event registrations. */
export interface WeztermNotifyLifecycle {
	onAgentEnd: () => void;
	onAgentStart: () => void;
	onBeforeAgentStart: () => void;
	onInput: () => { action: "continue" };
	onSessionShutdown: () => void;
	onSessionStart: () => void;
}

/**
 * Set a WezTerm user variable via OSC 1337 escape sequence.
 * WezTerm reads these in format-tab-title via `pane:get_user_vars()`.
 *
 * @param name - Variable name (e.g. `pi_status`)
 * @param value - Variable value (will be base64-encoded)
 * @returns Nothing
 */
function setWezTermUserVar(name: string, value: string): void {
	const encoded = Buffer.from(value).toString("base64");
	process.stdout.write(`\x1b]1337;SetUserVar=${name}=${encoded}\x07`);
}

/**
 * Start a periodic heartbeat timer.
 *
 * @param tick - Called for each heartbeat frame
 * @returns Cleanup function to stop the timer
 */
export function startIntervalHeartbeat(tick: () => void): () => void {
	const interval = setInterval(() => {
		tick();
	}, HEARTBEAT_INTERVAL_MS);

	return () => {
		clearInterval(interval);
	};
}

/**
 * Create lifecycle handlers that coalesce redundant status writes and avoid
 * restarting heartbeat timers during duplicate lifecycle events.
 *
 * @param deps - User-var writer and heartbeat starter
 * @returns Lifecycle handlers for extension events
 */
export function createWeztermNotifyLifecycle(
	deps: WeztermNotifyLifecycleDeps
): WeztermNotifyLifecycle {
	let heartbeatFrame = 0;
	let isWorking = false;
	let lastStatus: WeztermStatus | null = null;
	let stopHeartbeat: (() => void) | null = null;

	/**
	 * Emit one heartbeat frame and increment the frame counter.
	 *
	 * @returns Nothing
	 */
	const emitHeartbeatFrame = (): void => {
		deps.setUserVar(HEARTBEAT_VAR_NAME, String(heartbeatFrame));
		heartbeatFrame += 1;
	};

	/**
	 * Write status only when it changes.
	 *
	 * @param nextStatus - Status value to emit
	 * @returns Nothing
	 */
	const setStatus = (nextStatus: WeztermStatus): void => {
		if (lastStatus === nextStatus) {
			return;
		}

		deps.setUserVar(STATUS_VAR_NAME, nextStatus);
		lastStatus = nextStatus;
	};

	/**
	 * Start heartbeat if not already running and emit an immediate first tick.
	 *
	 * @returns Nothing
	 */
	const ensureHeartbeatRunning = (): void => {
		if (stopHeartbeat) {
			return;
		}

		heartbeatFrame = 0;
		emitHeartbeatFrame();
		stopHeartbeat = deps.startHeartbeat(() => {
			emitHeartbeatFrame();
		});
	};

	/**
	 * Stop the active heartbeat timer if present.
	 *
	 * @returns Nothing
	 */
	const stopHeartbeatIfRunning = (): void => {
		if (!stopHeartbeat) {
			return;
		}

		const stop = stopHeartbeat;
		stopHeartbeat = null;
		stop();
	};

	/**
	 * Enter working state (idempotent).
	 *
	 * @returns Nothing
	 */
	const enterWorking = (): void => {
		isWorking = true;
		setStatus("working");
		ensureHeartbeatRunning();
	};

	/**
	 * Leave working state and set final status.
	 *
	 * @param finalStatus - Status to publish after cleanup
	 * @returns Nothing
	 */
	const leaveWorking = (finalStatus: WeztermStatus): void => {
		isWorking = false;
		stopHeartbeatIfRunning();
		setStatus(finalStatus);
	};

	return {
		onBeforeAgentStart: () => {
			enterWorking();
		},
		onAgentStart: () => {
			enterWorking();
		},
		onAgentEnd: () => {
			leaveWorking("done");
		},
		onInput: () => {
			if (!isWorking) {
				leaveWorking("");
			}

			return { action: "continue" as const };
		},
		onSessionStart: () => {
			leaveWorking("");
		},
		onSessionShutdown: () => {
			leaveWorking("");
		},
	};
}

/**
 * Register event handlers to signal agent lifecycle status to WezTerm.
 * Only activates when `WEZTERM_PANE` is set.
 *
 * @param pi - Extension API for registering event handlers
 * @returns Nothing
 */
export default function weztermNotify(pi: ExtensionAPI): void {
	if (!process.env.WEZTERM_PANE) {
		return;
	}

	const lifecycle = createWeztermNotifyLifecycle({
		setUserVar: setWezTermUserVar,
		startHeartbeat: startIntervalHeartbeat,
	});

	pi.on("before_agent_start", () => {
		lifecycle.onBeforeAgentStart();
	});

	pi.on("agent_start", () => {
		lifecycle.onAgentStart();
	});

	pi.on("agent_end", () => {
		lifecycle.onAgentEnd();
	});

	pi.on("input", () => {
		return lifecycle.onInput();
	});

	pi.on("session_start", () => {
		lifecycle.onSessionStart();
	});

	pi.on("session_shutdown", () => {
		lifecycle.onSessionShutdown();
	});
}
