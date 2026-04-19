import { afterEach, describe, expect, it } from "bun:test";
import { patchInteractiveModePrototype } from "../interactive-mode-patch.js";
import {
	getResetDiagnosticsForTests,
	resetResetDiagnosticsForTests,
} from "../reset-diagnostics.js";

interface FakeMessageContent {
	text?: string;
	thinking?: string;
	type: string;
}

interface FakeMessage {
	content: FakeMessageContent[];
	errorMessage?: string;
	role: "assistant" | "user";
	stopReason?: "aborted" | "error" | "stop";
}

interface FakeEvent {
	aborted?: boolean;
	errorMessage?: string;
	message?: FakeMessage;
	result?: unknown;
	type?: string;
	willRetry?: boolean;
}

class FakeInteractiveMode {
	defaultEditor: { onEscape?: () => void } = {};
	editor: { getText: () => string; setText: (text: string) => void };
	editorText = "";
	escapeCalls = 0;
	executeCompactionCalls = 0;
	executeCompactionResult: unknown = { summary: "ok" };
	flushCalls = 0;
	followUpQueue: string[] = [];
	handleBashCommandCalls = 0;
	handleCompactCommandCalls = 0;
	handleEventCalls = 0;
	lastHandledEvent: FakeEvent | undefined;
	lastRestoredAbort: boolean | undefined;
	lifecycleCalls: string[] = [];
	loadingAnimation: { stop?: () => void } | null = null;
	loaderStopCalls = 0;
	notifyCalls: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	pendingBashComponents: unknown[] = [];
	pendingMessagesContainer = {
		clear: (): void => {
			this.lifecycleCalls.push("pendingMessagesContainer.clear");
		},
	};
	pendingTools = new Map<string, unknown>();
	pendingWorkingMessage: unknown = "stale";
	forceRenderRequests = 0;
	renderGraceResets = 0;
	renderRequests = 0;
	renderBatchBegins = 0;
	renderBatchEnds = 0;
	scrollbackClearRequests = 0;
	session: {
		_sessionStartEvent?: { reason?: string };
		clearQueue: () => { followUp: string[]; steering: string[] };
		extensionRunner: { compactFn: ((options?: unknown) => void) | undefined };
		getFollowUpMessages: () => string[];
		getSteeringMessages: () => string[];
		isStreaming: boolean;
	};
	sessionManager = {
		buildSessionContext: (): { messages: unknown[] } => ({ messages: [] }),
		getEntries: (): Array<{ type: string }> => [],
	};
	steeringQueue: string[] = [];
	statusClears = 0;
	updateCalls = 0;
	ui = {
		beginRenderBatch: (): void => {
			this.lifecycleCalls.push("ui.beginRenderBatch");
			this.renderBatchBegins++;
		},
		endRenderBatch: (): void => {
			this.lifecycleCalls.push("ui.endRenderBatch");
			this.renderBatchEnds++;
		},
		requestRender: (force?: boolean): void => {
			this.lifecycleCalls.push("ui.requestRender");
			this.renderRequests++;
			if (force) this.forceRenderRequests++;
		},
		requestScrollbackClear: (): void => {
			this.lifecycleCalls.push("ui.requestScrollbackClear");
			this.scrollbackClearRequests++;
		},
		resetRenderGrace: (): void => {
			this.lifecycleCalls.push("ui.resetRenderGrace");
			this.renderGraceResets++;
		},
	};

	constructor() {
		this.editor = {
			getText: () => this.editorText,
			setText: (text: string) => {
				this.editorText = text;
			},
		};
		this.session = {
			clearQueue: () => {
				const steering = [...this.steeringQueue];
				const followUp = [...this.followUpQueue];
				this.steeringQueue = [];
				this.followUpQueue = [];
				return { followUp, steering };
			},
			extensionRunner: { compactFn: undefined },
			getFollowUpMessages: () => this.followUpQueue,
			getSteeringMessages: () => this.steeringQueue,
			isStreaming: false,
		};
	}

	/**
	 * Base handleEvent implementation used by the patch wrapper.
	 *
	 * @param _event - Event payload
	 * @returns Promise resolved with marker text
	 */
	async handleEvent(event: FakeEvent): Promise<string> {
		this.handleEventCalls++;
		this.lastHandledEvent = event;
		return "ok";
	}

	/**
	 * Base handleBashCommand implementation used by the patch wrapper.
	 *
	 * @param _command - Bash command text
	 * @param _excludeFromContext - Whether command output is excluded from context
	 * @returns Promise resolved with marker text
	 */
	async handleBashCommand(_command: string, _excludeFromContext = false): Promise<string> {
		this.handleBashCommandCalls++;
		this.lifecycleCalls.push("handleBashCommand:start");
		await Promise.resolve();
		if (this.session.isStreaming) {
			this.pendingBashComponents.push({ deferred: true });
		}
		this.lifecycleCalls.push("handleBashCommand:end");
		return "bash-ok";
	}

