import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, type TObject, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Version for all cross-extension event payload contracts. */
export const INTEROP_EVENT_SCHEMA_VERSION = 1 as const;

/** Event channels used for typed cross-extension state synchronization. */
export const INTEROP_EVENT_NAMES = {
	backgroundTasksSnapshot: "interop.v1.background-tasks.snapshot",
	stateRequest: "interop.v1.state.request",
	subagentsSnapshot: "interop.v1.subagents.snapshot",
	teamDashboardState: "interop.v1.team-dashboard.state",
	teamsSnapshot: "interop.v1.teams.snapshot",
} as const;

/**
 * Event channels for cross-extension function handshakes.
 *
 * These bypass TypeBox schema validation because they carry function
 * references, not serializable data. Used when one extension needs to
 * call another extension's API through the shared event bus (avoiding
 * jiti module-cache duplication of module-scoped state).
 */
export const INTEROP_API_CHANNELS = {
	/** background-task-tool publishes its promoteToBackground function. */
	promoteToBackgroundApi: "interop.api.v1.background-tasks.promote",
	/** bash-tool-enhanced requests the promote API (for load-order independence). */
	promoteToBackgroundApiRequest: "interop.api.v1.background-tasks.promote-request",
} as const;

/** Valid interop event channel names. */
export type InteropEventName = (typeof INTEROP_EVENT_NAMES)[keyof typeof INTEROP_EVENT_NAMES];

const SubagentStatusSchema = Type.Union([
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("running"),
]);

const BackgroundTaskStatusSchema = Type.Union([
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("killed"),
	Type.Literal("running"),
]);

const TeamTaskViewSchema = Type.Object({
	assignee: Type.Union([Type.String(), Type.Null()]),
	blockedBy: Type.Array(Type.String()),
	id: Type.String(),
	status: Type.String(),
	title: Type.String(),
});

const TeamTeammateViewSchema = Type.Object({
	completedTaskCount: Type.Number(),
	currentTask: Type.Optional(Type.String()),
	model: Type.String(),
	name: Type.String(),
	role: Type.String(),
	status: Type.String(),
});

const InteropSubagentViewSchema = Type.Object({
	agent: Type.String(),
	id: Type.String(),
	model: Type.Optional(Type.String()),
	startTime: Type.Number(),
	status: SubagentStatusSchema,
	task: Type.String(),
});

const InteropBackgroundTaskViewSchema = Type.Object({
	command: Type.String(),
	id: Type.String(),
	startTime: Type.Number(),
	status: BackgroundTaskStatusSchema,
});

const InteropTeamViewSchema = Type.Object({
	name: Type.String(),
	tasks: Type.Array(TeamTaskViewSchema),
	teammates: Type.Array(TeamTeammateViewSchema),
});

const InteropEventSchemas = {
	[INTEROP_EVENT_NAMES.backgroundTasksSnapshot]: Type.Object({
		schemaVersion: Type.Literal(INTEROP_EVENT_SCHEMA_VERSION),
		tasks: Type.Array(InteropBackgroundTaskViewSchema),
	}),
	[INTEROP_EVENT_NAMES.stateRequest]: Type.Object({
		requester: Type.String(),
		schemaVersion: Type.Literal(INTEROP_EVENT_SCHEMA_VERSION),
	}),
	[INTEROP_EVENT_NAMES.subagentsSnapshot]: Type.Object({
		background: Type.Array(InteropSubagentViewSchema),
		foreground: Type.Array(InteropSubagentViewSchema),
		schemaVersion: Type.Literal(INTEROP_EVENT_SCHEMA_VERSION),
	}),
	[INTEROP_EVENT_NAMES.teamDashboardState]: Type.Object({
		active: Type.Boolean(),
		schemaVersion: Type.Literal(INTEROP_EVENT_SCHEMA_VERSION),
	}),
	[INTEROP_EVENT_NAMES.teamsSnapshot]: Type.Object({
		schemaVersion: Type.Literal(INTEROP_EVENT_SCHEMA_VERSION),
		teams: Type.Array(InteropTeamViewSchema),
	}),
} as const satisfies Record<InteropEventName, TObject>;

/** Typed payload map keyed by interop event name. */
export type InteropEventPayloadByName = {
	[K in keyof typeof InteropEventSchemas]: Static<(typeof InteropEventSchemas)[K]>;
};

