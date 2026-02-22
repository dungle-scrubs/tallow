import { describe, expect, it } from "bun:test";
import { patchInteractiveModePrototype } from "../interactive-mode-patch.js";

interface FakeEvent {
	type?: string;
}

class FakeInteractiveMode {
	defaultEditor: { onEscape?: () => void } = {};
	escapeCalls = 0;
	flushCalls = 0;
	handleBashCommandCalls = 0;
	handleEventCalls = 0;
	lastRestoredAbort: boolean | undefined;
	lifecycleCalls: string[] = [];
	loadingAnimation: unknown;
	notifyCalls: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	pendingBashComponents: unknown[] = [];
	pendingWorkingMessage: unknown = "stale";
	renderRequests = 0;
	session = { isStreaming: false };
	statusClears = 0;
	updateCalls = 0;
	ui = {
		requestRender: (): void => {
			this.lifecycleCalls.push("ui.requestRender");
			this.renderRequests++;
		},
	};

	/**
	 * Base handleEvent implementation used by the patch wrapper.
	 *
	 * @param _event - Event payload
	 * @returns Promise resolved with marker text
	 */
	async handleEvent(_event: FakeEvent): Promise<string> {
		this.handleEventCalls++;
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
		expect(mode.statusClears).toBe(1);
		expect(mode.updateCalls).toBe(1);
		expect(mode.renderRequests).toBe(1);

		const flushCallIndex = mode.lifecycleCalls.indexOf("flushPendingBashComponents");
		const updateCallIndex = mode.lifecycleCalls.indexOf("updatePendingMessagesDisplay");
		expect(flushCallIndex).toBeGreaterThanOrEqual(0);
		expect(updateCallIndex).toBeGreaterThanOrEqual(0);
		expect(flushCallIndex).toBeLessThan(updateCallIndex);
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

	it("drops idle non-empty setWorkingMessage to avoid stale carryover", () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		const mode = new FakeInteractiveMode();
		const uiContext = mode.createExtensionUIContext();

		mode.pendingWorkingMessage = undefined;
		uiContext.setWorkingMessage("late async message");
		expect(mode.pendingWorkingMessage).toBeUndefined();

		uiContext.setWorkingMessage();
		expect(mode.pendingWorkingMessage).toBeUndefined();

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
});
