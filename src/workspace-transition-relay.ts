/**
 * Unix-socket relay for workspace transitions.
 *
 * The parent interactive session starts a relay server. Child processes
 * (subagents, headless runs) inherit the socket path via env and can
 * request workspace transitions through it. The parent handles approval
 * UI and session recreation; the child just waits for the result.
 */

import { existsSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getWorkspaceTransitionHost,
	type WorkspaceTransitionResult,
	type WorkspaceTransitionUI,
} from "./workspace-transition.js";

/** Env var holding the parent relay socket path for child processes. */
export const TRANSITION_RELAY_SOCKET_ENV = "TALLOW_TRANSITION_RELAY_SOCKET";

/** Timeout for relay client requests in milliseconds. */
const RELAY_REQUEST_TIMEOUT_MS = 60_000;

/** Wire format for relay requests (newline-delimited JSON). */
interface RelayRequestPayload {
	readonly type: "workspace_transition";
	readonly sourceCwd: string;
	readonly targetCwd: string;
	readonly initiator: "command" | "tool";
}

/**
 * Handle a single relay connection's request line.
 *
 * @param rawLine - JSON-encoded relay request
 * @param conn - Client socket for writing the response
 * @param getUI - Factory returning the parent-side UI surface
 * @returns Nothing
 */
async function handleRelayConnection(
	rawLine: string,
	conn: Socket,
	getUI: () => WorkspaceTransitionUI
): Promise<void> {
	let result: WorkspaceTransitionResult;
	try {
		const request = JSON.parse(rawLine) as RelayRequestPayload;
		if (request.type !== "workspace_transition") {
			result = { status: "unavailable", reason: "Unknown relay request type." };
		} else {
			const host = getWorkspaceTransitionHost();
			if (!host) {
				result = { status: "unavailable", reason: "No workspace-transition host available." };
			} else {
				result = await host.requestTransition({
					initiator: request.initiator,
					sourceCwd: request.sourceCwd,
					targetCwd: request.targetCwd,
					ui: getUI(),
				});
			}
		}
	} catch (error) {
		result = {
			status: "unavailable",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	try {
		conn.write(`${JSON.stringify(result)}\n`);
	} catch {
		// Connection may have been closed by the client.
	}
}

/**
 * Start a Unix-socket relay server for workspace transitions.
 *
 * Called by the parent interactive session. Child processes discover the
 * socket path via `TALLOW_TRANSITION_RELAY_SOCKET` and connect to request
 * transitions.
 *
 * @param getUI - Factory returning the parent-side UI for approval prompts
 * @returns Socket path and cleanup function
 */
export function createTransitionRelayServer(getUI: () => WorkspaceTransitionUI): {
	readonly socketPath: string;
	readonly cleanup: () => void;
} {
	const socketPath = join(tmpdir(), `tallow-relay-${process.pid}.sock`);

	// Remove stale socket from a crashed session.
	try {
		if (existsSync(socketPath)) unlinkSync(socketPath);
	} catch {
		// Best-effort.
	}

	const server: Server = createServer((conn) => {
		let buffer = "";
		conn.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const idx = buffer.indexOf("\n");
			if (idx === -1) return;
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			handleRelayConnection(line, conn, getUI);
		});
	});

	server.listen(socketPath);
	process.env[TRANSITION_RELAY_SOCKET_ENV] = socketPath;

	return {
		socketPath,
		cleanup: () => {
			delete process.env[TRANSITION_RELAY_SOCKET_ENV];
			server.close();
			try {
				unlinkSync(socketPath);
			} catch {
				// Best-effort.
			}
		},
	};
}

/**
 * Read the relay socket path from the environment.
 *
 * @returns Socket path when a parent relay is available, otherwise undefined
 */
export function getRelaySocketPath(): string | undefined {
	return process.env[TRANSITION_RELAY_SOCKET_ENV];
}

/**
 * Request a workspace transition via the parent session's relay server.
 *
 * @param socketPath - Unix socket path of the relay server
 * @param sourceCwd - Current working directory before transition
 * @param targetCwd - Target working directory after transition
 * @param initiator - Whether the request came from a command or tool
 * @returns Transition result from the parent session
 */
export function requestTransitionViaRelay(
	socketPath: string,
	sourceCwd: string,
	targetCwd: string,
	initiator: "command" | "tool"
): Promise<WorkspaceTransitionResult> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const settle = (result: WorkspaceTransitionResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};

		const client = connect(socketPath);

		timer = setTimeout(() => {
			client.destroy();
			settle({ status: "unavailable", reason: "Relay request timed out." });
		}, RELAY_REQUEST_TIMEOUT_MS);

		client.on("connect", () => {
			const payload: RelayRequestPayload = {
				type: "workspace_transition",
				initiator,
				sourceCwd,
				targetCwd,
			};
			client.write(`${JSON.stringify(payload)}\n`);
		});

		let buffer = "";
		client.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const idx = buffer.indexOf("\n");
			if (idx === -1) return;
			const line = buffer.slice(0, idx);
			client.end();
			try {
				settle(JSON.parse(line) as WorkspaceTransitionResult);
			} catch {
				settle({ status: "unavailable", reason: "Invalid relay response." });
			}
		});

		client.on("error", (error: Error) => {
			settle({
				status: "unavailable",
				reason: `Relay connection failed: ${error.message}`,
			});
		});
	});
}
