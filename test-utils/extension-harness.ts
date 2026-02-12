/**
 * Extension test harness — mock ExtensionAPI for isolated extension testing.
 *
 * Tracks all registrations (tools, commands, shortcuts, flags, renderers, providers)
 * and provides event simulation for testing extension behavior without a session.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionUIContext,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	SlashCommandInfo,
	ToolDefinition,
	ToolInfo,
} from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

/** Recorded message sent via `pi.sendMessage()`. */
export interface SentMessage {
	customType: string;
	content: string;
	display?: string;
	details?: unknown;
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

/** Recorded user message sent via `pi.sendUserMessage()`. */
export interface SentUserMessage {
	content: string | (TextContent | ImageContent)[];
	options?: { deliverAs?: "steer" | "followUp" };
}

/** Recorded entry appended via `pi.appendEntry()`. */
export interface AppendedEntry {
	customType: string;
	data?: unknown;
}

/** Registered shortcut record. */
export interface RegisteredShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
}

/** Registered flag record. */
export interface RegisteredFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
}

/** Registered provider record. */
export interface RegisteredProvider {
	name: string;
	config: ProviderConfig;
}

// ── Simple EventBus mock ─────────────────────────────────────────────────────

interface MockEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * Create a minimal in-memory EventBus for testing.
 *
 * @returns Mock event bus with on/emit
 */
function createMockEventBus(): MockEventBus {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel, data) {
			for (const fn of listeners.get(channel) ?? []) fn(data);
		},
		on(channel, handler) {
			if (!listeners.has(channel)) listeners.set(channel, new Set());
			listeners.get(channel)?.add(handler);
			return () => {
				listeners.get(channel)?.delete(handler);
			};
		},
	};
}

// ── No-op UI context ─────────────────────────────────────────────────────────

/**
 * Create a no-op ExtensionUIContext for testing.
 * All methods are safe to call but do nothing meaningful.
 *
 * @returns Stub UI context
 */
function createStubUIContext(): ExtensionUIContext {
	return {
		async select() {
			return undefined;
		},
		async confirm() {
			return false;
		},
		async input() {
			return undefined;
		},
		notify() {},
		setStatus() {},
		setWorkingMessage() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		async custom() {
			return undefined as never;
		},
		pasteToEditor() {},
		setEditorText() {},
		getEditorText() {
			return "";
		},
		async editor() {
			return undefined;
		},
		setEditorComponent() {},
		get theme(): never {
			throw new Error("Theme not available in test harness");
		},
		getAllThemes() {
			return [];
		},
		getTheme() {
			return undefined;
		},
		setTheme() {
			return { success: false, error: "Test harness" };
		},
		getToolsExpanded() {
			return false;
		},
		setToolsExpanded() {},
	} as unknown as ExtensionUIContext;
}

// ── Extension Harness ────────────────────────────────────────────────────────

/**
 * Mock ExtensionAPI that tracks all registrations and event handlers.
 *
 * Use `create()` to build an instance, `loadExtension()` to run a factory
 * against it, and `fireEvent()` to simulate lifecycle events.
 *
 * @example
 * ```typescript
 * const harness = ExtensionHarness.create();
 * await harness.loadExtension(myExtension);
 * expect(harness.tools).toContainKey("my_tool");
 * await harness.fireEvent("session_start", { type: "session_start" });
 * ```
 */
export class ExtensionHarness {
	/** Registered tools by name. */
	readonly tools = new Map<string, ToolDefinition>();
	/** Registered commands by name. */
	readonly commands = new Map<string, Omit<RegisteredCommand, "name">>();
	/** Registered shortcuts. */
	readonly shortcuts: RegisteredShortcut[] = [];
	/** Registered flags by name. */
	readonly flags = new Map<string, RegisteredFlag>();
	/** Registered message renderers by custom type. */
	readonly messageRenderers = new Map<string, MessageRenderer>();
	/** Registered providers. */
	readonly providers: RegisteredProvider[] = [];
	/** Sent custom messages. */
	readonly sentMessages: SentMessage[] = [];
	/** Sent user messages. */
	readonly sentUserMessages: SentUserMessage[] = [];
	/** Appended entries. */
	readonly appendedEntries: AppendedEntry[] = [];
	/** Event handlers by event name. */
	readonly handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	/** Flag values (populated by registerFlag defaults, overridable). */
	readonly flagValues = new Map<string, boolean | string>();
	/** The mock ExtensionAPI instance. */
	readonly api: ExtensionAPI;
	/** Mock event bus for inter-extension communication. */
	readonly eventBus: MockEventBus;

