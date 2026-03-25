import { type KeyId, matchesKey } from "./keys.js";

/** Modern TUI keybinding identifiers. */
export interface Keybindings {
	"tui.editor.cursorDown": true;
	"tui.editor.cursorLeft": true;
	"tui.editor.cursorLineEnd": true;
	"tui.editor.cursorLineStart": true;
	"tui.editor.cursorRight": true;
	"tui.editor.cursorUp": true;
	"tui.editor.cursorWordLeft": true;
	"tui.editor.cursorWordRight": true;
	"tui.editor.deleteCharBackward": true;
	"tui.editor.deleteCharForward": true;
	"tui.editor.deleteToLineEnd": true;
	"tui.editor.deleteToLineStart": true;
	"tui.editor.deleteWordBackward": true;
	"tui.editor.deleteWordForward": true;
	"tui.editor.jumpBackward": true;
	"tui.editor.jumpForward": true;
	"tui.editor.pageDown": true;
	"tui.editor.pageUp": true;
	"tui.editor.undo": true;
	"tui.editor.yank": true;
	"tui.editor.yankPop": true;
	"tui.input.copy": true;
	"tui.input.newLine": true;
	"tui.input.submit": true;
	"tui.input.tab": true;
	"tui.select.cancel": true;
	"tui.select.confirm": true;
	"tui.select.down": true;
	"tui.select.pageDown": true;
	"tui.select.pageUp": true;
	"tui.select.up": true;
}

const LEGACY_TO_MODERN_KEYBINDINGS = {
	copy: "tui.input.copy",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorRight: "tui.editor.cursorRight",
	cursorUp: "tui.editor.cursorUp",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteSession: "app.session.delete",
	deleteSessionNoninvasive: "app.session.deleteNoninvasive",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	expandTools: "app.tools.expand",
	jumpBackward: "tui.editor.jumpBackward",
	jumpForward: "tui.editor.jumpForward",
	newLine: "tui.input.newLine",
	pageDown: "tui.editor.pageDown",
	pageUp: "tui.editor.pageUp",
	renameSession: "app.session.rename",
	selectCancel: "tui.select.cancel",
	selectConfirm: "tui.select.confirm",
	selectDown: "tui.select.down",
	selectPageDown: "tui.select.pageDown",
	selectPageUp: "tui.select.pageUp",
	selectUp: "tui.select.up",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	toggleSessionPath: "app.session.togglePath",
	toggleSessionSort: "app.session.toggleSort",
	undo: "tui.editor.undo",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
} as const;

/** Backward-compatible legacy editor actions. */
export type EditorAction = keyof typeof LEGACY_TO_MODERN_KEYBINDINGS;

/** Modern keybinding identifier. */
export type Keybinding = keyof Keybindings | EditorAction;

/** Single keybinding definition with defaults and UI help text. */
export interface KeybindingDefinition {
	readonly defaultKeys: KeyId | readonly KeyId[];
	readonly description: string;
}

/** User-provided keybinding overrides. */
export type KeybindingsConfig = Partial<Record<Keybinding, KeyId | readonly KeyId[]>>;

/** Backward-compatible legacy editor config. */
export type EditorKeybindingsConfig = Partial<Record<EditorAction, KeyId | readonly KeyId[]>>;

/** Default legacy editor keybindings preserved for compatibility. */
export const DEFAULT_EDITOR_KEYBINDINGS: Required<Record<EditorAction, KeyId | readonly KeyId[]>> =
	{
		copy: "ctrl+shift+c",
		cursorDown: "down",
		cursorLeft: ["left", "ctrl+b"],
		cursorLineEnd: ["end", "ctrl+e"],
		cursorLineStart: ["home", "ctrl+a"],
		cursorRight: ["right", "ctrl+f"],
		cursorUp: "up",
		cursorWordLeft: ["alt+left", "ctrl+left", "alt+b"],
		cursorWordRight: ["alt+right", "ctrl+right", "alt+f"],
		deleteCharBackward: "backspace",
		deleteCharForward: ["delete", "ctrl+d"],
		deleteSession: "ctrl+d",
		deleteSessionNoninvasive: "ctrl+backspace",
		deleteToLineEnd: "ctrl+k",
		deleteToLineStart: "ctrl+u",
		deleteWordBackward: ["ctrl+w", "alt+backspace"],
		deleteWordForward: ["alt+d", "alt+delete"],
		expandTools: "ctrl+o",
		jumpBackward: "ctrl+alt+]",
		jumpForward: "ctrl+]",
		newLine: "shift+enter",
		pageDown: "pageDown",
		pageUp: "pageUp",
		renameSession: "ctrl+r",
		selectCancel: ["escape", "ctrl+c"],
		selectConfirm: "enter",
		selectDown: "down",
		selectPageDown: "pageDown",
		selectPageUp: "pageUp",
		selectUp: "up",
		submit: "enter",
		tab: "tab",
		toggleSessionPath: "ctrl+p",
		toggleSessionSort: "ctrl+s",
		undo: "ctrl+-",
		yank: "ctrl+y",
		yankPop: "alt+y",
	};

