/**
 * Core types for the teams extension.
 * Pure interfaces with no runtime dependencies.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { InteropTeamView } from "../../_shared/interop-events.js";

/**
 * Runtime teammate with an active agent session.
 * Extends the store-level TeammateRecord with session lifecycle.
 */
export interface Teammate {
	name: string;
	role: string;
	model: string;
	session: AgentSession;
	status: "idle" | "working" | "shutdown" | "error";
	error?: string;
	lastActivity?: string;
	unsubscribe?: () => void;
}

/** Serializable view of a team for cross-extension widget rendering. */
export type TeamView = InteropTeamView;
