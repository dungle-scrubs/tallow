/**
 * E2E: Cross-extension interop event wiring.
 *
 * Verifies that extensions communicating via the EventBus interop protocol
 * respond correctly to state requests and emit well-formed snapshots.
 *
 * Since the EventBus isn't exposed on the session object, we inject a
 * test extension that captures the `pi.events` reference during load.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createTallowSession, type TallowSession } from "../../src/sdk.js";
import {
	createEchoStreamFn,
	createMockModel,
	createScriptedStreamFn,
} from "../../test-utils/mock-model.js";
import { resolveExtensionPaths, STANDARD_EXTENSIONS } from "./profiles.js";

// ── EventBus capture ─────────────────────────────────────────────────────────

interface EventBusRef {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

let capturedEventBus: EventBusRef | undefined;

/**
 * Extension factory that captures the EventBus reference.
 *
 * @param pi - Extension API
 */
function eventBusCaptureExtension(pi: ExtensionAPI): void {
	capturedEventBus = pi.events;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpHome: string | undefined;

/**
 * Create a session with standard extensions + our capture extension.
 *
 * @returns TallowSession with eventBus captured in module-level variable
 */
async function createInteropSession(): Promise<TallowSession> {
	capturedEventBus = undefined;
	tmpHome = mkdtempSync(join(tmpdir(), "tallow-interop-e2e-"));
	const originalHome = process.env.TALLOW_HOME;
	process.env.TALLOW_HOME = tmpHome;

	try {
		const tallow = await createTallowSession({
			cwd: tmpHome,
			model: createMockModel(),
			provider: "mock",
			apiKey: "mock-api-key",
			session: { type: "memory" },
			noBundledExtensions: true,
			noBundledSkills: true,
			additionalExtensions: resolveExtensionPaths(STANDARD_EXTENSIONS),
			extensionFactories: [eventBusCaptureExtension],
		});

		tallow.session.agent.streamFn = createScriptedStreamFn([{ text: "ok" }]);
		return tallow;
	} finally {
		if (originalHome !== undefined) {
			process.env.TALLOW_HOME = originalHome;
		} else {
			delete process.env.TALLOW_HOME;
		}
	}
}

afterEach(() => {
	if (tmpHome) {
		try {
			rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		tmpHome = undefined;
	}
	capturedEventBus = undefined;
});

// Interop event channel names (mirrored from _shared/interop-events.ts)
const INTEROP = {
	backgroundTasksSnapshot: "interop.v1.background-tasks.snapshot",
	stateRequest: "interop.v1.state.request",
	subagentsSnapshot: "interop.v1.subagents.snapshot",
	teamsSnapshot: "interop.v1.teams.snapshot",
} as const;

describe("Interop Event Wiring", () => {
	it("captures EventBus from extension API", async () => {
		await createInteropSession();
		expect(capturedEventBus).toBeDefined();
		expect(typeof capturedEventBus!.on).toBe("function");
		expect(typeof capturedEventBus!.emit).toBe("function");
	});

	it("state request triggers snapshot responses", async () => {
		const tallow = await createInteropSession();

		// Run a prompt to trigger session_start handlers (which wire up interop listeners)
		const events: unknown[] = [];
		const unsub = tallow.session.subscribe((e) => events.push(e));
		await tallow.session.prompt("init");
		unsub();

		// Collect snapshots emitted in response to a state request
		const received: string[] = [];
		const bus = capturedEventBus!;

		const busUnsubs = [
			bus.on(INTEROP.backgroundTasksSnapshot, () => received.push("background-tasks")),
			bus.on(INTEROP.subagentsSnapshot, () => received.push("subagents")),
		];

		bus.emit(INTEROP.stateRequest, { schemaVersion: 1, requester: "e2e-test" });

		// Give async handlers a tick to fire
		await new Promise((r) => setTimeout(r, 50));
		for (const u of busUnsubs) u();

		expect(received).toContain("background-tasks");
		expect(received).toContain("subagents");
	});

	it("emitting on unknown channel does not crash", async () => {
		await createInteropSession();
		// Should not throw
		capturedEventBus!.emit("interop.v99.does-not-exist", { garbage: true });
	});

	it("snapshot payloads contain expected schema version", async () => {
		const tallow = await createInteropSession();

		const events: unknown[] = [];
		const unsub = tallow.session.subscribe((e) => events.push(e));
		await tallow.session.prompt("init");
		unsub();

		const payloads: unknown[] = [];
		const bus = capturedEventBus!;

		const busUnsubs = [
			bus.on(INTEROP.backgroundTasksSnapshot, (data: unknown) => payloads.push(data)),
			bus.on(INTEROP.subagentsSnapshot, (data: unknown) => payloads.push(data)),
		];

		bus.emit(INTEROP.stateRequest, { schemaVersion: 1, requester: "e2e-test" });
		await new Promise((r) => setTimeout(r, 50));
		for (const u of busUnsubs) u();

		expect(payloads.length).toBeGreaterThan(0);
		for (const payload of payloads) {
			expect(payload).toHaveProperty("schemaVersion", 1);
		}
	});
});
