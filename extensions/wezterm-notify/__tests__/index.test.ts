import { afterEach, describe, expect, it } from "bun:test";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import type { WeztermNotifyLifecycle, WeztermNotifyLifecycleDeps } from "../index.js";
import weztermNotify, { createWeztermNotifyLifecycle } from "../index.js";

const ORIGINAL_WEZTERM_PANE = process.env.WEZTERM_PANE;

interface UserVarWrite {
	readonly name: string;
	readonly value: string;
}

interface LifecycleRig {
	readonly activeHeartbeatCount: number;
	readonly heartbeatStartCount: number;
	readonly heartbeatStopCount: number;
	readonly lifecycle: WeztermNotifyLifecycle;
	readonly writes: UserVarWrite[];
	tickHeartbeat: () => void;
}

/**
 * Restore WEZTERM_PANE after each test.
 *
 * @returns Nothing
 */
afterEach(() => {
	if (ORIGINAL_WEZTERM_PANE === undefined) {
		delete process.env.WEZTERM_PANE;
		return;
	}

	process.env.WEZTERM_PANE = ORIGINAL_WEZTERM_PANE;
});

/**
 * Create a deterministic lifecycle test rig with manual heartbeat ticking.
 *
 * @returns Lifecycle rig with counters and recorded writes
 */
function createLifecycleRig(): LifecycleRig {
	const activeHeartbeats = new Map<number, () => void>();
	let heartbeatStartCount = 0;
	let heartbeatStopCount = 0;
	let nextHeartbeatId = 1;
	const writes: UserVarWrite[] = [];

	const deps: WeztermNotifyLifecycleDeps = {
		setUserVar(name: string, value: string) {
			writes.push({ name, value });
		},
		startHeartbeat(tick: () => void): () => void {
			heartbeatStartCount += 1;
			const heartbeatId = nextHeartbeatId;
			nextHeartbeatId += 1;
			activeHeartbeats.set(heartbeatId, tick);

			return () => {
				if (!activeHeartbeats.has(heartbeatId)) {
					return;
				}

				activeHeartbeats.delete(heartbeatId);
				heartbeatStopCount += 1;
			};
		},
	};

	const lifecycle = createWeztermNotifyLifecycle(deps);

	return {
		get activeHeartbeatCount() {
			return activeHeartbeats.size;
		},
		get heartbeatStartCount() {
			return heartbeatStartCount;
		},
		get heartbeatStopCount() {
			return heartbeatStopCount;
		},
		lifecycle,
		tickHeartbeat: () => {
			for (const tick of activeHeartbeats.values()) {
				tick();
			}
		},
		writes,
	};
}

/**
 * Get all recorded user-var values for a specific key.
 *
 * @param rig - Lifecycle test rig
 * @param name - User-var name
 * @returns Ordered list of recorded values
 */
function getUserVarValues(rig: LifecycleRig, name: string): string[] {
	return rig.writes.filter((entry) => entry.name === name).map((entry) => entry.value);
}

/**
 * Read all emitted pi_status values from the rig.
 *
 * @param rig - Lifecycle test rig
 * @returns Ordered pi_status writes
 */
function getStatusWrites(rig: LifecycleRig): string[] {
	return getUserVarValues(rig, "pi_status");
}

/**
 * Read all emitted pi_heartbeat values from the rig.
 *
 * @param rig - Lifecycle test rig
 * @returns Ordered pi_heartbeat writes
 */
function getHeartbeatWrites(rig: LifecycleRig): string[] {
	return getUserVarValues(rig, "pi_heartbeat");
}

describe("wezterm-notify registration", () => {
	it("keeps WEZTERM_PANE gate behavior", async () => {
		delete process.env.WEZTERM_PANE;
		const harness = ExtensionHarness.create();

		await harness.loadExtension(weztermNotify);

		expect(harness.handlers.size).toBe(0);
	});

	it("registers agent-level lifecycle handlers when enabled", async () => {
		process.env.WEZTERM_PANE = "1";
		const harness = ExtensionHarness.create();

		await harness.loadExtension(weztermNotify);

		expect(harness.handlers.has("before_agent_start")).toBe(true);
		expect(harness.handlers.has("agent_start")).toBe(true);
		expect(harness.handlers.has("agent_end")).toBe(true);
		expect(harness.handlers.has("input")).toBe(true);
		expect(harness.handlers.has("session_start")).toBe(true);
		expect(harness.handlers.has("session_shutdown")).toBe(true);
		expect(harness.handlers.has("turn_start")).toBe(false);
		expect(harness.handlers.has("turn_end")).toBe(false);
	});
});

