import { describe, expect, test } from "bun:test";
import type { WorkspaceTransitionRequest, WorkspaceTransitionUI } from "../workspace-transition.js";
import { createInteractiveWorkspaceTransitionHost } from "../workspace-transition-interactive.js";

/** Minimal session entry shape for testing extractTaskContext. */
interface FakeSessionEntry {
	id: string;
	message?: { role: string; content: unknown };
	parentId: string | null;
	timestamp: string;
	type: string;
}

interface FakeSession {
	abortCount: number;
	agent: { waitForIdle: () => Promise<void> };
	extensionRunner?: {
		emit: (event: { type: string }) => Promise<void>;
		hasHandlers: (eventName: string) => boolean;
	};
	model?: { id: string; provider: string };
	sendCalls: Array<{
		message: {
			content: string;
			customType: string;
			details?: Record<string, unknown>;
			display: boolean;
		};
		options?: { deliverAs?: "nextTurn" | "followUp" | "steer"; triggerTurn?: boolean };
	}>;
	sendCustomMessage: (
		message: {
			content: string;
			customType: string;
			details?: Record<string, unknown>;
			display: boolean;
		},
		options?: { deliverAs?: "nextTurn" | "followUp" | "steer"; triggerTurn?: boolean }
	) => Promise<void>;
	sessionManager: { getEntries: () => FakeSessionEntry[] };
	thinkingLevel?: "off" | "high";
}

interface FakeMode {
	chatContainer: { clear: () => void };
	compactionQueuedMessages: unknown[];
	initExtensions: () => Promise<void>;
	loadingAnimation?: { stop: () => void };
	pendingMessagesContainer: { clear: () => void };
	pendingTools: Map<string, unknown>;
	renderInitialMessages: () => void;
	resetExtensionUI: () => void;
	session: FakeSession;
	showStatus: (message: string) => void;
	statusContainer: { clear: () => void };
	streamingComponent?: unknown;
	streamingMessage?: unknown;
	subscribeToAgent: () => void;
	ui: { requestRender: (force?: boolean) => void };
	unsubscribe?: (() => void) | undefined;
	updateTerminalTitle: () => void;
}

interface FakeDeps {
	changeDirectoryCalls: string[];
	createSessionCalls: Array<Record<string, unknown>>;
	resolveTrustCalls: string[];
	trustProjectCalls: string[];
}

/**
 * Create a fake session that records abort, shutdown, and custom-message calls.
 *
 * @param label - Identifier used in captured content for debugging
 * @param entries - Optional session entries for extractTaskContext testing
 * @returns Mutable fake session
 */
function createFakeSession(label: string, entries: FakeSessionEntry[] = []): FakeSession {
	const sendCalls: FakeSession["sendCalls"] = [];
	return {
		abort(): void {
			this.abortCount += 1;
		},
		abortCount: 0,
		agent: {
			waitForIdle: async (): Promise<void> => {},
		},
		extensionRunner: {
			emit: async (): Promise<void> => {},
			hasHandlers: (): boolean => true,
		},
		model: { id: `${label}-model`, provider: "test" },
		sendCalls,
		sendCustomMessage: async (message, options): Promise<void> => {
			sendCalls.push({ message, options });
		},
		sessionManager: { getEntries: () => entries },
		thinkingLevel: "high",
	};
}

/**
 * Build a fake user message entry for session manager testing.
 *
 * @param content - Message content (string or content blocks)
 * @param id - Optional entry ID
 * @returns Fake session entry with user role
 */
function fakeUserEntry(content: unknown, id = "u1"): FakeSessionEntry {
	return {
		id,
		message: { role: "user", content },
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "message",
	};
}

/**
 * Build a fake assistant message entry.
 *
 * @param text - Assistant response text
 * @param id - Optional entry ID
 * @returns Fake session entry with assistant role
 */
function fakeAssistantEntry(text: string, id = "a1"): FakeSessionEntry {
	return {
		id,
		message: { role: "assistant", content: text },
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "message",
	};
}

