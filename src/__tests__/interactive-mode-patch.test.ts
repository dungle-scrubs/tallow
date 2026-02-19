import { describe, expect, it } from "bun:test";
import { patchInteractiveModePrototype } from "../interactive-mode-patch.js";

interface FakeEvent {
	type?: string;
}

class FakeInteractiveMode {
	defaultEditor: { onEscape?: () => void } = {};
	escapeCalls = 0;
	handleEventCalls = 0;
	lastRestoredAbort: boolean | undefined;
	loadingAnimation: unknown;
	pendingWorkingMessage: unknown = "stale";
	renderRequests = 0;
	session = { isStreaming: false };
	statusClears = 0;
	updateCalls = 0;
	ui = { requestRender: () => this.renderRequests++ };

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
	 * Count display refresh calls.
	 *
	 * @returns Nothing
	 */
	updatePendingMessagesDisplay(): void {
		this.updateCalls++;
	}

	statusContainer = {
		clear: (): void => {
			this.statusClears++;
		},
	};

	/**
	 * Build extension UI context with a setWorkingMessage implementation similar
	 * to InteractiveMode.
	 *
	 * @returns Extension UI context object
	 */
	createExtensionUIContext(): { setWorkingMessage: (message?: string) => void } {
		return {
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
	it("applies agent_end cleanup without double-wrapping", async () => {
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);
		patchInteractiveModePrototype(FakeInteractiveMode.prototype as never);

		const mode = new FakeInteractiveMode();
		const result = await mode.handleEvent({ type: "agent_end" });

		expect(result).toBe("ok");
		expect(mode.handleEventCalls).toBe(1);
		expect(mode.pendingWorkingMessage).toBeUndefined();
		expect(mode.statusClears).toBe(1);
		expect(mode.updateCalls).toBe(1);
		expect(mode.renderRequests).toBe(1);
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
});