/** Modern TUI keybinding definitions consumed by pi-coding-agent 0.61+. */
export const TUI_KEYBINDINGS = {
	"tui.editor.cursorDown": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.cursorDown,
		description: "Move cursor down",
	},
	"tui.editor.cursorLeft": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.cursorLeft,
		description: "Move cursor left",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.cursorLineEnd,
		description: "Move to line end",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.cursorLineStart,
		description: "Move to line start",
	},
	"tui.editor.cursorRight": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.cursorRight,
		description: "Move cursor right",
	},
	"tui.editor.cursorUp": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.cursorUp,
		description: "Move cursor up",
	},
	"tui.editor.cursorWordLeft": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.cursorWordLeft,
		description: "Move cursor word left",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.cursorWordRight,
		description: "Move cursor word right",
	},
	"tui.editor.deleteCharBackward": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.deleteCharBackward,
		description: "Delete character backward",
	},
	"tui.editor.deleteCharForward": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.deleteCharForward,
		description: "Delete character forward",
	},
	"tui.editor.deleteToLineEnd": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.deleteToLineEnd,
		description: "Delete to line end",
	},
	"tui.editor.deleteToLineStart": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.deleteToLineStart,
		description: "Delete to line start",
	},
	"tui.editor.deleteWordBackward": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.deleteWordBackward,
		description: "Delete word backward",
	},
	"tui.editor.deleteWordForward": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.deleteWordForward,
		description: "Delete word forward",
	},
	"tui.editor.jumpBackward": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.jumpBackward,
		description: "Jump backward to character",
	},
	"tui.editor.jumpForward": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.jumpForward,
		description: "Jump forward to character",
	},
	"tui.editor.pageDown": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.pageDown,
		description: "Page down",
	},
	"tui.editor.pageUp": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.pageUp,
		description: "Page up",
	},
	"tui.editor.undo": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.undo,
		description: "Undo",
	},
	"tui.editor.yank": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.yank,
		description: "Yank",
	},
	"tui.editor.yankPop": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.yankPop,
		description: "Yank pop",
	},
	"tui.input.copy": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.copy,
		description: "Copy selection",
	},
	"tui.input.newLine": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.newLine,
		description: "Insert newline",
	},
	"tui.input.submit": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.submit,
		description: "Submit input",
	},
	"tui.input.tab": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.tab,
		description: "Tab / autocomplete",
	},
	"tui.select.cancel": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.selectCancel,
		description: "Cancel selection",
	},
	"tui.select.confirm": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.selectConfirm,
		description: "Confirm selection",
	},
	"tui.select.down": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.selectDown,
		description: "Move selection down",
	},
	"tui.select.pageDown": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.selectPageDown,
		description: "Selection page down",
	},
	"tui.select.pageUp": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.selectPageUp,
		description: "Selection page up",
	},
	"tui.select.up": {
		defaultKeys: DEFAULT_EDITOR_KEYBINDINGS.selectUp,
		description: "Move selection up",
	},
} as const satisfies Record<keyof Keybindings, KeybindingDefinition>;

type ModernKeybinding = keyof Keybindings;

type NormalizedKeybindingsConfig = Partial<Record<ModernKeybinding, readonly KeyId[]>>;

/**
 * Check whether a keybinding name is a supported modern identifier.
 *
 * @param {string} keybinding - Candidate keybinding name.
 * @returns {keybinding is ModernKeybinding} True when the keybinding exists.
 */
function isModernKeybinding(keybinding: string): keybinding is ModernKeybinding {
	return keybinding in TUI_KEYBINDINGS;
}