	/** Tracks getUserInput calls. */
	getUserInputCalls = 0;

	/**
	 * Base getUserInput implementation used by the patch wrapper.
	 *
	 * @returns Promise resolved with marker text
	 */
	async getUserInput(): Promise<string> {
		this.getUserInputCalls++;
		return "user-input";
	}

	/**
	 * Base setupKeyHandlers implementation that installs the default escape handler.
	 *
	 * @returns Nothing
	 */
	setupKeyHandlers(): void {
		this.defaultEditor.onEscape = () => {
			this.escapeCalls++;
		};
	}

	/**
	 * Base init implementation used by the patch wrapper.
	 *
	 * @returns Promise resolved after recording the lifecycle step
	 */
	async init(): Promise<void> {
		this.lifecycleCalls.push("init");
	}

	showLoadedResourcesCalls = 0;
	showPackageUpdateNotificationCalls = 0;
	showStartupNoticesCalls = 0;
	showWarningCalls = 0;
	showNewVersionNotificationCalls = 0;

	/**
	 * Base initExtensions implementation used by the patch wrapper.
	 *
	 * @returns Promise resolved after recording the lifecycle step
	 */
	async initExtensions(): Promise<void> {
		this.lifecycleCalls.push("initExtensions");
	}

	showLoadedResources(): void {
		this.lifecycleCalls.push("showLoadedResources");
		this.showLoadedResourcesCalls++;
	}

	showStartupNoticesIfNeeded(): void {
		this.lifecycleCalls.push("showStartupNoticesIfNeeded");
		this.showStartupNoticesCalls++;
	}

	showWarning(_message: string): void {
		this.lifecycleCalls.push("showWarning");
		this.showWarningCalls++;
	}

	showNewVersionNotification(_version: string): void {
		this.lifecycleCalls.push("showNewVersionNotification");
		this.showNewVersionNotificationCalls++;
	}

	showPackageUpdateNotification(_updates: unknown[]): void {
		this.lifecycleCalls.push("showPackageUpdateNotification");
		this.showPackageUpdateNotificationCalls++;
	}

	/**
	 * Base reload implementation used by the patch wrapper.
	 *
	 * @returns Promise resolved after recording the lifecycle step
	 */
	async handleReloadCommand(): Promise<void> {
		this.lifecycleCalls.push("handleReloadCommand");
	}

	/**
	 * Base showSelector implementation used by the patch wrapper.
	 *
	 * @param create - Selector factory receiving a done callback
	 * @returns Factory result
	 */
	showSelector(create: (done: () => void) => unknown): unknown {
		this.lifecycleCalls.push("showSelector");
		return create(() => {
			this.lifecycleCalls.push("showSelector.done");
		});
	}

	/**
	 * Base renderInitialMessages implementation used by the patch wrapper.
	 *
	 * @returns Nothing
	 */
	renderInitialMessages(): void {
		this.lifecycleCalls.push("renderInitialMessages");
	}

	/**
	 * Base handleRuntimeSessionChange implementation used by the patch wrapper.
	 *
	 * @returns Promise resolved after recording the lifecycle step
	 */
	async handleRuntimeSessionChange(): Promise<void> {
		this.lifecycleCalls.push("handleRuntimeSessionChange");
	}

	/**
	 * Base rebuildChatFromMessages implementation used by the patch wrapper.
	 *
	 * @returns Nothing
	 */
	rebuildChatFromMessages(): void {
		this.lifecycleCalls.push("rebuildChatFromMessages");
	}

	/**
	 * Base renderCurrentSessionState implementation used by the patch wrapper.
	 *
	 * @returns Nothing
	 */
	renderCurrentSessionState(): void {
		this.lifecycleCalls.push("renderCurrentSessionState");
	}

	/**
	 * Base executeCompaction implementation used by the patch wrapper.
	 *
	 * @param _customInstructions - Optional compaction instructions
	 * @param _isAuto - Whether the compaction is automatic
	 * @returns Configured mock compaction result
	 */
	async executeCompaction(_customInstructions?: string, _isAuto = false): Promise<unknown> {
		this.executeCompactionCalls++;
		this.lifecycleCalls.push("executeCompaction");
		return this.executeCompactionResult;
	}

	/**
	 * Upstream compact command path used when executeCompaction is unavailable.
	 *
	 * @param _customInstructions - Optional compaction instructions
	 * @returns Promise resolved after recording the lifecycle step
	 */
	async handleCompactCommand(_customInstructions?: string): Promise<void> {
		this.handleCompactCommandCalls++;
		this.lifecycleCalls.push("handleCompactCommand");
	}

	/**
	 * Snapshot current queued messages.
	 *
	 * @returns Queued steering/follow-up messages
	 */
	getAllQueuedMessages(): { followUp: string[]; steering: string[] } {
		return { followUp: [], steering: [] };
	}

