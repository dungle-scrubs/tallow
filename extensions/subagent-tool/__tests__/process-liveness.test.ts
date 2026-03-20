import { describe, expect, it } from "bun:test";
import type { SingleResult } from "../formatting.js";
import {
	applyStalledClassification,
	createWatchdogHeartbeatState,
	evaluateWatchdogStatus,
	type ForegroundWatchdogThresholds,
	isWatchdogHeartbeatEventType,
	recordWatchdogHeartbeat,
	recordWatchdogToolCallEnd,
	recordWatchdogToolCallStart,
	resolveForegroundWatchdogThresholds,
	SUBAGENT_INACTIVITY_TIMEOUT_MS_ENV,
	SUBAGENT_STARTUP_TIMEOUT_MS_ENV,
	SUBAGENT_TOOL_EXECUTION_TIMEOUT_MS_ENV,
	terminateProcessWithGrace,
} from "../process.js";

const TEST_THRESHOLDS: ForegroundWatchdogThresholds = {
	inactivityTimeoutMs: 2_000,
	killGraceMs: 50,
	startupTimeoutMs: 1_000,
	toolExecutionTimeoutMs: 8_000,
};

interface ManualTimer {
	callback: () => void;
	cancelled: boolean;
}

/**
 * Create a minimal SingleResult for liveness contract tests.
 * @returns Baseline subagent result object
 */
function createEmptyResult(): SingleResult {
	return {
		agent: "test-agent",
		agentSource: "project",
		task: "test task",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
			denials: 0,
		},
	};
}

/**
 * Build deterministic timer controls for termination escalation tests.
 * @returns Manual timer driver with set/clear + runAll helpers
 */
function createManualTimerDriver(): {
	clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => void;
	runAll: () => void;
	setTimeoutFn: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
} {
	const timers: ManualTimer[] = [];

	return {
		clearTimeoutFn: (timer) => {
			const manualTimer = timer as unknown as ManualTimer;
			manualTimer.cancelled = true;
		},
		runAll: () => {
			for (const timer of timers) {
				if (!timer.cancelled) timer.callback();
			}
		},
		setTimeoutFn: (callback, delayMs) => {
			void delayMs;
			const timer: ManualTimer = {
				callback,
				cancelled: false,
			};
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
	};
}

describe("foreground subagent liveness watchdog", () => {
	it("classifies no-heartbeat workers as stalled after startup timeout", () => {
		const state = createWatchdogHeartbeatState(0);
		const status = evaluateWatchdogStatus(state, 1_001, TEST_THRESHOLDS);

		expect(status.kind).toBe("stalled");
		if (status.kind !== "stalled") return;
		expect(status.phase).toBe("startup");
	});

	it("refreshing heartbeat avoids false inactivity stalls", () => {
		let state = createWatchdogHeartbeatState(0);
		state = recordWatchdogHeartbeat(state, 500);
		expect(evaluateWatchdogStatus(state, 2_000, TEST_THRESHOLDS).kind).toBe("healthy");

		state = recordWatchdogHeartbeat(state, 2_000);
		expect(evaluateWatchdogStatus(state, 3_900, TEST_THRESHOLDS).kind).toBe("healthy");

		const stalledStatus = evaluateWatchdogStatus(state, 4_200, TEST_THRESHOLDS);
		expect(stalledStatus.kind).toBe("stalled");
		if (stalledStatus.kind !== "stalled") return;
		expect(stalledStatus.phase).toBe("inactivity");
	});

	it("widens the timeout while a tool call is still running", () => {
		let state = createWatchdogHeartbeatState(0);
		state = recordWatchdogToolCallStart(state, 500);
		expect(evaluateWatchdogStatus(state, 6_000, TEST_THRESHOLDS).kind).toBe("healthy");

		const stalledStatus = evaluateWatchdogStatus(state, 8_600, TEST_THRESHOLDS);
		expect(stalledStatus.kind).toBe("stalled");
		if (stalledStatus.kind !== "stalled") return;
		expect(stalledStatus.phase).toBe("tool_execution");

		state = recordWatchdogToolCallEnd(state, 8_600);
		expect(state.activeToolCalls).toBe(0);
	});

	it("treats message updates and tool execution events as heartbeats", () => {
		expect(isWatchdogHeartbeatEventType("message_update")).toBe(true);
		expect(isWatchdogHeartbeatEventType("tool_execution_start")).toBe(true);
		expect(isWatchdogHeartbeatEventType("tool_execution_end")).toBe(true);
		expect(isWatchdogHeartbeatEventType("tool_result_end")).toBe(false);
	});

	it("applies env overrides for watchdog thresholds", () => {
		const thresholds = resolveForegroundWatchdogThresholds({
			[SUBAGENT_INACTIVITY_TIMEOUT_MS_ENV]: "7000",
			[SUBAGENT_STARTUP_TIMEOUT_MS_ENV]: "3000",
			[SUBAGENT_TOOL_EXECUTION_TIMEOUT_MS_ENV]: "11000",
		});
		expect(thresholds.inactivityTimeoutMs).toBe(7_000);
		expect(thresholds.startupTimeoutMs).toBe(3_000);
		expect(thresholds.toolExecutionTimeoutMs).toBe(11_000);
	});

	it("stalled termination escalates and resolves without hanging", async () => {
		const state = createWatchdogHeartbeatState(0);
		const stalledStatus = evaluateWatchdogStatus(state, 1_001, TEST_THRESHOLDS);
		expect(stalledStatus.kind).toBe("stalled");
		if (stalledStatus.kind !== "stalled") return;

		const result = createEmptyResult();
		applyStalledClassification(result, stalledStatus);

		const timerDriver = createManualTimerDriver();
		const signals: NodeJS.Signals[] = [];
		const fakeProc = {
			exitCode: null as number | null,
			kill: (signal?: NodeJS.Signals) => {
				if (signal) signals.push(signal);
				return true;
			},
		};

		const resolvedCode = await new Promise<number>((resolve) => {
			terminateProcessWithGrace(fakeProc, {
				clearTimeoutFn: timerDriver.clearTimeoutFn,
				killGraceMs: TEST_THRESHOLDS.killGraceMs,
				onForceResolve: () => resolve(1),
				setTimeoutFn: timerDriver.setTimeoutFn,
			});
			timerDriver.runAll();
		});

		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(resolvedCode).toBe(1);
		expect(result.stopReason).toBe("stalled");
		expect(result.errorMessage).toContain("slow provider startup");
		expect(result.errorMessage).toContain("TALLOW_SUBAGENT_*");
	});
});
