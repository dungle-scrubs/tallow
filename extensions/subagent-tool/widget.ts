/**
 * Subagent widget state management.
 *
 * Tracks foreground and background subagents, manages UI widget updates,
 * and publishes snapshots via the interop event bus for cross-extension
 * state synchronization.
 */

import type { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getSpinner } from "../_icons/index.js";
import {
	emitInteropEvent,
	INTEROP_EVENT_NAMES,
	type InteropSubagentStatus,
	type InteropSubagentView,
} from "../_shared/interop-events.js";
import { getFinalOutput, type SingleResult } from "./formatting.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Tracks a foreground subagent currently executing inline. */
export interface RunningSubagent {
	id: string;
	agent: string;
	model?: string;
	task: string;
	startTime: number;
	status: Extract<InteropSubagentStatus, "running" | "stalled">;
}

/** Tracks a background subagent running as a detached process. */
export interface BackgroundSubagent {
	agent: string;
	completedAt?: number;
	historyCompacted?: boolean;
	historyOriginalMessageCount?: number;
	historyRetainedMessageCount?: number;
	id: string;
	model?: string;
	process: ReturnType<typeof spawn>;
	result: SingleResult;
	retainedFinalOutput?: string;
	startTime: number;
	status: InteropSubagentStatus;
	task: string;
	tmpPromptDir?: string;
	tmpPromptPath?: string;
}

// ── State ────────────────────────────────────────────────────────────────────

/** Spinner frames for animated progress indicators. */
export const SPINNER_FRAMES = getSpinner();

export const runningSubagents = new Map<string, RunningSubagent>();
export const backgroundSubagents = new Map<string, BackgroundSubagent>();
export let interopStateRequestCleanup: (() => void) | undefined;

/** Env var that controls how long completed background subagents are retained. */
export const SUBAGENT_COMPLETED_RETENTION_MINUTES_ENV =
	"TALLOW_SUBAGENT_COMPLETED_RETENTION_MINUTES";

/** Default completed background-subagent retention window in minutes. */
export const SUBAGENT_COMPLETED_RETENTION_MINUTES_DEFAULT = 30;

/** Maximum completed background-subagent retention window in minutes. */
export const SUBAGENT_COMPLETED_RETENTION_MINUTES_MAX = 24 * 60;

/** Background cleanup cadence for stale completed subagent records. */
const SUBAGENT_COMPLETED_CLEANUP_INTERVAL_MS = 60_000;

type EnvLookup = Readonly<Record<string, string | undefined>>;

/** Reference to the current UI extension context. */
export let uiContext: ExtensionContext | null = null;

/**
 * Update the stored UI context reference.
 * @param ctx - New extension context, or null to clear
 */
export function setUiContext(ctx: ExtensionContext | null): void {
	uiContext = ctx;
}

/**
 * Update the stored interop cleanup function.
 * @param cleanup - Cleanup function, or undefined to clear
 */
export function setInteropStateRequestCleanup(cleanup: (() => void) | undefined): void {
	interopStateRequestCleanup = cleanup;
}

// ── Globals (survive reloads) ────────────────────────────────────────────────

// Store intervals on globalThis to clear across reloads
const G = globalThis as typeof globalThis & {
	__piSubagentHistoryCleanupInterval?: ReturnType<typeof setInterval> | null;
};
if (G.__piSubagentWidgetInterval) {
	clearInterval(G.__piSubagentWidgetInterval);
	G.__piSubagentWidgetInterval = null;
}
if (G.__piSubagentHistoryCleanupInterval) {
	clearInterval(G.__piSubagentHistoryCleanupInterval);
	G.__piSubagentHistoryCleanupInterval = null;
}

// ── Functions ────────────────────────────────────────────────────────────────

/**
 * Parse a positive integer minute value from an env var.
 * @param rawValue - Raw env var value
 * @returns Parsed minute value, or undefined when invalid
 */
function parsePositiveMinutes(rawValue: string | undefined): number | undefined {
	if (!rawValue) return undefined;
	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return undefined;
	if (parsed < 0) return undefined;
	return Math.min(parsed, SUBAGENT_COMPLETED_RETENTION_MINUTES_MAX);
}