describe("wezterm-notify lifecycle", () => {
	it("handles a single short run sequence", () => {
		const rig = createLifecycleRig();

		rig.lifecycle.onSessionStart();
		rig.lifecycle.onBeforeAgentStart();
		rig.lifecycle.onAgentStart();
		rig.lifecycle.onAgentEnd();
		const inputResult = rig.lifecycle.onInput();

		expect(inputResult).toEqual({ action: "continue" });
		expect(getStatusWrites(rig)).toEqual(["", "working", "done", ""]);
		expect(getHeartbeatWrites(rig)).toEqual(["0"]);
		expect(rig.heartbeatStartCount).toBe(1);
		expect(rig.heartbeatStopCount).toBe(1);
		expect(rig.activeHeartbeatCount).toBe(0);
	});

	it("coalesces duplicate starts without clear flicker", () => {
		const rig = createLifecycleRig();

		rig.lifecycle.onSessionStart();
		rig.lifecycle.onBeforeAgentStart();
		rig.lifecycle.onAgentStart();
		rig.lifecycle.onAgentStart();
		rig.tickHeartbeat();
		rig.tickHeartbeat();
		rig.lifecycle.onAgentEnd();

		expect(getStatusWrites(rig)).toEqual(["", "working", "done"]);
		expect(getHeartbeatWrites(rig)).toEqual(["0", "1", "2"]);
		expect(rig.heartbeatStartCount).toBe(1);
		expect(rig.heartbeatStopCount).toBe(1);
		expect(rig.activeHeartbeatCount).toBe(0);
	});

	it("does not permanently clear when input arrives before start", () => {
		const rig = createLifecycleRig();

		rig.lifecycle.onSessionStart();
		const inputResult = rig.lifecycle.onInput();
		rig.lifecycle.onBeforeAgentStart();
		rig.lifecycle.onAgentStart();
		rig.lifecycle.onAgentEnd();

		expect(inputResult).toEqual({ action: "continue" });
		expect(getStatusWrites(rig)).toEqual(["", "working", "done"]);
	});

	it("starts heartbeat once per interval and leaves no orphan timers", () => {
		const rig = createLifecycleRig();

		rig.lifecycle.onBeforeAgentStart();
		rig.lifecycle.onAgentStart();
		rig.lifecycle.onAgentStart();

		expect(rig.heartbeatStartCount).toBe(1);
		expect(rig.activeHeartbeatCount).toBe(1);

		rig.lifecycle.onAgentEnd();
		expect(rig.heartbeatStopCount).toBe(1);
		expect(rig.activeHeartbeatCount).toBe(0);

		const heartbeatAfterCompletion = getHeartbeatWrites(rig).length;
		rig.tickHeartbeat();
		expect(getHeartbeatWrites(rig)).toHaveLength(heartbeatAfterCompletion);

		rig.lifecycle.onSessionShutdown();
		expect(rig.heartbeatStopCount).toBe(1);
		expect(rig.activeHeartbeatCount).toBe(0);

		rig.lifecycle.onBeforeAgentStart();
		expect(rig.heartbeatStartCount).toBe(2);
		expect(rig.activeHeartbeatCount).toBe(1);

		rig.lifecycle.onSessionShutdown();
		expect(rig.heartbeatStopCount).toBe(2);
		expect(rig.activeHeartbeatCount).toBe(0);

		const heartbeatAfterShutdown = getHeartbeatWrites(rig).length;
		rig.tickHeartbeat();
		expect(getHeartbeatWrites(rig)).toHaveLength(heartbeatAfterShutdown);
	});
});