/**
 * Create a fake interactive mode around the provided session.
 *
 * @param session - Active fake session
 * @param events - Shared ordered event log for assertions
 * @returns Fake mode object compatible with the transition host
 */
function createFakeMode(session: FakeSession, events: string[]): FakeMode {
	return {
		chatContainer: {
			clear: (): void => {
				events.push("chat.clear");
			},
		},
		compactionQueuedMessages: ["queued"],
		initExtensions: async (): Promise<void> => {
			events.push("mode.initExtensions");
		},
		loadingAnimation: {
			stop: (): void => {
				events.push("loader.stop");
			},
		},
		pendingMessagesContainer: {
			clear: (): void => {
				events.push("pending.clear");
			},
		},
		pendingTools: new Map([["tool", {}]]),
		renderInitialMessages: (): void => {
			events.push("mode.renderInitialMessages");
		},
		resetExtensionUI: (): void => {
			events.push("mode.resetExtensionUI");
		},
		session,
		showStatus: (message: string): void => {
			events.push(`mode.showStatus:${message}`);
		},
		statusContainer: {
			clear: (): void => {
				events.push("status.clear");
			},
		},
		streamingComponent: { active: true },
		streamingMessage: { role: "assistant" },
		subscribeToAgent: (): void => {
			events.push("mode.subscribeToAgent");
		},
		ui: {
			requestRender: (force?: boolean): void => {
				events.push(`ui.requestRender:${force === true ? "force" : "normal"}`);
			},
		},
		unsubscribe: (): void => {
			events.push("mode.unsubscribe");
		},
		updateTerminalTitle: (): void => {
			events.push("mode.updateTerminalTitle");
		},
	};
}

/**
 * Create a scripted UI for workspace-transition prompts.
 *
 * @param choices - Selector responses consumed in order
 * @param events - Shared ordered event log for assertions
 * @returns UI object plus captured notifications
 */
function createFakeUi(
	choices: string[],
	events: string[]
): { notifications: string[]; ui: WorkspaceTransitionUI } {
	const notifications: string[] = [];
	return {
		notifications,
		ui: {
			notify(message: string): void {
				notifications.push(message);
				events.push(`ui.notify:${message}`);
			},
			async select(title: string, options: string[]): Promise<string | undefined> {
				events.push(`ui.select:${title}`);
				const next = choices.shift();
				if (!next) return undefined;
				return options.find((option) => option === next) ?? next;
			},
			setWorkingMessage(message?: string): void {
				events.push(`ui.working:${message ?? "clear"}`);
			},
		},
	};
}

/**
 * Create injectable dependencies for the transition host.
 *
 * @param nextSession - Session returned after recreation
 * @param trustStatus - Trust status resolved for the target workspace
 * @param events - Shared ordered event log for assertions
 * @returns Dependency bundle plus captured call metadata
 */
function createDeps(
	nextSession: FakeSession,
	trustStatus: "trusted" | "untrusted" | "stale_fingerprint",
	events: string[]
): { deps: Parameters<typeof createInteractiveWorkspaceTransitionHost>[4]; state: FakeDeps } {
	const state: FakeDeps = {
		changeDirectoryCalls: [],
		createSessionCalls: [],
		resolveTrustCalls: [],
		trustProjectCalls: [],
	};
	return {
		deps: {
			changeDirectory: (cwd: string): void => {
				state.changeDirectoryCalls.push(cwd);
				events.push(`deps.chdir:${cwd}`);
			},
			createSession: async (options) => {
				state.createSessionCalls.push(options as Record<string, unknown>);
				events.push(`deps.createSession:${String(options.cwd)}`);
				return {
					extensionOverrides: [],
					extensions: {} as never,
					modelFallbackMessage: undefined,
					resolvedPlugins: [],
					session: nextSession as never,
					sessionId: "next-session",
					version: "test",
				};
			},
			resolveTrust: (cwd: string) => {
				state.resolveTrustCalls.push(cwd);
				events.push(`deps.resolveTrust:${cwd}`);
				return { status: trustStatus };
			},
			trustProject: (cwd: string) => {
				state.trustProjectCalls.push(cwd);
				events.push(`deps.trust:${cwd}`);
				return undefined;
			},
		},
		state,
	};
}