/**
 * Resolve completed background-subagent retention window.
 * @param env - Environment lookup map
 * @returns Retention window in milliseconds
 */
export function getCompletedBackgroundRetentionMs(env: EnvLookup = process.env): number {
	const parsedMinutes = parsePositiveMinutes(env[SUBAGENT_COMPLETED_RETENTION_MINUTES_ENV]);
	const retentionMinutes = parsedMinutes ?? SUBAGENT_COMPLETED_RETENTION_MINUTES_DEFAULT;
	return retentionMinutes * 60_000;
}

/**
 * Get the best available output text for a background subagent.
 * @param subagent - Background subagent record
 * @returns Final output text if present
 */
export function getBackgroundSubagentOutput(subagent: BackgroundSubagent): string {
	if (subagent.retainedFinalOutput !== undefined) return subagent.retainedFinalOutput;
	return getFinalOutput(subagent.result.messages);
}

/**
 * Determine whether a background subagent has reached a terminal state.
 * @param status - Subagent status
 * @returns true when the status is terminal
 */
function isTerminalBackgroundStatus(status: InteropSubagentStatus): boolean {
	return status === "completed" || status === "failed";
}

/**
 * Remove completed background subagents that exceeded retention window.
 * @param piEvents - Shared event bus for snapshot publication
 * @param nowMs - Current timestamp in milliseconds
 * @param retentionMs - Retention window in milliseconds
 * @returns Number of removed stale records
 */
export function cleanupCompletedBackgroundSubagents(
	piEvents?: ExtensionAPI["events"],
	nowMs = Date.now(),
	retentionMs = getCompletedBackgroundRetentionMs()
): number {
	if (backgroundSubagents.size === 0) {
		stopBackgroundSubagentCleanupLoop();
		return 0;
	}

	const ttlMs = Math.max(0, Math.floor(retentionMs));
	const staleBefore = nowMs - ttlMs;
	let removed = 0;

	for (const [id, subagent] of backgroundSubagents) {
		if (!isTerminalBackgroundStatus(subagent.status)) continue;
		const completedAt = subagent.completedAt ?? subagent.startTime;
		if (completedAt > staleBefore) continue;
		backgroundSubagents.delete(id);
		removed++;
	}

	if (removed > 0) {
		publishSubagentSnapshot(piEvents);
		updateWidget();
	}

	if (backgroundSubagents.size === 0) {
		stopBackgroundSubagentCleanupLoop();
	}

	return removed;
}

/**
 * Stop periodic cleanup of completed background subagent records.
 */
export function stopBackgroundSubagentCleanupLoop(): void {
	if (!G.__piSubagentHistoryCleanupInterval) return;
	clearInterval(G.__piSubagentHistoryCleanupInterval);
	G.__piSubagentHistoryCleanupInterval = null;
}

/**
 * Start periodic cleanup of completed background subagent records.
 * @param piEvents - Shared event bus for snapshot publication after cleanup
 */
export function startBackgroundSubagentCleanupLoop(piEvents?: ExtensionAPI["events"]): void {
	if (G.__piSubagentHistoryCleanupInterval) return;
	cleanupCompletedBackgroundSubagents(piEvents);
	G.__piSubagentHistoryCleanupInterval = setInterval(() => {
		cleanupCompletedBackgroundSubagents(piEvents);
	}, SUBAGENT_COMPLETED_CLEANUP_INTERVAL_MS);
}

/**
 * Build the current typed subagent snapshot for cross-extension consumers.
 *
 * @returns Snapshot payload with foreground and background subagents
 */
export function buildSubagentSnapshot(): {
	background: InteropSubagentView[];
	foreground: InteropSubagentView[];
} {
	const background: InteropSubagentView[] = [...backgroundSubagents.values()].map((subagent) => ({
		agent: subagent.agent,
		id: subagent.id,
		model: subagent.model ?? subagent.result.model,
		startTime: subagent.startTime,
		status: subagent.status,
		task: subagent.task,
	}));
	const foreground: InteropSubagentView[] = [...runningSubagents.values()].map((subagent) => ({
		agent: subagent.agent,
		id: subagent.id,
		model: subagent.model,
		startTime: subagent.startTime,
		status: subagent.status,
		task: subagent.task,
	}));
	return { background, foreground };
}