	private _sessionName: string | undefined;
	private _activeTools: string[] = [];
	private _thinkingLevel: ThinkingLevel = "medium";

	private constructor() {
		this.eventBus = createMockEventBus();
		this.api = this._buildApi();
	}

	/**
	 * Create a new extension test harness.
	 *
	 * @returns Fresh harness instance
	 */
	static create(): ExtensionHarness {
		return new ExtensionHarness();
	}

	/**
	 * Load an extension factory against this harness.
	 *
	 * @param factory - Extension factory function
	 */
	async loadExtension(factory: ExtensionFactory): Promise<void> {
		await factory(this.api);
	}

	/**
	 * Fire an event and collect handler results.
	 *
	 * @param event - Event name (e.g., "session_start", "context", "turn_start")
	 * @param payload - Event payload object
	 * @param ctx - Optional extension context override
	 * @returns Array of handler return values (undefined entries for void handlers)
	 */
	async fireEvent(event: string, payload: unknown, ctx?: ExtensionContext): Promise<unknown[]> {
		const fns = this.handlers.get(event) ?? [];
		const context = ctx ?? this._buildContext();
		const results: unknown[] = [];
		for (const fn of fns) {
			results.push(await fn(payload, context));
		}
		return results;
	}

	/**
	 * Set a flag value (for testing getFlag behavior).
	 *
	 * @param name - Flag name
	 * @param value - Flag value
	 */
	setFlag(name: string, value: boolean | string): void {
		this.flagValues.set(name, value);
	}

	/**
	 * Reset all tracked state.
	 */
	reset(): void {
		this.tools.clear();
		this.commands.clear();
		this.shortcuts.length = 0;
		this.flags.clear();
		this.messageRenderers.clear();
		this.providers.length = 0;
		this.sentMessages.length = 0;
		this.sentUserMessages.length = 0;
		this.appendedEntries.length = 0;
		this.handlers.clear();
		this.flagValues.clear();
		this._sessionName = undefined;
		this._activeTools = [];
	}

	// ── Private ──────────────────────────────────────────────────────────────

	/** Build a mock ExtensionContext for handler invocation. */
	private _buildContext(): ExtensionContext {
		return {
			ui: createStubUIContext(),
			hasUI: false,
			cwd: process.cwd(),
			sessionManager: {} as never,
			modelRegistry: {} as never,
			model: undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		};
	}

	/** Build the mock ExtensionAPI. */
	private _buildApi(): ExtensionAPI {
		const self = this;
		return {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!self.handlers.has(event)) self.handlers.set(event, []);
				self.handlers.get(event)?.push(handler);
			},
			registerTool(tool: ToolDefinition) {
				self.tools.set(tool.name, tool);
			},
			registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
				self.commands.set(name, options);
			},
			registerShortcut(
				shortcut: KeyId,
				options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }
			) {
				self.shortcuts.push({ shortcut, ...options });
			},
			registerFlag(
				name: string,
				options: { description?: string; type: "boolean" | "string"; default?: boolean | string }
			) {
				self.flags.set(name, { name, ...options });
				if (options.default !== undefined) self.flagValues.set(name, options.default);
			},
			getFlag(name: string) {
				return self.flagValues.get(name);
			},
			registerMessageRenderer(customType: string, renderer: MessageRenderer) {
				self.messageRenderers.set(customType, renderer);
			},
			sendMessage(message: SentMessage, options?: SentMessage["options"]) {
				self.sentMessages.push({ ...message, options });
			},
			sendUserMessage(
				content: string | (TextContent | ImageContent)[],
				options?: SentUserMessage["options"]
			) {
				self.sentUserMessages.push({ content, options });
			},
			appendEntry(customType: string, data?: unknown) {
				self.appendedEntries.push({ customType, data });
			},
			setSessionName(name: string) {
				self._sessionName = name;
			},
			getSessionName() {
				return self._sessionName;
			},
			setLabel() {},
			async exec() {
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			getActiveTools() {
				return [...self._activeTools];
			},
			getAllTools(): ToolInfo[] {
				return [...self.tools.values()].map((t) => ({
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				}));
			},
			setActiveTools(names: string[]) {
				self._activeTools = [...names];
			},
			getCommands(): SlashCommandInfo[] {
				return [];
			},
			async setModel() {
				return true;
			},
			getThinkingLevel() {
				return self._thinkingLevel;
			},
			setThinkingLevel(level: ThinkingLevel) {
				self._thinkingLevel = level;
			},
			registerProvider(name: string, config: ProviderConfig) {
				self.providers.push({ name, config });
			},
			events: self.eventBus as never,
		} as unknown as ExtensionAPI;
	}
}
