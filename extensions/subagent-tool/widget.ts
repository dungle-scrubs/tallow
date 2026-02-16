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
	type InteropSubagentView,
} from "../_shared/interop-events.js";
import type { SingleResult } from "./formatting.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Tracks a foreground subagent currently executing inline. */
export interface RunningSubagent {
	id: string;
	agent: string;
	task: string;
	startTime: number;
}

/** Tracks a background subagent running as a detached process. */
export interface BackgroundSubagent {
	id: string;
	agent: string;
	task: string;
	startTime: number;
	process: ReturnType<typeof spawn>;
	result: SingleResult;
	status: "running" | "completed" | "failed";
	tmpPromptDir?: string;
	tmpPromptPath?: string;
}

// ── State ────────────────────────────────────────────────────────────────────

/** Spinner frames for animated progress indicators. */
export const SPINNER_FRAMES = getSpinner();

export const runningSubagents = new Map<string, RunningSubagent>();
export const backgroundSubagents = new Map<string, BackgroundSubagent>();
export let interopStateRequestCleanup: (() => void) | undefined;

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

// Store interval on globalThis to clear across reloads
const G = globalThis;
if (G.__piSubagentWidgetInterval) {
	clearInterval(G.__piSubagentWidgetInterval);
	G.__piSubagentWidgetInterval = null;
}

// ── Functions ────────────────────────────────────────────────────────────────

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
		startTime: subagent.startTime,
		status: subagent.status,
		task: subagent.task,
	}));
	const foreground: InteropSubagentView[] = [...runningSubagents.values()].map((subagent) => ({
		agent: subagent.agent,
		id: subagent.id,
		startTime: subagent.startTime,
		status: "running",
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
 */
export function registerForegroundSubagent(
	id: string,
	agent: string,
	task: string,
	startTime: number,
	piEvents?: ExtensionAPI["events"]
): void {
	runningSubagents.set(id, { id, agent, task, startTime });
	publishSubagentSnapshot(piEvents);
	startWidgetUpdates();
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