/**
 * Normalize a legacy or modern keybinding identifier to the modern name.
 * Only checks TUI_KEYBINDINGS and legacy mappings. For consumer-defined
 * keybindings (e.g. app.*), use {@link KeybindingsManager.resolveKeybinding}.
 *
 * @param {Keybinding} keybinding - Keybinding identifier to normalize.
 * @returns {ModernKeybinding | null} Modern keybinding or null when unsupported.
 */
function normalizeKeybinding(keybinding: Keybinding): ModernKeybinding | null {
	if (isModernKeybinding(keybinding)) {
		return keybinding;
	}

	const normalized = LEGACY_TO_MODERN_KEYBINDINGS[keybinding as EditorAction];
	return normalized && isModernKeybinding(normalized) ? normalized : null;
}

/**
 * Convert a raw keybinding value into an array form.
 *
 * @param {KeyId | readonly KeyId[]} value - Raw keybinding value.
 * @returns {readonly KeyId[]} Normalized key array.
 */
function normalizeKeyArray(value: KeyId | readonly KeyId[]): readonly KeyId[] {
	return Array.isArray(value) ? [...value] : [value as KeyId];
}

/**
 * Normalize user bindings to modern identifiers and array values.
 *
 * @param {KeybindingsConfig} userBindings - Raw user bindings.
 * @returns {NormalizedKeybindingsConfig} Normalized modern binding map.
 */
function normalizeUserBindings(userBindings: KeybindingsConfig): NormalizedKeybindingsConfig {
	const normalized: NormalizedKeybindingsConfig = {};

	for (const [rawKey, rawValue] of Object.entries(userBindings)) {
		if (rawValue === undefined) continue;

		const key = rawKey as Keybinding;
		const modernKey = normalizeKeybinding(key);
		if (!modernKey) continue;
		if (key !== modernKey && userBindings[modernKey] !== undefined) continue;

		normalized[modernKey] = [...normalizeKeyArray(rawValue)];
	}

	return normalized;
}

/**
 * Keybinding manager compatible with pi-tui 0.61+ while preserving legacy names.
 */
export class KeybindingsManager {
	private readonly definitions: Readonly<Record<ModernKeybinding, KeybindingDefinition>>;
	private readonly resolvedKeys = new Map<ModernKeybinding, KeyId[]>();
	private userBindings: NormalizedKeybindingsConfig;

	/**
	 * Create a keybindings manager.
	 *
	 * @param {Readonly<Record<ModernKeybinding, KeybindingDefinition>>} definitions - Keybinding definitions.
	 * @param {KeybindingsConfig} userBindings - Optional user overrides.
	 */
	constructor(
		definitions: Readonly<Record<ModernKeybinding, KeybindingDefinition>> = TUI_KEYBINDINGS,
		userBindings: KeybindingsConfig = {}
	) {
		this.definitions = definitions;
		this.userBindings = this.normalizeUserBindingsWithDefinitions(userBindings);
		this.rebuild();
	}

	/**
	 * Rebuild resolved bindings from defaults plus user overrides.
	 *
	 * @returns {void} Nothing.
	 */
	private rebuild(): void {
		this.resolvedKeys.clear();

		for (const [keybinding, definition] of Object.entries(this.definitions)) {
			const modernKey = keybinding as ModernKeybinding;
			const override = this.userBindings[modernKey];
			const keys = override ?? normalizeKeyArray(definition.defaultKeys);
			this.resolvedKeys.set(modernKey, [...keys]);
		}
	}

	/**
	 * Resolve a keybinding name to its lookup key in resolvedKeys.
	 * Checks the TUI namespace and legacy names first, then falls back to
	 * a direct lookup in definitions/resolvedKeys for consumer-defined
	 * keybindings (e.g. app.* keybindings registered by pi-coding-agent).
	 *
	 * @param {string} keybinding - Keybinding identifier.
	 * @returns {ModernKeybinding | null} Resolved key or null when unknown.
	 */
	private resolveKeybinding(keybinding: string): ModernKeybinding | null {
		const normalized = normalizeKeybinding(keybinding as Keybinding);
		if (normalized) return normalized;

		// Fall back to direct lookup for keybindings registered via definitions
		// but outside the tui.* namespace (e.g. app.interrupt, app.clear).
		// Check definitions first (available at construction) then resolvedKeys.
		const asKey = keybinding as ModernKeybinding;
		return asKey in this.definitions || this.resolvedKeys.has(asKey) ? asKey : null;
	}

