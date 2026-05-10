/**
 * tmux Agent Status Extension
 *
 * Signals agent lifecycle status to tmux via per-pane `@pi_status` options.
 * The tmux status bar reads these (aggregated per window) to drive tab
 * indicators — a working glyph while the agent is running, a done glyph
 * after the turn completes.
 *
 * Gated on `$TMUX` — silent no-op outside tmux.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** tmux per-pane option name. */
const STATUS_OPTION = "@pi_status";

/** Allowed status values written to `@pi_status`. */
export type TmuxStatus = "" | "done" | "working";

/** Lifecycle handlers used by the extension event registrations. */
export interface TmuxNotifyLifecycle {
	onAgentEnd: () => void;
	onAgentStart: () => void;
	onBeforeAgentStart: () => void;
	onInput: () => { action: "continue" };
	onSessionShutdown: () => void;
	onSessionStart: () => void;
}

/** Dependencies for the tmux lifecycle controller. */
export interface TmuxNotifyLifecycleDeps {
	readonly setStatus: (value: TmuxStatus) => void;
}

/**
 * Set a per-pane tmux user option for the current pane.
 * Fire-and-forget: errors are swallowed since terminal indicators are
 * a best-effort UX signal, not load-bearing state.
 *
 * @param value - Status string; empty string unsets the option.
 * @returns Nothing
 */
function setPaneStatus(value: TmuxStatus): void {
	const pane = process.env.TMUX_PANE;
	if (!pane) {
		return;
	}

	const args =
		value === ""
			? ["set-option", "-p", "-t", pane, "-u", STATUS_OPTION]
			: ["set-option", "-p", "-t", pane, STATUS_OPTION, value];

	try {
		const proc = spawn("tmux", args, { stdio: "ignore" });
		proc.on("error", () => {});
	} catch {
		// Ignore — tmux not on PATH or process spawn failed.
	}
}

/**
 * Create lifecycle handlers that coalesce redundant status writes.
 *
 * @param deps - Status writer
 * @returns Lifecycle handlers for extension events
 */
export function createTmuxNotifyLifecycle(deps: TmuxNotifyLifecycleDeps): TmuxNotifyLifecycle {
	let isWorking = false;
	let lastStatus: TmuxStatus | null = null;

	const setStatus = (next: TmuxStatus): void => {
		if (lastStatus === next) {
			return;
		}
		deps.setStatus(next);
		lastStatus = next;
	};

	const enterWorking = (): void => {
		isWorking = true;
		setStatus("working");
	};

	const leaveWorking = (final: TmuxStatus): void => {
		isWorking = false;
		setStatus(final);
	};

	return {
		onBeforeAgentStart: () => {
			enterWorking();
		},
		onAgentStart: () => {
			enterWorking();
		},
		onAgentEnd: () => {
			// Intentional no-op: tools may still be executing after the model
			// finishes generating (e.g. subagent parallel runs). Stay "working"
			// until the input prompt appears, which signals the turn is truly done.
		},
		onInput: () => {
			if (isWorking) {
				leaveWorking("done");
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
 * Register event handlers to signal agent lifecycle status to tmux.
 * Only activates when `$TMUX` is set.
 *
 * @param pi - Extension API for registering event handlers
 * @returns Nothing
 */
export default function tmuxNotify(pi: ExtensionAPI): void {
	if (!process.env.TMUX) {
		return;
	}

	const lifecycle = createTmuxNotifyLifecycle({ setStatus: setPaneStatus });

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
