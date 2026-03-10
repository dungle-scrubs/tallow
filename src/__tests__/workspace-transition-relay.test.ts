import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	registerWorkspaceTransitionHost,
	type WorkspaceTransitionRequest,
	type WorkspaceTransitionResult,
	type WorkspaceTransitionUI,
} from "../workspace-transition.js";
import {
	buildTransitionRelaySocketPath,
	createTransitionRelayServer,
	getRelaySocketPath,
	isFilesystemRelaySocketPath,
	requestTransitionViaRelay,
	TRANSITION_RELAY_SOCKET_ENV,
	tryCreateTransitionRelayServer,
} from "../workspace-transition-relay.js";

let originalEnv: string | undefined;
let transitionRequests: WorkspaceTransitionRequest[];
let transitionResult: WorkspaceTransitionResult;

/**
 * Create a minimal fake UI for relay server tests.
 *
 * @returns WorkspaceTransitionUI that auto-approves
 */
function createFakeUI(): WorkspaceTransitionUI {
	return {
		notify: () => {},
		async select(_title: string, options: string[]) {
			return options[0];
		},
		setWorkingMessage: () => {},
	};
}

/**
 * Build a definitely-missing relay endpoint for the current platform.
 *
 * @returns Missing IPC endpoint path
 */
function buildMissingRelaySocketPath(): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\nonexistent-tallow-relay-${Date.now()}`;
	}

	return `/tmp/nonexistent-tallow-relay-${Date.now()}.sock`;
}

beforeEach(() => {
	originalEnv = process.env[TRANSITION_RELAY_SOCKET_ENV];
	transitionRequests = [];
	transitionResult = { status: "completed", trustedOnEntry: true };
	registerWorkspaceTransitionHost({
		async requestTransition(request): Promise<WorkspaceTransitionResult> {
			transitionRequests.push(request);
			return transitionResult;
		},
	});
});

afterEach(() => {
	registerWorkspaceTransitionHost(null);
	if (originalEnv === undefined) {
		delete process.env[TRANSITION_RELAY_SOCKET_ENV];
	} else {
		process.env[TRANSITION_RELAY_SOCKET_ENV] = originalEnv;
	}
});

describe("workspace transition relay", () => {
	test("builds a Windows named-pipe endpoint on win32", () => {
		expect(buildTransitionRelaySocketPath("win32", 42)).toBe("\\\\.\\pipe\\tallow-relay-42");
	});

	test("builds a Unix socket path on non-Windows platforms", () => {
		expect(buildTransitionRelaySocketPath("darwin", 42, "/tmp/test-relay")).toBe(
			"/tmp/test-relay/tallow-relay-42.sock"
		);
	});

	test("distinguishes filesystem sockets from named pipes", () => {
		expect(isFilesystemRelaySocketPath("/tmp/tallow-relay-42.sock")).toBe(true);
		expect(isFilesystemRelaySocketPath("\\\\.\\pipe\\tallow-relay-42")).toBe(false);
	});

	test("relay startup helper returns null and clears env on startup failure", () => {
		process.env[TRANSITION_RELAY_SOCKET_ENV] = "stale";
		const reportedErrors: Error[] = [];

		const relay = tryCreateTransitionRelayServer(
			createFakeUI,
			(error) => {
				reportedErrors.push(error);
			},
			() => {
				throw new Error("boom");
			}
		);

		expect(relay).toBeNull();
		expect(process.env[TRANSITION_RELAY_SOCKET_ENV]).toBeUndefined();
		expect(reportedErrors).toHaveLength(1);
		expect(reportedErrors[0]?.message).toBe("boom");
	});

	test("server accepts connection and delegates to host", async () => {
		const { socketPath, cleanup } = createTransitionRelayServer(createFakeUI);
		try {
			const result = await requestTransitionViaRelay(socketPath, "/repo/a", "/repo/b", "tool");
			expect(result).toEqual({ status: "completed", trustedOnEntry: true });
			expect(transitionRequests).toHaveLength(1);
			expect(transitionRequests[0]?.targetCwd).toBe("/repo/b");
			expect(transitionRequests[0]?.sourceCwd).toBe("/repo/a");
			expect(transitionRequests[0]?.initiator).toBe("tool");
		} finally {
			cleanup();
		}
	});

	test("server sets env var and cleanup removes it", () => {
		const { socketPath, cleanup } = createTransitionRelayServer(createFakeUI);
		try {
			expect(getRelaySocketPath()).toBe(socketPath);
			if (isFilesystemRelaySocketPath(socketPath)) {
				expect(existsSync(socketPath)).toBe(true);
			}
		} finally {
			cleanup();
		}
		expect(getRelaySocketPath()).toBeUndefined();
	});

	test("client returns unavailable on connection error", async () => {
		const result = await requestTransitionViaRelay(
			buildMissingRelaySocketPath(),
			"/a",
			"/b",
			"tool"
		);
		expect(result.status).toBe("unavailable");
	});

	test("relay forwards cancelled result from host", async () => {
		transitionResult = { status: "cancelled" };
		const { socketPath, cleanup } = createTransitionRelayServer(createFakeUI);
		try {
			const result = await requestTransitionViaRelay(socketPath, "/a", "/b", "command");
			expect(result).toEqual({ status: "cancelled" });
		} finally {
			cleanup();
		}
	});

	test("relay returns unavailable when no host is registered", async () => {
		registerWorkspaceTransitionHost(null);
		const { socketPath, cleanup } = createTransitionRelayServer(createFakeUI);
		try {
			const result = await requestTransitionViaRelay(socketPath, "/a", "/b", "tool");
			expect(result.status).toBe("unavailable");
		} finally {
			cleanup();
		}
	});
});
