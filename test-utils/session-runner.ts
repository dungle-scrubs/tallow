/**
 * Session runner — headless tallow session for integration testing.
 *
 * Wraps `createTallowSession` with a mock model and in-memory session,
 * providing a simple `run(prompt)` API for testing extension interactions
 * and session lifecycle.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createTallowSession, type TallowSession } from "../src/sdk.js";
import { createEchoStreamFn, createMockModel } from "./mock-model.js";
import { withExclusiveSessionRun } from "./session-run-lock.js";
import { withExclusiveTallowHome } from "./tallow-home-env.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for creating a test session runner. */
export interface SessionRunnerOptions {
	/** Custom stream function (default: echo). */
	streamFn?: StreamFn;
	/** Extension factories for the test session. */
	extensionFactories?: ExtensionFactory[];
	/** Working directory (default: temp dir). */
	cwd?: string;
	/** Session settings overrides applied during creation. */
	settings?: Record<string, unknown>;
}

/** Result from running a prompt through the session. */
export interface RunResult {
	/** All events emitted during the prompt. */
	events: AgentSessionEvent[];
}

// ── Session Runner ───────────────────────────────────────────────────────────

/**
 * Headless test session that runs prompts against a mock model.
 *
 * @example
 * ```typescript
 * const runner = await createSessionRunner({
 *   streamFn: createScriptedStreamFn([{ text: "Hello!" }]),
 *   extensionFactories: [myExtension],
 * });
 * const result = await runner.run("Hi");
 * runner.dispose();
 * ```
 */
export class SessionRunner {
	private _tallowSession: TallowSession;
	private _tmpDir: string | undefined;

	private constructor(tallowSession: TallowSession, tmpDir?: string) {
		this._tallowSession = tallowSession;
		this._tmpDir = tmpDir;
	}

	/**
	 * Create a new test session runner.
	 *
	 * @param options - Runner configuration
	 * @returns Initialized runner ready for `run()` calls
	 */
	static async create(options: SessionRunnerOptions = {}): Promise<SessionRunner> {
		const tmpDir = mkdtempSync(join(tmpdir(), "tallow-test-"));

		const tallowSession = await withExclusiveTallowHome(tmpDir, async () => {
			return await createTallowSession({
				cwd: options.cwd ?? tmpDir,
				model: createMockModel(),
				provider: "mock",
				apiKey: "mock-api-key",
				session: { type: "memory" },
				noBundledExtensions: true,
				noBundledSkills: true,
				extensionFactories: options.extensionFactories,
				settings: options.settings,
			});
		});

		// Replace the agent's stream function with our mock
		const streamFn = options.streamFn ?? createEchoStreamFn();
		tallowSession.session.agent.streamFn = streamFn;

		// Let async session_start handlers settle before first prompt.
		await Promise.resolve();
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});

		return new SessionRunner(tallowSession, tmpDir);
	}

	/** The underlying AgentSession. */
	get session() {
		return this._tallowSession.session;
	}

	/** Extension loading results. */
	get extensions() {
		return this._tallowSession.extensions;
	}

	/**
	 * Send a prompt and collect all events until the agent finishes.
	 *
	 * @param prompt - User prompt text
	 * @returns Collected events from the prompt execution
	 */
	async run(prompt: string): Promise<RunResult> {
		return await withExclusiveSessionRun(async () => {
			const events: AgentSessionEvent[] = [];
			let resolveAgentEnd: (() => void) | undefined;
			let sawAgentEnd = false;
			const agentEndPromise = new Promise<void>((resolve) => {
				resolveAgentEnd = () => {
					if (sawAgentEnd) return;
					sawAgentEnd = true;
					resolve();
				};
			});
			const unsub = this._tallowSession.session.subscribe((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					resolveAgentEnd?.();
				}
			});

			try {
				await this._tallowSession.session.prompt(prompt);
				// On slower CI runners, prompt() can resolve before the final lifecycle
				// event dispatch flushes. Wait briefly for `agent_end` so tests see a
				// complete event sequence deterministically.
				if (!sawAgentEnd) {
					await Promise.race([
						agentEndPromise,
						new Promise<void>((resolve) => {
							setTimeout(resolve, 25);
						}),
					]);
					await Promise.resolve();
				}
			} finally {
				unsub();
			}

			return { events };
		});
	}

	/**
	 * Clean up resources. Call this in afterEach/afterAll.
	 */
	dispose(): void {
		if (this._tmpDir) {
			try {
				rmSync(this._tmpDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup
			}
			this._tmpDir = undefined;
		}
	}
}

/**
 * Convenience factory for creating a session runner.
 *
 * @param options - Runner configuration
 * @returns Initialized runner
 */
export async function createSessionRunner(options?: SessionRunnerOptions): Promise<SessionRunner> {
	return SessionRunner.create(options);
}