	/**
	 * Restore queued messages to editor.
	 *
	 * @param options - Restore options
	 * @returns True when restore executed
	 */
	restoreQueuedMessagesToEditor(options?: { abort?: boolean }): boolean {
		this.lastRestoredAbort = options?.abort;
		return true;
	}

	/**
	 * Count deferred bash flush calls and move pending components to chat.
	 *
	 * @returns Nothing
	 */
	flushPendingBashComponents(): void {
		this.flushCalls++;
		this.lifecycleCalls.push("flushPendingBashComponents");
		this.pendingBashComponents = [];
	}

	/**
	 * Count display refresh calls.
	 *
	 * @returns Nothing
	 */
	updatePendingMessagesDisplay(): void {
		this.lifecycleCalls.push("updatePendingMessagesDisplay");
		this.updateCalls++;
	}

	chatContainer = {
		clear: (): void => {
			this.lifecycleCalls.push("chatContainer.clear");
		},
	};

	resetExtensionUI(): void {
		this.lifecycleCalls.push("resetExtensionUI");
	}

	unsubscribe = (): void => {
		this.lifecycleCalls.push("unsubscribe");
	};

	statusContainer = {
		clear: (): void => {
			this.lifecycleCalls.push("statusContainer.clear");
			this.statusClears++;
		},
	};

	/**
	 * Build extension UI context with a setWorkingMessage implementation similar
	 * to InteractiveMode.
	 *
	 * @returns Extension UI context object
	 */
	createExtensionUIContext(): {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setWorkingMessage: (message?: string) => void;
	} {
		return {
			notify: (message: string, type?: "info" | "warning" | "error"): void => {
				this.notifyCalls.push({ message, type });
			},
			setWorkingMessage: (message?: string): void => {
				if (this.loadingAnimation) {
					return;
				}
				this.pendingWorkingMessage = message;
			},
		};
	}
}

/**
 * Runs an async action with setTimeout forced to near-immediate callbacks.
 *
 * @param action - Action to execute under patched timers
 * @returns Nothing
 */