/**
 * Build a transition request using the supplied UI.
 *
 * @param ui - Prompt/notification surface
 * @param initiator - Command or tool initiator
 * @returns Transition request
 */
function createRequest(
	ui: WorkspaceTransitionUI,
	initiator: "command" | "tool" = "tool"
): WorkspaceTransitionRequest {
	return {
		initiator,
		sourceCwd: "/repo/a",
		targetCwd: "/repo/b",
		ui,
	};
}

describe("createInteractiveWorkspaceTransitionHost", () => {
	test("restarts the turn for tool-driven transitions and swaps the session", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous");
		previousSession.agent.waitForIdle = async (): Promise<void> => {
			events.push("session.waitForIdle");
		};
		previousSession.extensionRunner = {
			emit: async (): Promise<void> => {
				events.push("session.shutdown");
			},
			hasHandlers: (): boolean => true,
		};
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps, state } = createDeps(nextSession, "trusted", events);
		const { ui } = createFakeUi(["Enter /repo/b"], events);
		const cleanupSessions: string[] = [];
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			(session) => {
				cleanupSessions.push(session === (nextSession as never) ? "next" : "other");
			},
			deps
		);

		const result = await host.requestTransition(createRequest(ui, "tool"));

		expect(result).toEqual({ status: "completed", trustedOnEntry: true });
		expect(previousSession.abortCount).toBe(1);
		expect(state.changeDirectoryCalls).toEqual(["/repo/b"]);
		expect(state.createSessionCalls).toHaveLength(1);
		expect(state.createSessionCalls[0]).toMatchObject({
			cwd: "/repo/b",
			session: { sessionId: "session-123", type: "open-or-create" },
			thinkingLevel: "high",
		});
		expect(cleanupSessions).toEqual(["next"]);
		expect(mode.session).toBe(nextSession);
		expect(nextSession.sendCalls).toHaveLength(1);
		expect(nextSession.sendCalls[0]?.options).toEqual({ triggerTurn: true });
		expect(nextSession.sendCalls[0]?.message.customType).toBe("workspace-transition");
		expect(nextSession.sendCalls[0]?.message.content).toContain("Workspace transition complete");
		expect(events).toEqual([
			"ui.select:Directory jump — choose the landing zone",
			"deps.resolveTrust:/repo/b",
			"session.waitForIdle",
			"ui.working:Reloading workspace after directory change...",
			"session.shutdown",
			"deps.chdir:/repo/b",
			"deps.createSession:/repo/b",
			"loader.stop",
			"status.clear",
			"pending.clear",
			"chat.clear",
			"mode.resetExtensionUI",
			"mode.unsubscribe",
			"mode.initExtensions",
			"mode.renderInitialMessages",
			"mode.subscribeToAgent",
			"mode.updateTerminalTitle",
			"ui.requestRender:force",
			"ui.working:clear",
		]);
	});

	test("adds a one-shot message without restarting the turn for command transitions", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous");
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps } = createDeps(nextSession, "trusted", events);
		const { ui } = createFakeUi(["Enter /repo/b"], events);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "memory" } },
			"memory-session",
			() => {},
			deps
		);

		const result = await host.requestTransition(createRequest(ui, "command"));

		expect(result).toEqual({ status: "completed", trustedOnEntry: true });
		expect(previousSession.abortCount).toBe(0);
		expect(nextSession.sendCalls).toHaveLength(1);
		expect(nextSession.sendCalls[0]?.options).toBeUndefined();
		expect(events).toContain("mode.showStatus:Changed to /repo/b");
	});

	test("trusts an untrusted target when the user selects trust", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous");
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps, state } = createDeps(nextSession, "untrusted", events);
		const { ui } = createFakeUi(
			["Enter /repo/b", "🔓 Trust folder + reload with repo-controlled surfaces enabled"],
			events
		);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			deps
		);

		const result = await host.requestTransition(createRequest(ui, "command"));

		expect(result).toEqual({ status: "completed", trustedOnEntry: true });
		expect(state.trustProjectCalls).toEqual(["/repo/b"]);
		expect(events).toContain("ui.select:Workspace trust gate — /repo/b (folder is untrusted)");
	});

	test("opens untrusted when the user declines trust", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous");
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps, state } = createDeps(nextSession, "stale_fingerprint", events);
		const { ui } = createFakeUi(
			["Enter /repo/b", "🔒 Open untrusted + reload with repo-controlled surfaces blocked"],
			events
		);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			deps
		);

		const result = await host.requestTransition(createRequest(ui, "command"));

		expect(result).toEqual({ status: "completed", trustedOnEntry: false });
		expect(state.trustProjectCalls).toEqual([]);
		expect(events).toContain(
			"ui.select:Workspace trust gate — /repo/b (stale trust fingerprint detected)"
		);
	});

	test("cancels before transition when the user declines the first prompt", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous");
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps, state } = createDeps(nextSession, "trusted", events);
		const { ui } = createFakeUi(["Stay in /repo/a"], events);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			deps
		);

		const result = await host.requestTransition(createRequest(ui, "tool"));

		expect(result).toEqual({ status: "cancelled" });
		expect(previousSession.abortCount).toBe(0);
		expect(state.createSessionCalls).toEqual([]);
	});

	test("returns unavailable when session recreation fails after shutdown", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous");
		previousSession.extensionRunner = {
			emit: async (): Promise<void> => {
				events.push("session.shutdown");
			},
			hasHandlers: (): boolean => true,
		};
		const mode = createFakeMode(previousSession, events);
		const nextSession = createFakeSession("next");
		const { deps, state } = createDeps(nextSession, "trusted", events);
		const failingDeps = {
			...deps,
			createSession: async (options: Record<string, unknown>) => {
				state.createSessionCalls.push(options);
				throw new Error("session bootstrap failed");
			},
		};
		const { ui } = createFakeUi(["Enter /repo/b"], events);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			failingDeps
		);

		const result = await host.requestTransition(createRequest(ui, "command"));

		expect(result).toEqual({ reason: "session bootstrap failed", status: "unavailable" });
		expect(events).toContain("session.shutdown");
		expect(state.changeDirectoryCalls).toEqual(["/repo/b", "/repo/a"]);
		expect(mode.session).toBe(previousSession);
	});

	test("blocks overlapping transitions while one is still in flight", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous");
		const mode = createFakeMode(previousSession, events);
		const nextSession = createFakeSession("next");
		let createSessionEntered = false;
		let resolveCreateSession:
			| ((value: {
					extensionOverrides: [];
					extensions: never;
					resolvedPlugins: [];
					session: never;
					sessionId: string;
					version: string;
			  }) => void)
			| null = null;
		const createSessionPromise = new Promise<{
			extensionOverrides: [];
			extensions: never;
			resolvedPlugins: [];
			session: never;
			sessionId: string;
			version: string;
		}>((resolve) => {
			resolveCreateSession = resolve;
		});
		const { deps } = createDeps(nextSession, "trusted", events);
		const blockingDeps = {
			...deps,
			createSession: async () => {
				createSessionEntered = true;
				return createSessionPromise;
			},
		};
		const { ui } = createFakeUi(["Enter /repo/b", "Enter /repo/b"], events);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			blockingDeps
		);

		const first = host.requestTransition(createRequest(ui, "command"));
		while (!createSessionEntered) {
			await Promise.resolve();
		}
		const second = await host.requestTransition(createRequest(ui, "command"));
		resolveCreateSession?.({
			extensionOverrides: [],
			extensions: {} as never,
			resolvedPlugins: [],
			session: nextSession as never,
			sessionId: "late",
			version: "test",
		});
		await first;

		expect(second).toEqual({
			reason: "Another workspace transition is already in progress.",
			status: "unavailable",
		});
	});

	test("carries last user message as task context in tool-driven transitions", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous", [
			fakeUserEntry("fix the bug in auth.ts"),
			fakeAssistantEntry("I'll look at auth.ts now."),
		]);
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps } = createDeps(nextSession, "trusted", events);
		const { ui } = createFakeUi(["Enter /repo/b"], events);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			deps
		);

		await host.requestTransition(createRequest(ui, "tool"));

		expect(nextSession.sendCalls).toHaveLength(1);
		const content = nextSession.sendCalls[0]?.message.content ?? "";
		expect(content).toContain("Task context carried forward");
		expect(content).toContain("fix the bug in auth.ts");
		expect(content).toContain("Continue working on the task above");
	});

	test("uses generic message when session has no user messages", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous", []);
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps } = createDeps(nextSession, "trusted", events);
		const { ui } = createFakeUi(["Enter /repo/b"], events);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			deps
		);

		await host.requestTransition(createRequest(ui, "tool"));

		const content = nextSession.sendCalls[0]?.message.content ?? "";
		expect(content).toContain("Treat the interrupted turn as ended");
		expect(content).not.toContain("Task context carried forward");
	});

	test("carries task context from array content blocks", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous", [
			fakeUserEntry([
				{ type: "text", text: "look at " },
				{ type: "image", source: { type: "base64", data: "..." } },
				{ type: "text", text: "this screenshot" },
			]),
		]);
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps } = createDeps(nextSession, "trusted", events);
		const { ui } = createFakeUi(["Enter /repo/b"], events);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			deps
		);

		await host.requestTransition(createRequest(ui, "tool"));

		const content = nextSession.sendCalls[0]?.message.content ?? "";
		expect(content).toContain("look at ");
		expect(content).toContain("this screenshot");
	});

	test("truncates long task context to 2000 characters", async () => {
		const events: string[] = [];
		const longMessage = "x".repeat(3000);
		const previousSession = createFakeSession("previous", [fakeUserEntry(longMessage)]);
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps } = createDeps(nextSession, "trusted", events);
		const { ui } = createFakeUi(["Enter /repo/b"], events);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			deps
		);

		await host.requestTransition(createRequest(ui, "tool"));

		const content = nextSession.sendCalls[0]?.message.content ?? "";
		expect(content).toContain("Task context carried forward");
		expect(content).toContain("(truncated)");
		// Full 3000-char message should NOT appear
		expect(content).not.toContain(longMessage);
	});

	test("picks the LAST user message, not the first", async () => {
		const events: string[] = [];
		const previousSession = createFakeSession("previous", [
			fakeUserEntry("first question", "u1"),
			fakeAssistantEntry("first answer", "a1"),
			fakeUserEntry("second question", "u2"),
			fakeAssistantEntry("second answer", "a2"),
		]);
		const nextSession = createFakeSession("next");
		const mode = createFakeMode(previousSession, events);
		const { deps } = createDeps(nextSession, "trusted", events);
		const { ui } = createFakeUi(["Enter /repo/b"], events);
		const host = createInteractiveWorkspaceTransitionHost(
			mode as Parameters<typeof createInteractiveWorkspaceTransitionHost>[0],
			{ session: { type: "new" } },
			"session-123",
			() => {},
			deps
		);

		await host.requestTransition(createRequest(ui, "tool"));

		const content = nextSession.sendCalls[0]?.message.content ?? "";
		expect(content).toContain("second question");
		expect(content).not.toContain("first question");
	});
});