/** View payload for background task snapshots. */
export type InteropBackgroundTaskView = Static<typeof InteropBackgroundTaskViewSchema>;
/** View payload for subagent snapshots. */
export type InteropSubagentView = Static<typeof InteropSubagentViewSchema>;
/** View payload for team snapshots. */
export type InteropTeamView = Static<typeof InteropTeamViewSchema>;

/** Valid subagent statuses in the interop contract. */
type InteropSubagentStatus = InteropSubagentView["status"];

const INTEROP_SUBAGENT_STATUSES: readonly InteropSubagentStatus[] = [
	"completed",
	"failed",
	"running",
] as const;

const INTEROP_BACKGROUND_TASK_STATUSES: readonly InteropBackgroundTaskView["status"][] = [
	"completed",
	"failed",
	"killed",
	"running",
] as const;

/**
 * Emit a typed interop event with contract version attached.
 *
 * @param events - Shared extension event bus
 * @param eventName - Interop channel name
 * @param payload - Event payload without schemaVersion
 * @returns void
 */
export function emitInteropEvent<TName extends InteropEventName>(
	events: ExtensionAPI["events"],
	eventName: TName,
	payload: Omit<InteropEventPayloadByName[TName], "schemaVersion">
): void {
	const nextPayload = {
		schemaVersion: INTEROP_EVENT_SCHEMA_VERSION,
		...payload,
	} as InteropEventPayloadByName[TName];
	events.emit(eventName, nextPayload);
}

/**
 * Parse and validate an interop event payload against its schema.
 *
 * @param eventName - Interop channel name
 * @param payload - Raw payload from the event bus
 * @returns Parsed payload when valid; otherwise undefined
 */
export function parseInteropEvent<TName extends InteropEventName>(
	eventName: TName,
	payload: unknown
): InteropEventPayloadByName[TName] | undefined {
	const schema = InteropEventSchemas[eventName];
	if (!Value.Check(schema, payload)) return undefined;
	return payload as InteropEventPayloadByName[TName];
}

/**
 * Subscribe to an interop event with schema validation.
 *
 * @param events - Shared extension event bus
 * @param eventName - Interop channel name
 * @param handler - Handler invoked only for schema-valid payloads
 * @returns Unsubscribe function
 */
export function onInteropEvent<TName extends InteropEventName>(
	events: ExtensionAPI["events"],
	eventName: TName,
	handler: (payload: InteropEventPayloadByName[TName]) => void
): () => void {
	return events.on(eventName, (rawPayload) => {
		const payload = parseInteropEvent(eventName, rawPayload);
		if (!payload) return;
		handler(payload);
	});
}

/**
 * Emit a snapshot request so producers can republish current state.
 *
 * @param events - Shared extension event bus
 * @param requester - Consumer identifier for diagnostics
 * @returns void
 */
export function requestInteropState(events: ExtensionAPI["events"], requester: string): void {
	emitInteropEvent(events, INTEROP_EVENT_NAMES.stateRequest, { requester });
}

/** Configuration for the temporary globalThis -> events compatibility bridge. */
export interface LegacyInteropBridgeOptions {
	/** Polling cadence for legacy global snapshots in milliseconds. */
	intervalMs?: number;
}

/**
 * Start a temporary compatibility bridge that mirrors legacy globalThis state
 * into typed interop events for migrated consumers.
 *
 * This keeps old producer extensions working while consumers move to typed
 * contracts. Remove once legacy global producers are retired.
 *
 * @param events - Shared extension event bus
 * @param options - Optional bridge tuning
 * @returns Cleanup function that stops polling
 */
export function startLegacyInteropBridge(
	events: ExtensionAPI["events"],
	options?: LegacyInteropBridgeOptions
): () => void {
	const globals = globalThis as Record<string, unknown>;
	let lastFingerprint = "";

	const publishSnapshot = () => {
		const foreground = parseLegacySubagentViews(globals.__piRunningSubagents, "running");
		const background = parseLegacySubagentViews(globals.__piBackgroundSubagents, "running");
		const tasks = parseLegacyBackgroundTasks(globals.__piBackgroundTasks);
		const teams = parseLegacyTeams(globals.__piActiveTeams);
		const dashboardActive = Boolean(globals.__piTeamDashboardActive);

		const fingerprint = JSON.stringify({
			background,
			dashboardActive,
			foreground,
			tasks,
			teams,
		});
		if (fingerprint === lastFingerprint) return;
		lastFingerprint = fingerprint;

		emitInteropEvent(events, INTEROP_EVENT_NAMES.subagentsSnapshot, { background, foreground });
		emitInteropEvent(events, INTEROP_EVENT_NAMES.backgroundTasksSnapshot, { tasks });
		emitInteropEvent(events, INTEROP_EVENT_NAMES.teamsSnapshot, { teams });
		emitInteropEvent(events, INTEROP_EVENT_NAMES.teamDashboardState, { active: dashboardActive });
	};

	publishSnapshot();
	const intervalMs = options?.intervalMs ?? 250;
	const intervalId = setInterval(publishSnapshot, intervalMs);
	return () => {
		clearInterval(intervalId);
	};
}