	/**
	 * Check whether input matches a keybinding.
	 *
	 * @param {string} data - Raw terminal input.
	 * @param {Keybinding | string} keybinding - Keybinding identifier.
	 * @returns {boolean} True when the input matches.
	 */
	matches(data: string, keybinding: Keybinding | string): boolean {
		const resolved = this.resolveKeybinding(keybinding as string);
		if (!resolved) return false;

		for (const key of this.resolvedKeys.get(resolved) ?? []) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * Get the keys currently bound to a keybinding.
	 *
	 * @param {Keybinding | string} keybinding - Keybinding identifier.
	 * @returns {KeyId[]} Resolved key list.
	 */
	getKeys(keybinding: Keybinding | string): KeyId[] {
		const resolved = this.resolveKeybinding(keybinding as string);
		return resolved ? [...(this.resolvedKeys.get(resolved) ?? [])] : [];
	}

	/**
	 * Replace user bindings and rebuild the resolved map.
	 *
	 * @param {KeybindingsConfig} userBindings - New user bindings.
	 * @returns {void} Nothing.
	 */
	setUserBindings(userBindings: KeybindingsConfig): void {
		this.userBindings = this.normalizeUserBindingsWithDefinitions(userBindings);
		this.rebuild();
	}

	/**
	 * Normalize user bindings using both TUI namespace and consumer definitions.
	 * This extends the module-level normalizeUserBindings to also accept
	 * keybinding names that exist in this.definitions (e.g. app.*).
	 *
	 * @param {KeybindingsConfig} userBindings - Raw user bindings.
	 * @returns {NormalizedKeybindingsConfig} Normalized modern binding map.
	 */
	private normalizeUserBindingsWithDefinitions(
		userBindings: KeybindingsConfig
	): NormalizedKeybindingsConfig {
		const normalized: NormalizedKeybindingsConfig = {};

		for (const [rawKey, rawValue] of Object.entries(userBindings)) {
			if (rawValue === undefined) continue;

			const resolved = this.resolveKeybinding(rawKey);
			if (!resolved) continue;
			if (rawKey !== resolved && userBindings[resolved] !== undefined) continue;

			normalized[resolved] = [...normalizeKeyArray(rawValue)];
		}

		return normalized;
	}

	/**
	 * Get the fully resolved modern keybinding config.
	 *
	 * @returns {NormalizedKeybindingsConfig} Resolved keybinding config.
	 */
	getResolvedBindings(): NormalizedKeybindingsConfig {
		const resolved: NormalizedKeybindingsConfig = {};
		for (const [keybinding, keys] of this.resolvedKeys.entries()) {
			resolved[keybinding] = [...keys];
		}
		return resolved;
	}
}

/** Backward-compatible alias for legacy callers. */
export class EditorKeybindingsManager extends KeybindingsManager {
	/**
	 * Create a legacy editor keybindings manager.
	 *
	 * @param {EditorKeybindingsConfig} config - Legacy editor keybinding overrides.
	 */
	constructor(config: EditorKeybindingsConfig = {}) {
		super(TUI_KEYBINDINGS, config);
	}
}

let globalKeybindings: KeybindingsManager | null = null;

/**
 * Get the shared keybindings manager.
 *
 * @returns {KeybindingsManager} Shared keybindings manager.
 */
export function getKeybindings(): KeybindingsManager {
	if (!globalKeybindings) {
		globalKeybindings = new EditorKeybindingsManager();
	}
	return globalKeybindings;
}

/**
 * Replace the shared keybindings manager.
 *
 * @param {KeybindingsManager} manager - Keybindings manager to install.
 * @returns {void} Nothing.
 */
export function setKeybindings(manager: KeybindingsManager): void {
	globalKeybindings = manager;
}

/**
 * Get the shared legacy editor keybindings manager.
 *
 * @returns {EditorKeybindingsManager} Shared legacy-compatible manager.
 */
export function getEditorKeybindings(): EditorKeybindingsManager {
	return getKeybindings() as EditorKeybindingsManager;
}

/**
 * Replace the shared legacy editor keybindings manager.
 *
 * @param {EditorKeybindingsManager} manager - Legacy keybindings manager.
 * @returns {void} Nothing.
 */
export function setEditorKeybindings(manager: EditorKeybindingsManager): void {
	setKeybindings(manager);
}