/**
 * Publish subagent snapshot updates for typed cross-extension state sync.
 *
 * @param piEvents - Shared event bus instance
 */
export function publishSubagentSnapshot(piEvents?: ExtensionAPI["events"]): void {
	if (!piEvents) return;
	const snapshot = buildSubagentSnapshot();
	emitInteropEvent(piEvents, INTEROP_EVENT_NAMES.subagentsSnapshot, snapshot);
}

/**
 * No-op placeholder — background widget is rendered by the tasks extension.
 */
function updateBackgroundWidget(): void {
	// No-op - tasks extension handles rendering
}

/**
 * Updates the widget and stops the interval if no background tasks remain.
 */
export function updateWidget(): void {
	updateBackgroundWidget();

	// Stop interval if no more running background tasks
	const bgRunning = [...backgroundSubagents.values()].filter((s) => s.status === "running");
	if (bgRunning.length === 0 && G.__piSubagentWidgetInterval) {
		clearInterval(G.__piSubagentWidgetInterval);
		G.__piSubagentWidgetInterval = null;
	}
	if (backgroundSubagents.size === 0) {
		stopBackgroundSubagentCleanupLoop();
	}
}

/**
 * Starts periodic widget updates if not already running.
 */
export function startWidgetUpdates(): void {
	if (G.__piSubagentWidgetInterval) return; // Already running
	updateWidget(); // Immediate update
	G.__piSubagentWidgetInterval = setInterval(updateWidget, 500); // Update every 500ms
}

/**
 * Clears foreground subagent tracking without affecting background subagents.
 *
 * @param piEvents - Shared event bus for state publication
 */
export function clearForegroundSubagents(piEvents?: ExtensionAPI["events"]): void {
	runningSubagents.clear();
	publishSubagentSnapshot(piEvents);
}

/**
 * Clears foreground subagents while preserving background subagent tracking.
 *
 * @param piEvents - Shared event bus for state publication
 */
export function clearAllSubagents(piEvents?: ExtensionAPI["events"]): void {
	runningSubagents.clear();
	publishSubagentSnapshot(piEvents);
	// Don't clear background subagents - they persist across tool calls
	// Only clear widget if NO background subagents are running
	// Background subagents rendered by tasks extension, no separate widget needed
}

/**
 * Register a foreground subagent for cross-extension activity rendering.
 *
 * @param id - Subagent tracking ID
 * @param agent - Agent name
 * @param task - Task description
 * @param startTime - Start timestamp in ms
 * @param piEvents - Shared event bus for snapshot updates
 * @param model - Selected model identifier
 */
export function registerForegroundSubagent(
	id: string,
	agent: string,
	task: string,
	startTime: number,
	piEvents?: ExtensionAPI["events"],
	model?: string
): void {
	runningSubagents.set(id, { id, agent, model, task, startTime, status: "running" });
	publishSubagentSnapshot(piEvents);
	startWidgetUpdates();
}

/**
 * Update a foreground subagent status and publish snapshot updates.
 *
 * @param id - Subagent tracking ID
 * @param status - New liveness status
 * @param piEvents - Shared event bus for snapshot updates
 */
export function setForegroundSubagentStatus(
	id: string,
	status: Extract<InteropSubagentStatus, "running" | "stalled">,
	piEvents?: ExtensionAPI["events"]
): void {
	const existing = runningSubagents.get(id);
	if (!existing || existing.status === status) return;
	runningSubagents.set(id, { ...existing, status });
	publishSubagentSnapshot(piEvents);
	updateWidget();
}

/**
 * Remove a foreground subagent and publish updated state.
 *
 * @param id - Subagent tracking ID
 * @param piEvents - Shared event bus for snapshot updates
 */
export function completeForegroundSubagent(id: string, piEvents?: ExtensionAPI["events"]): void {
	runningSubagents.delete(id);
	publishSubagentSnapshot(piEvents);
	updateWidget();
}

/**
 * Generates a random 8-character ID for tracking subagent invocations.
 * @returns Random alphanumeric ID string
 */
export function generateId(): string {
	return Math.random().toString(36).substring(2, 10);
}

/**
 * Formats milliseconds as human-readable duration (e.g., "5s", "2m30s").
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${minutes}m${secs}s`;
}