/**
 * Parse legacy map entries into typed subagent views.
 *
 * @param rawMap - Candidate Map-like value from globalThis
 * @param fallbackStatus - Status to apply when legacy payload omitted one
 * @returns Parsed subagent views
 */
function parseLegacySubagentViews(
	rawMap: unknown,
	fallbackStatus: InteropSubagentStatus
): InteropSubagentView[] {
	const values = readMapValues(rawMap);
	const parsed: InteropSubagentView[] = [];
	for (const entry of values) {
		if (!isObject(entry)) continue;
		const agent = readString(entry, "agent");
		const id = readString(entry, "id");
		const startTime = readNumber(entry, "startTime");
		const task = readString(entry, "task");
		if (!(agent && id && startTime !== undefined && task)) continue;
		const rawStatus = readString(entry, "status") ?? fallbackStatus;
		if (!INTEROP_SUBAGENT_STATUSES.includes(rawStatus as InteropSubagentStatus)) continue;
		const candidate = {
			agent,
			id,
			startTime,
			status: rawStatus as InteropSubagentStatus,
			task,
		};
		if (Value.Check(InteropSubagentViewSchema, candidate)) {
			parsed.push(candidate);
		}
	}
	return parsed;
}

/**
 * Parse legacy map entries into typed background task views.
 *
 * @param rawMap - Candidate Map-like value from globalThis
 * @returns Parsed background task views
 */
function parseLegacyBackgroundTasks(rawMap: unknown): InteropBackgroundTaskView[] {
	const values = readMapValues(rawMap);
	const parsed: InteropBackgroundTaskView[] = [];
	for (const entry of values) {
		if (!isObject(entry)) continue;
		const command = readString(entry, "command");
		const id = readString(entry, "id");
		const startTime = readNumber(entry, "startTime");
		const rawStatus = readString(entry, "status");
		if (!(command && id && startTime !== undefined && rawStatus)) continue;
		if (
			!INTEROP_BACKGROUND_TASK_STATUSES.includes(rawStatus as InteropBackgroundTaskView["status"])
		) {
			continue;
		}
		const candidate = {
			command,
			id,
			startTime,
			status: rawStatus as InteropBackgroundTaskView["status"],
		};
		if (Value.Check(InteropBackgroundTaskViewSchema, candidate)) {
			parsed.push(candidate);
		}
	}
	return parsed;
}

/**
 * Parse legacy map entries into typed team widget views.
 *
 * @param rawMap - Candidate Map-like value from globalThis
 * @returns Parsed team views
 */
function parseLegacyTeams(rawMap: unknown): InteropTeamView[] {
	const values = readMapValues(rawMap);
	const parsed: InteropTeamView[] = [];
	for (const entry of values) {
		if (Value.Check(InteropTeamViewSchema, entry)) {
			parsed.push(entry);
		}
	}
	return parsed;
}

/**
 * Read values from a legacy Map store.
 *
 * @param rawMap - Candidate value that may be a Map
 * @returns Array of map values when valid; otherwise empty array
 */
function readMapValues(rawMap: unknown): unknown[] {
	if (!(rawMap instanceof Map)) return [];
	return [...rawMap.values()];
}

/**
 * Type guard for plain object records.
 *
 * @param value - Value to inspect
 * @returns True when value is a non-null object
 */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Read a string field from an object record.
 *
 * @param value - Source object
 * @param key - Field name
 * @returns String value when present; otherwise undefined
 */
function readString(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Read a number field from an object record.
 *
 * @param value - Source object
 * @param key - Field name
 * @returns Number value when present; otherwise undefined
 */
function readNumber(value: Record<string, unknown>, key: string): number | undefined {
	const candidate = value[key];
	return typeof candidate === "number" ? candidate : undefined;
}
