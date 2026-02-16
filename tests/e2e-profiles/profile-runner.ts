/**
 * Profile session runner — creates headless tallow sessions with real
 * bundled extensions loaded by path (not inline factories).
 *
 * Unlike the unit-test SessionRunner which uses `noBundledExtensions: true`
 * and inline factories, this loads extensions through the same jiti/resource-
 * loader path as production — catching real loading errors.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { createTallowSession, type TallowSession } from "../../src/sdk.js";
import type { ScriptedResponse } from "../../test-utils/mock-model.js";
import {
	createEchoStreamFn,
	createMockModel,
	createScriptedStreamFn,
} from "../../test-utils/mock-model.js";
import { resolveExtensionPaths } from "./profiles.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for creating a profile session. */
export interface ProfileSessionOptions {
	/** Extension names to load (resolved against extensions/ dir). */
	extensions: readonly string[];
	/** Custom stream function (default: echo). */
	streamFn?: StreamFn;
	/** Working directory override. */
	cwd?: string;
}

/** A running profile session with assertion helpers. */
export interface ProfileSession {
	/** The underlying TallowSession. */
	tallow: TallowSession;
	/** Temp TALLOW_HOME path. */
	home: string;
	/** Send a prompt and collect events. */
	run: (prompt: string) => Promise<AgentSessionEvent[]>;
	/** Clean up temp dirs and env. */
	dispose: () => void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a profile session with real bundled extensions loaded by path.
 *
 * @param options - Profile session configuration
 * @returns Initialized session ready for testing
 */
export async function createProfileSession(
	options: ProfileSessionOptions
): Promise<ProfileSession> {
	const tmpHome = mkdtempSync(join(tmpdir(), "tallow-e2e-"));
	const originalHome = process.env.TALLOW_HOME;
	process.env.TALLOW_HOME = tmpHome;

	try {
		const extensionPaths = resolveExtensionPaths(options.extensions);

		const tallow = await createTallowSession({
			cwd: options.cwd ?? tmpHome,
			model: createMockModel(),
			provider: "mock",
			apiKey: "mock-api-key",
			session: { type: "memory" },
			noBundledExtensions: true,
			noBundledSkills: true,
			additionalExtensions: extensionPaths,
		});

		// Wire mock stream function
		const streamFn = options.streamFn ?? createEchoStreamFn();
		tallow.session.agent.streamFn = streamFn;

		const run = async (prompt: string): Promise<AgentSessionEvent[]> => {
			const events: AgentSessionEvent[] = [];
			const unsub = tallow.session.subscribe((event) => events.push(event));
			try {
				await tallow.session.prompt(prompt);
			} finally {
				unsub();
			}
			return events;
		};

		const dispose = () => {
			try {
				rmSync(tmpHome, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		};

		return { tallow, home: tmpHome, run, dispose };
	} catch (error) {
		// Clean up tmpHome if session creation fails
		try {
			rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		throw error;
	} finally {
		// Restore env immediately — session already has what it needs
		if (originalHome !== undefined) {
			process.env.TALLOW_HOME = originalHome;
		} else {
			delete process.env.TALLOW_HOME;
		}
	}
}

/**
 * Collect all tool names registered across loaded extensions.
 *
 * @param tallow - The tallow session
 * @returns Array of tool name strings
 */
export function getRegisteredToolNames(tallow: TallowSession): string[] {
	const names: string[] = [];
	for (const ext of tallow.extensions.extensions) {
		for (const name of ext.tools.keys()) {
			names.push(name);
		}
	}
	return names;
}

/**
 * Collect all command names registered across loaded extensions.
 *
 * @param tallow - The tallow session
 * @returns Array of command name strings
 */
export function getRegisteredCommandNames(tallow: TallowSession): string[] {
	const names: string[] = [];
	for (const ext of tallow.extensions.extensions) {
		for (const name of ext.commands.keys()) {
			names.push(name);
		}
	}
	return names;
}

/**
 * Collect all event handler registrations across loaded extensions.
 *
 * @param tallow - The tallow session
 * @returns Map of event name → count of handlers
 */
export function getHandlerCounts(tallow: TallowSession): Map<string, number> {
	const counts = new Map<string, number>();
	for (const ext of tallow.extensions.extensions) {
		for (const [event, handlers] of ext.handlers) {
			counts.set(event, (counts.get(event) ?? 0) + handlers.length);
		}
	}
	return counts;
}

/** Re-export for convenience in test files. */
export { createScriptedStreamFn, type ScriptedResponse };