async function withImmediateTimers(action: () => Promise<void>): Promise<void> {
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((
		callback: Parameters<typeof setTimeout>[0],
		delay?: Parameters<typeof setTimeout>[1],
		...args: unknown[]
	) => {
		return originalSetTimeout(
			() => {
				if (typeof callback === "function") {
					callback(...args);
				}
			},
			Math.min(typeof delay === "number" ? delay : 0, 5)
		);
	}) as typeof setTimeout;

	try {
		await action();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
}

afterEach(() => {
	resetResetDiagnosticsForTests();
});

describe("patchInteractiveModePrototype", () => {
	it("applies agent_end cleanup with bash flush before pending-message refresh", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);

		const mode = new FakeInteractiveMode();
		mode.pendingBashComponents = [{ deferred: true }];
		const result = await mode.handleEvent({ type: "agent_end" });

		expect(result).toBe("ok");
		expect(mode.handleEventCalls).toBe(1);
		expect(mode.flushCalls).toBe(1);
		expect(mode.pendingBashComponents).toEqual([]);
		expect(mode.pendingWorkingMessage).toBeUndefined();
		// statusContainer IS cleared on a normal agent_end (no active compaction).
		// During compaction, the flag prevents clearing the compacting loader
		// (plan 159, bug 2). For normal turns we must clear to avoid a stale spinner.
		expect(mode.statusClears).toBe(1);
		expect(mode.updateCalls).toBe(1);
		// Normal turn cleanup should not force a full redraw. Forced redraws
		// replay transcript history and make the UI jump.
		expect(mode.renderRequests).toBe(1);
		expect(mode.forceRenderRequests).toBe(0);

		const flushCallIndex = mode.lifecycleCalls.indexOf("flushPendingBashComponents");
		const updateCallIndex = mode.lifecycleCalls.indexOf("updatePendingMessagesDisplay");
		expect(flushCallIndex).toBeGreaterThanOrEqual(0);
		expect(updateCallIndex).toBeGreaterThanOrEqual(0);
		expect(flushCallIndex).toBeLessThan(updateCallIndex);
	});

	it("stops loadingAnimation at agent_end as safety net", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);

		const mode = new FakeInteractiveMode();
		let stopCalled = false;
		mode.loadingAnimation = {
			stop: () => {
				stopCalled = true;
			},
		};
		await mode.handleEvent({ type: "agent_end" });

		expect(stopCalled).toBe(true);
		expect(mode.loadingAnimation).toBeNull();
	});

	it("clears stale loader in getUserInput as last-resort safety net", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);

		const mode = new FakeInteractiveMode();
		let stopCalled = false;
		mode.loadingAnimation = {
			stop: () => {
				stopCalled = true;
			},
		};
		mode.pendingWorkingMessage = "stale";

		// getUserInput is called by the main loop when the agent is idle.
		// It should clear any lingering loader regardless of whether
		// _emit(agent_end) has fired yet.
		const result = await mode.getUserInput();

		expect(result).toBe("user-input");
		expect(stopCalled).toBe(true);
		expect(mode.loadingAnimation).toBeNull();
		expect(mode.pendingWorkingMessage).toBeUndefined();
		expect(mode.statusClears).toBe(1);
		expect(mode.renderRequests).toBe(1);
		expect(mode.forceRenderRequests).toBe(0);
	});

	it("suppresses overflow payloads while keeping a visible overflow indicator", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);

		const overflowPayloads = [
			'Codex error: {"type":"error","code":"context_length_exceeded","message":"prompt is too long"}',
			// Provider fallback path: HTTP status with no body still signals overflow.
			"413 (no body)",
		] as const;

		for (const errorMessage of overflowPayloads) {
			const mode = new FakeInteractiveMode();

			await mode.handleEvent({
				type: "message_end",
				message: {
					content: [{ thinking: "internal trace", type: "thinking" }],
					errorMessage,
					role: "assistant",
					stopReason: "error",
				},
			});

			expect(mode.lastHandledEvent?.message?.stopReason).toBe("stop");
			expect(mode.lastHandledEvent?.message?.errorMessage).toBeUndefined();
			const visibleTextBlocks = (mode.lastHandledEvent?.message?.content ?? []).filter(
				(part) =>
					part.type === "text" &&
					typeof part.text === "string" &&
					part.text.includes("Context overflow detected")
			);
			expect(visibleTextBlocks.length).toBeGreaterThan(0);
		}
	});

	it("keeps overflow-like message_end errors unchanged when tool calls are present", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		const originalMessage =
			'Codex error: {"type":"error","code":"context_length_exceeded","message":"prompt is too long"}';

		await mode.handleEvent({
			type: "message_end",
			message: {
				// keep stopReason=error when tool calls exist so pending tool rows
				// can resolve correctly in InteractiveMode.
				content: [{ type: "toolCall" }],
				errorMessage: originalMessage,
				role: "assistant",
				stopReason: "error",
			},
		});

		expect(mode.lastHandledEvent?.message?.stopReason).toBe("error");
		expect(mode.lastHandledEvent?.message?.errorMessage).toBe(originalMessage);
	});

	it("keeps non-overflow message_end errors unchanged", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);

		const nonOverflowErrors = [
			"401 Unauthorized: invalid API key",
			"413 Request Entity Too Large",
		] as const;

		for (const originalMessage of nonOverflowErrors) {
			const mode = new FakeInteractiveMode();

			await mode.handleEvent({
				type: "message_end",
				message: {
					content: [],
					errorMessage: originalMessage,
					role: "assistant",
					stopReason: "error",
				},
			});

			expect(mode.lastHandledEvent?.message?.stopReason).toBe("error");
			expect(mode.lastHandledEvent?.message?.errorMessage).toBe(originalMessage);
		}
	});

	it("warns when retry continuation does not start after auto-compaction end", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);

		await withImmediateTimers(async () => {
			const mode = new FakeInteractiveMode();
			await mode.handleEvent({ type: "auto_compaction_end", willRetry: true });
			await new Promise((resolve) => setTimeout(resolve, 10));

			const warning = mode.notifyCalls.find(
				(call) => call.type === "warning" && call.message.includes("continuation did not start")
			);
			expect(warning).toBeDefined();
		});
	});

	it("disarms retry watchdog when continuation starts", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);

		await withImmediateTimers(async () => {
			const mode = new FakeInteractiveMode();
			await mode.handleEvent({ type: "auto_compaction_end", willRetry: true });
			await mode.handleEvent({ type: "message_start" });
			await new Promise((resolve) => setTimeout(resolve, 10));

			const warning = mode.notifyCalls.find((call) =>
				call.message.includes("continuation did not start")
			);
			expect(warning).toBeUndefined();
		});
	});

	it("warns on ambiguous auto-compaction terminal states", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		await mode.handleEvent({ type: "auto_compaction_end" });

		const warning = mode.notifyCalls.find(
			(call) => call.type === "warning" && call.message.includes("without a clear result")
		);
		expect(warning).toBeDefined();
	});

	it("does not warn on non-ambiguous auto-compaction terminal states", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		await mode.handleEvent({ result: { summary: "ok" }, type: "auto_compaction_end" });
		await mode.handleEvent({ aborted: true, type: "auto_compaction_end" });
		await mode.handleEvent({ errorMessage: "quota exceeded", type: "auto_compaction_end" });

		const warning = mode.notifyCalls.find((call) =>
			call.message.includes("without a clear result")
		);
		expect(warning).toBeUndefined();
	});

	it("flushes deferred bash output after wrapped handleBashCommand and refreshes UI", async () => {
		class BashCommandMode extends FakeInteractiveMode {}

		patchInteractiveModePrototype(BashCommandMode.prototype as never);
		const mode = new BashCommandMode();
		mode.session.isStreaming = true;

		const result = await mode.handleBashCommand("echo hi", false);

		expect(result).toBe("bash-ok");
		expect(mode.handleBashCommandCalls).toBe(1);
		expect(mode.flushCalls).toBe(1);
		expect(mode.updateCalls).toBeGreaterThanOrEqual(1);
		expect(mode.renderRequests).toBeGreaterThanOrEqual(1);
		expect(mode.pendingBashComponents).toEqual([]);

		const bashEndIndex = mode.lifecycleCalls.indexOf("handleBashCommand:end");
		const flushCallIndex = mode.lifecycleCalls.indexOf("flushPendingBashComponents");
		const updateCallIndex = mode.lifecycleCalls.indexOf("updatePendingMessagesDisplay");
		expect(bashEndIndex).toBeGreaterThanOrEqual(0);
		expect(flushCallIndex).toBeGreaterThan(bashEndIndex);
		expect(updateCallIndex).toBeGreaterThan(flushCallIndex);
	});

	it("restores queued messages on idle Escape", () => {
		class QueuedEscapeMode extends FakeInteractiveMode {
			override getAllQueuedMessages(): { followUp: string[]; steering: string[] } {
				return { followUp: [], steering: ["stale steer"] };
			}
		}

		patchInteractiveModePrototype(QueuedEscapeMode.prototype as never);
		const mode = new QueuedEscapeMode();
		mode.setupKeyHandlers();

		expect(typeof mode.defaultEditor.onEscape).toBe("function");
		mode.defaultEditor.onEscape?.();

		expect(mode.escapeCalls).toBe(0);
		expect(mode.lastRestoredAbort).toBe(false);
	});

	it("keeps original Escape behavior during active loading", () => {
		class LoadingEscapeMode extends FakeInteractiveMode {
			override getAllQueuedMessages(): { followUp: string[]; steering: string[] } {
				return { followUp: [], steering: ["queued"] };
			}
		}

		patchInteractiveModePrototype(LoadingEscapeMode.prototype as never);
		const mode = new LoadingEscapeMode();
		mode.loadingAnimation = { active: true };
		mode.setupKeyHandlers();
		mode.defaultEditor.onEscape?.();

		expect(mode.escapeCalls).toBe(1);
		expect(mode.lastRestoredAbort).toBeUndefined();
	});

	it("resets render grace around selector swaps", () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		let done: (() => void) | undefined;

		mode.showSelector((selectorDone) => {
			done = selectorDone;
			return { component: "selector" };
		});
		done?.();

		expect(mode.renderGraceResets).toBe(2);
		expect(mode.renderRequests).toBe(2);
		expect(mode.lifecycleCalls).toContain("ui.resetRenderGrace");
	});

	it("binds settings submenu layout transitions to stable renders", () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		let layoutTransition: (() => void) | undefined;

		mode.showSelector(() => ({
			component: {
				getSettingsList: () => ({
					setLayoutTransitionCallback: (callback?: () => void) => {
						layoutTransition = callback;
					},
				}),
			},
			focus: "selector",
		}));

		expect(typeof layoutTransition).toBe("function");
		const resetsBefore = mode.renderGraceResets;
		const rendersBefore = mode.renderRequests;
		layoutTransition?.();
		expect(mode.renderGraceResets).toBe(resetsBefore + 1);
		expect(mode.renderRequests).toBe(rendersBefore + 1);
	});

	it("uses a batched forced render for init when continuing an existing session", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.sessionManager.buildSessionContext = () => ({ messages: [{ role: "user" }] });

		await mode.init();

		expect(mode.renderBatchBegins).toBe(1);
		expect(mode.renderBatchEnds).toBe(1);
		expect(mode.forceRenderRequests).toBe(1);
		expect(mode.lifecycleCalls).toContain("init");
	});

	it("uses restore batching when persisted entries exist even if session context is empty", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.sessionManager.getEntries = () => [{ type: "message" }];

		await mode.init();

		expect(mode.renderBatchBegins).toBe(1);
		expect(mode.renderBatchEnds).toBe(1);
		expect(mode.forceRenderRequests).toBe(1);
	});

	it("skips initial history render for startup continue sessions", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.session._sessionStartEvent = { reason: "resume" };
		mode.sessionManager.getEntries = () => [{ type: "message" }];

		await mode.init();

		expect(mode.lifecycleCalls).not.toContain("renderInitialMessages");
		expect(mode.forceRenderRequests).toBe(1);
	});

	it("suppresses startup chat noise while restoring an existing session", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.sessionManager.getEntries = () => [{ type: "message" }];

		await mode.init();
		mode.showLoadedResources();
		mode.showStartupNoticesIfNeeded();
		mode.showWarning("warning");
		mode.showNewVersionNotification("1.0.0");
		mode.showPackageUpdateNotification([]);

		expect(mode.showLoadedResourcesCalls).toBe(0);
		expect(mode.showStartupNoticesCalls).toBe(0);
		expect(mode.showWarningCalls).toBe(0);
		expect(mode.showNewVersionNotificationCalls).toBe(0);
		expect(mode.showPackageUpdateNotificationCalls).toBe(0);

		await mode.handleEvent({ type: "turn_start" });
		mode.showWarning("warning");
		expect(mode.showWarningCalls).toBe(1);
	});

	it("resets render grace before renderInitialMessages", () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		mode.renderInitialMessages();

		expect(mode.renderGraceResets).toBe(1);
		expect(mode.renderRequests).toBe(1);
		expect(mode.lifecycleCalls).toContain("renderInitialMessages");
	});

	it("resets render grace before rebuildChatFromMessages", () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		mode.rebuildChatFromMessages();

		expect(mode.renderGraceResets).toBe(1);
		expect(mode.renderRequests).toBe(1);
		expect(mode.lifecycleCalls).toContain("rebuildChatFromMessages");
	});

	it("forces a scrollback-clearing redraw when rebuilding session state", () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		mode.renderCurrentSessionState();

		expect(mode.renderBatchBegins).toBe(1);
		expect(mode.renderBatchEnds).toBe(1);
		expect(mode.renderGraceResets).toBe(1);
		expect(mode.scrollbackClearRequests).toBe(1);
		expect(mode.forceRenderRequests).toBe(1);
		expect(mode.lifecycleCalls).toContain("renderInitialMessages");
		expect(
			getResetDiagnosticsForTests().filter(
				(event) => event.kind === "reset_start" || event.kind === "reset_complete"
			)
		).toEqual([
			{
				kind: "reset_start",
				reason: "interactive-render-current-session-state",
				timestamp: expect.any(Number),
			},
			{
				kind: "reset_complete",
				reason: "interactive-render-current-session-state",
				timestamp: expect.any(Number),
			},
		]);
	});

	it("uses the shared reset helper during runtime session changes", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		await mode.handleRuntimeSessionChange();

		expect(mode.lifecycleCalls).toContain("handleRuntimeSessionChange");
		expect(mode.lifecycleCalls).toContain("resetExtensionUI");
		expect(mode.lifecycleCalls).toContain("unsubscribe");
		expect(mode.statusClears).toBe(1);
		expect(
			getResetDiagnosticsForTests().filter(
				(event) => event.kind === "reset_start" || event.kind === "reset_complete"
			)
		).toEqual([
			{
				kind: "reset_start",
				reason: "interactive-runtime-session-change",
				timestamp: expect.any(Number),
			},
			{
				kind: "reset_complete",
				reason: "interactive-runtime-session-change",
				timestamp: expect.any(Number),
			},
		]);
	});

	it("allows idle setWorkingMessage for post-compaction resuming indicators", () => {
		// The setWorkingMessage guard that blocked all idle non-empty messages
		// was removed (plan 159, bug 3). Stale messages are now handled by the
		// agent_end patch clearing pendingWorkingMessage. Post-compaction messages
		// like "Resuming task…" need to queue while idle.
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		const uiContext = mode.createExtensionUIContext();

		mode.pendingWorkingMessage = undefined;
		uiContext.setWorkingMessage("Resuming task…");
		expect(mode.pendingWorkingMessage).toBe("Resuming task…");

		// Clear still works
		uiContext.setWorkingMessage();
		expect(mode.pendingWorkingMessage).toBeUndefined();

		// Also works during streaming
		mode.session.isStreaming = true;
		uiContext.setWorkingMessage("queued while streaming");
		expect(mode.pendingWorkingMessage).toBe("queued while streaming");
	});

	it("downgrades icon-prefixed extension error notifications to info to avoid duplicate prefixes", () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		const uiContext = mode.createExtensionUIContext();

		uiContext.notify("⛔ Hook blocked tool_call", "error");
		uiContext.notify("plain failure", "error");

		expect(mode.notifyCalls[0]).toEqual({ message: "⛔ Hook blocked tool_call", type: "info" });
		expect(mode.notifyCalls[1]).toEqual({ message: "plain failure", type: "error" });
	});

	it("hasCompactionQueuedMessages returns false when only session steering exists", () => {
		// Session steering messages (in agent.steeringQueue) are consumed by the
		// agent loop, not by flushCompactionQueue. The method must not report them
		// as compaction-queued — that false positive orphaned steering messages
		// typed before compact (plan 160).
		class SteeringOnlyMode extends FakeInteractiveMode {
			override getAllQueuedMessages(): { followUp: string[]; steering: string[] } {
				return { followUp: [], steering: ["orphaned steering msg"] };
			}
		}

		patchInteractiveModePrototype(SteeringOnlyMode.prototype as never);
		const mode = new SteeringOnlyMode();
		// compactionQueuedMessages is empty — only session steering exists
		(mode as Record<string, unknown>).compactionQueuedMessages = [];
		const uiContext = mode.createExtensionUIContext();

		const hasQueued = (uiContext as Record<string, unknown>).hasCompactionQueuedMessages as
			| (() => boolean)
			| undefined;
		expect(typeof hasQueued).toBe("function");
		expect(hasQueued?.()).toBe(false);
	});

	it("hasCompactionQueuedMessages returns true when compactionQueuedMessages has entries", () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		// Simulate messages queued during compaction
		(mode as Record<string, unknown>).compactionQueuedMessages = [
			{ text: "user typed during compact", mode: "steer" },
		];
		const uiContext = mode.createExtensionUIContext();

		const hasQueued = (uiContext as Record<string, unknown>).hasCompactionQueuedMessages as
			| (() => boolean)
			| undefined;
		expect(hasQueued?.()).toBe(true);
	});

	it("hasCompactionQueuedMessages returns false when compactionQueuedMessages is undefined", () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		// compactionQueuedMessages not set at all (property doesn't exist)
		const uiContext = mode.createExtensionUIContext();

		const hasQueued = (uiContext as Record<string, unknown>).hasCompactionQueuedMessages as
			| (() => boolean)
			| undefined;
		expect(hasQueued?.()).toBe(false);
	});

	it("rebinds extension compact to InteractiveMode compaction on init and reload", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		let completed = 0;

		await mode.initExtensions();
		expect(typeof mode.session.extensionRunner.compactFn).toBe("function");

		mode.session.extensionRunner.compactFn?.({
			onComplete: () => {
				completed++;
			},
		});
		await Promise.resolve();

		expect(mode.executeCompactionCalls).toBe(1);
		expect(completed).toBe(1);

		await mode.handleReloadCommand();
		mode.session.extensionRunner.compactFn?.({
			onComplete: () => {
				completed++;
			},
		});
		await Promise.resolve();

		expect(mode.executeCompactionCalls).toBe(2);
		expect(completed).toBe(2);
	});

	it("defers extension compact until agent_end when the session is still streaming", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		let completed = 0;

		await mode.initExtensions();
		mode.session.isStreaming = true;
		mode.session.extensionRunner.compactFn?.({
			onComplete: () => {
				completed++;
			},
		});

		expect(mode.executeCompactionCalls).toBe(0);

		mode.session.isStreaming = false;
		await mode.handleEvent({ type: "agent_end" });

		expect(mode.executeCompactionCalls).toBe(1);
		expect(completed).toBe(1);
	});

	it("uses handleCompactCommand when executeCompaction is unavailable", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		let completed = 0;
		mode.executeCompaction = undefined;

		await mode.initExtensions();
		mode.session.extensionRunner.compactFn?.({
			onComplete: () => {
				completed++;
			},
		});
		await Promise.resolve();

		expect(mode.executeCompactionCalls).toBe(0);
		expect(mode.handleCompactCommandCalls).toBe(1);
		expect(completed).toBe(1);
	});

	it("treats undefined InteractiveMode compaction results as cleanup-worthy errors", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.executeCompactionResult = undefined;
		let errorMessage: string | undefined;

		await mode.initExtensions();
		mode.session.extensionRunner.compactFn?.({
			onError: (error: Error) => {
				errorMessage = error.message;
			},
		});
		await Promise.resolve();

		expect(mode.executeCompactionCalls).toBe(1);
		expect(errorMessage).toBe("Compaction did not complete");
	});

	// ── message_update coalescing (plan 176) ──────────────────────────────

	it("coalesces rapid message_update events into one handleEvent call per I/O cycle", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		// Fire 20 rapid message_update events (simulates streaming tokens)
		for (let i = 0; i < 20; i++) {
			mode.handleEvent({
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `token-${i}` }],
				},
			});
		}

		// None should have been processed synchronously
		expect(mode.handleEventCalls).toBe(0);

		// Wait for I/O flush (scheduleAfterIO uses setTimeout(0) on Bun)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// Only one call should have been made (the last coalesced event)
		expect(mode.handleEventCalls).toBe(1);
		expect(mode.lastHandledEvent?.message?.content?.[0]).toEqual({
			type: "text",
			text: "token-19",
		});
	});

	it("flushes pending message_update before message_end", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		// Buffer a message_update
		mode.handleEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
		});

		// Now fire message_end — should flush the pending update first
		await mode.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "final" }],
				stopReason: "stop",
			},
		});

		// handleEvent should have been called twice: once for flushed update, once for message_end
		expect(mode.handleEventCalls).toBe(2);
	});

	it("flushes pending message_update before tool_execution_start", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		// Buffer a message_update
		mode.handleEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
		});

		// Fire tool_execution_start — should flush first
		await mode.handleEvent({ type: "tool_execution_start" });

		// Two calls: flushed update + tool_execution_start
		expect(mode.handleEventCalls).toBe(2);
	});

	it("does not coalesce non-message_update events", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		await mode.handleEvent({ type: "message_start" });
		expect(mode.handleEventCalls).toBe(1);

		await mode.handleEvent({ type: "tool_execution_end" });
		expect(mode.handleEventCalls).toBe(2);
	});

	it("handles agent_end after coalesced message_updates", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		// Simulate streaming burst followed by agent_end
		for (let i = 0; i < 10; i++) {
			mode.handleEvent({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: `t-${i}` }] },
			});
		}

		// agent_end discards the pending update synchronously (no flush await)
		// so that the loader cleanup runs within the same _emit() call and
		// the user never sees a stale "Working..." spinner.
		await mode.handleEvent({ type: "agent_end" });

		// Only agent_end — no flushed message_update
		expect(mode.handleEventCalls).toBe(1);
		// agent_end cleanup should still run
		expect(mode.pendingWorkingMessage).toBeUndefined();
	});

	// ── orphaned steering/follow-up drain at agent_end ────────────────────

	it("drains orphaned steering messages to the editor at agent_end", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.steeringQueue.push("what is metal toolchain for?", "do I need it on my machine?");

		await mode.handleEvent({ type: "agent_end" });

		// Steering queue should be drained
		expect(mode.steeringQueue).toEqual([]);
		// Messages should be restored to the editor
		expect(mode.editorText).toBe("what is metal toolchain for?\n\ndo I need it on my machine?");
		// Pending messages display should be updated (zombies cleared)
		expect(mode.updateCalls).toBeGreaterThanOrEqual(1);
	});

	it("drains orphaned follow-up messages to the editor at agent_end", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.followUpQueue.push("also check the ansible playbook");

		await mode.handleEvent({ type: "agent_end" });

		expect(mode.followUpQueue).toEqual([]);
		expect(mode.editorText).toBe("also check the ansible playbook");
	});

	it("combines orphaned messages with existing editor text", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.steeringQueue.push("stale steering");
		mode.editorText = "new message in progress";

		await mode.handleEvent({ type: "agent_end" });

		expect(mode.editorText).toBe("stale steering\n\nnew message in progress");
	});

	it("does not touch the editor when no orphaned messages exist", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.editorText = "user is typing";

		await mode.handleEvent({ type: "agent_end" });

		expect(mode.editorText).toBe("user is typing");
	});

	it("drains both steering and follow-up in correct order", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		mode.steeringQueue.push("steer1", "steer2");
		mode.followUpQueue.push("follow1");

		await mode.handleEvent({ type: "agent_end" });

		expect(mode.steeringQueue).toEqual([]);
		expect(mode.followUpQueue).toEqual([]);
		expect(mode.editorText).toBe("steer1\n\nsteer2\n\nfollow1");
	});

	// ── spinner clearing on agent_end ─────────────────────────────────────

	it("does NOT clear statusContainer on agent_end when auto-compaction is active", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		// Start auto-compaction flow
		await mode.handleEvent({ type: "auto_compaction_start" });
		// agent_end arrives while compaction is still running
		await mode.handleEvent({ type: "agent_end" });

		// Compaction loader must not be stripped
		expect(mode.statusClears).toBe(0);
	});

	it("clears statusContainer on agent_end after auto-compaction fully completes", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		// Full compaction cycle completes (willRetry=false)
		await mode.handleEvent({ type: "auto_compaction_start" });
		await mode.handleEvent({
			type: "auto_compaction_end",
			willRetry: false,
			result: { summary: "ok" },
		});
		// Next agent_end is a normal turn — spinner should clear
		await mode.handleEvent({ type: "agent_end" });

		expect(mode.statusClears).toBe(1);
	});

	it("does NOT clear statusContainer on agent_end when compaction retry is still in flight", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		await mode.handleEvent({ type: "auto_compaction_start" });
		// willRetry=true means the loader must survive until continuation actually starts
		await mode.handleEvent({ type: "auto_compaction_end", willRetry: true });
		await mode.handleEvent({ type: "agent_end" });

		expect(mode.statusClears).toBe(0);
	});

	it("clears statusContainer on agent_end after retry continuation starts", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		await mode.handleEvent({ type: "auto_compaction_start" });
		await mode.handleEvent({ type: "auto_compaction_end", willRetry: true });
		await mode.handleEvent({ type: "message_start" });
		await mode.handleEvent({ type: "agent_end" });

		expect(mode.statusClears).toBe(1);
	});

	it("does not latch compaction status from ordinary continuation signals", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();

		await mode.handleEvent({ type: "agent_start" });
		await mode.handleEvent({ type: "agent_end" });

		expect(mode.statusClears).toBe(1);
	});
});
