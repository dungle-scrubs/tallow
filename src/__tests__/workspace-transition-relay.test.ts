import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	registerWorkspaceTransitionHost,
	type WorkspaceTransitionRequest,
	type WorkspaceTransitionResult,
	type WorkspaceTransitionUI,
} from "../workspace-transition.js";
import {
	createTransitionRelayServer,
	getRelaySocketPath,
	requestTransitionViaRelay,
	TRANSITION_RELAY_SOCKET_ENV,
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
			expect(existsSync(socketPath)).toBe(true);
		} finally {
			cleanup();
		}
		expect(getRelaySocketPath()).toBeUndefined();
	});

	test("client returns unavailable on connection error", async () => {
		const result = await requestTransitionViaRelay(
			"/tmp/nonexistent-tallow-relay.sock",
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
