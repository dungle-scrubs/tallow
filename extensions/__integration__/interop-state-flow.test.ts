/**
 * Integration tests for typed cross-extension interop state flow.
 *
 * Verifies that producers and consumers communicate through shared event
 * contracts, and that state synchronization remains stable regardless of
 * extension load order.
 */
import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../test-utils/extension-harness.js";
import {
	emitInteropEvent,
	INTEROP_EVENT_NAMES,
	type InteropBackgroundTaskView,
	type InteropSubagentView,
	type InteropTeamView,
	onInteropEvent,
	requestInteropState,
} from "../_shared/interop-events.js";

interface ObservedInteropState {
	backgroundTasks: InteropBackgroundTaskView[];
	dashboardActive: boolean;
	subagents: { background: InteropSubagentView[]; foreground: InteropSubagentView[] };
	teams: InteropTeamView[];
}

/**
 * Build a producer extension that publishes deterministic state snapshots
 * whenever a consumer requests interop state.
 *
 * @returns Extension factory
 */
function createInteropProducer(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const publish = () => {
			emitInteropEvent(pi.events, INTEROP_EVENT_NAMES.subagentsSnapshot, {
				background: [
					{
						agent: "builder",
						id: "bg_1",
						startTime: 200,
						status: "running",
						task: "Run test suite",
					},
				],
				foreground: [
					{
						agent: "reviewer",
						id: "fg_1",
						startTime: 100,
						status: "running",
						task: "Review API changes",
					},
				],
			});
			emitInteropEvent(pi.events, INTEROP_EVENT_NAMES.backgroundTasksSnapshot, {
				tasks: [
					{
						command: "npm run lint",
						id: "task_1",
						startTime: 300,
						status: "running",
					},
				],
			});
			emitInteropEvent(pi.events, INTEROP_EVENT_NAMES.teamsSnapshot, {
				teams: [
					{
						name: "alpha",
						tasks: [
							{
								assignee: "alice",
								blockedBy: [],
								id: "1",
								status: "claimed",
								title: "Ship feature",
							},
						],
						teammates: [
							{
								completedTaskCount: 1,
								currentTask: "Ship feature",
								model: "claude-sonnet-4-5",
								name: "alice",
								role: "implementer",
								status: "working",
							},
						],
					},
				],
			});
			emitInteropEvent(pi.events, INTEROP_EVENT_NAMES.teamDashboardState, {
				active: true,
			});
		};

		onInteropEvent(pi.events, INTEROP_EVENT_NAMES.stateRequest, publish);
	};
}

/**
 * Build a consumer extension that records the latest interop snapshots.
 *
 * @param observed - Mutable state sink for assertions
 * @returns Extension factory
 */
function createInteropConsumer(observed: ObservedInteropState): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		onInteropEvent(pi.events, INTEROP_EVENT_NAMES.subagentsSnapshot, (payload) => {
			observed.subagents = {
				background: payload.background,
				foreground: payload.foreground,
			};
		});
		onInteropEvent(pi.events, INTEROP_EVENT_NAMES.backgroundTasksSnapshot, (payload) => {
			observed.backgroundTasks = payload.tasks;
		});
		onInteropEvent(pi.events, INTEROP_EVENT_NAMES.teamsSnapshot, (payload) => {
			observed.teams = payload.teams;
		});
		onInteropEvent(pi.events, INTEROP_EVENT_NAMES.teamDashboardState, (payload) => {
			observed.dashboardActive = payload.active;
		});
	};
}

/**
 * Create an empty observed-state container for assertions.
 *
 * @returns Fresh observed state object
 */
function createObservedState(): ObservedInteropState {
	return {
		backgroundTasks: [],
		dashboardActive: false,
		subagents: { background: [], foreground: [] },
		teams: [],
	};
}

describe("Interop state flow", () => {
	it("synchronizes producer snapshots when consumer loads first", async () => {
		const harness = ExtensionHarness.create();
		const observed = createObservedState();

		await harness.loadExtension(createInteropConsumer(observed));
		await harness.loadExtension(createInteropProducer());

		requestInteropState(harness.api.events, "integration-test");

		expect(observed.subagents.foreground).toHaveLength(1);
		expect(observed.subagents.background).toHaveLength(1);
		expect(observed.backgroundTasks).toHaveLength(1);
		expect(observed.teams).toHaveLength(1);
		expect(observed.dashboardActive).toBe(true);
	});

	it("synchronizes producer snapshots when producer loads first", async () => {
		const harness = ExtensionHarness.create();
		const observed = createObservedState();

		await harness.loadExtension(createInteropProducer());
		await harness.loadExtension(createInteropConsumer(observed));

		requestInteropState(harness.api.events, "integration-test");

		expect(observed.subagents.foreground[0]?.id).toBe("fg_1");
		expect(observed.subagents.background[0]?.id).toBe("bg_1");
		expect(observed.backgroundTasks[0]?.id).toBe("task_1");
		expect(observed.teams[0]?.name).toBe("alpha");
		expect(observed.dashboardActive).toBe(true);
	});

	it("ignores invalid payloads that do not match schema version", async () => {
		const harness = ExtensionHarness.create();
		const observed = createObservedState();

		await harness.loadExtension(createInteropConsumer(observed));
		harness.eventBus.emit(INTEROP_EVENT_NAMES.backgroundTasksSnapshot, {
			schemaVersion: 999,
			tasks: [],
		});

		expect(observed.backgroundTasks).toHaveLength(0);
	});
});
