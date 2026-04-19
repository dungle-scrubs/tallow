import { type KeyId, matchesKey } from "./keys.js";

/**
 * Global keybinding registry.
 * Downstream packages can add keybindings via declaration merging.
 */
export interface Keybindings {
	// Editor navigation and editing
	"tui.editor.cursorUp": true;
	"tui.editor.cursorDown": true;
	"tui.editor.cursorLeft": true;
	"tui.editor.cursorRight": true;
	"tui.editor.cursorWordLeft": true;
	"tui.editor.cursorWordRight": true;
	"tui.editor.cursorLineStart": true;
	"tui.editor.cursorLineEnd": true;
	"tui.editor.jumpForward": true;
	"tui.editor.jumpBackward": true;
	"tui.editor.pageUp": true;
	"tui.editor.pageDown": true;
	"tui.editor.deleteCharBackward": true;
	"tui.editor.deleteCharForward": true;
	"tui.editor.deleteWordBackward": true;
	"tui.editor.deleteWordForward": true;
	"tui.editor.deleteToLineStart": true;
	"tui.editor.deleteToLineEnd": true;
	"tui.editor.yank": true;
	"tui.editor.yankPop": true;
	"tui.editor.undo": true;
	// Generic input actions
	"tui.input.newLine": true;
	"tui.input.submit": true;
	"tui.input.tab": true;
	"tui.input.copy": true;
	// Generic selection actions
	"tui.select.up": true;
	"tui.select.down": true;
	"tui.select.pageUp": true;
	"tui.select.pageDown": true;
	"tui.select.confirm": true;
	"tui.select.cancel": true;
}

export type Keybinding = keyof Keybindings;

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
	"tui.editor.cursorLeft": {
		defaultKeys: ["left", "ctrl+b"],
		description: "Move cursor left",
	},
	"tui.editor.cursorRight": {
		defaultKeys: ["right", "ctrl+f"],
		description: "Move cursor right",
	},
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move cursor word left",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move cursor word right",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+a"],
		description: "Move to line start",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+e"],
		description: "Move to line end",
	},
	"tui.editor.jumpForward": {
		defaultKeys: "ctrl+]",
		description: "Jump forward to character",
	},
	"tui.editor.jumpBackward": {
		defaultKeys: "ctrl+alt+]",
		description: "Jump backward to character",
	},
	"tui.editor.pageUp": { defaultKeys: "pageUp", description: "Page up" },
	"tui.editor.pageDown": { defaultKeys: "pageDown", description: "Page down" },
	"tui.editor.deleteCharBackward": {
		defaultKeys: "backspace",
		description: "Delete character backward",
	},
	"tui.editor.deleteCharForward": {
		defaultKeys: ["delete", "ctrl+d"],
		description: "Delete character forward",
	},
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["ctrl+w", "alt+backspace"],
		description: "Delete word backward",
	},
	"tui.editor.deleteWordForward": {
		defaultKeys: ["alt+d", "alt+delete"],
		description: "Delete word forward",
	},
	"tui.editor.deleteToLineStart": {
		defaultKeys: "ctrl+u",
		description: "Delete to line start",
	},
	"tui.editor.deleteToLineEnd": {
		defaultKeys: "ctrl+k",
		description: "Delete to line end",
	},
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
	"tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
	"tui.input.newLine": { defaultKeys: "shift+enter", description: "Insert newline" },
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
	"tui.select.up": { defaultKeys: "up", description: "Move selection up" },
	"tui.select.down": { defaultKeys: "down", description: "Move selection down" },
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
	"tui.select.pageDown": {
		defaultKeys: "pageDown",
		description: "Selection page down",
	},
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	"tui.select.cancel": {
		defaultKeys: ["escape", "ctrl+c"],
		description: "Cancel selection",
	},
} as const satisfies KeybindingDefinitions;

export interface KeybindingConflict {
	key: KeyId;
	keybindings: string[];
}

function normalizeKeys(keys: KeyId | KeyId[] | undefined): KeyId[] {
	if (keys === undefined) return [];
	const keyList = Array.isArray(keys) ? keys : [keys];
	const seen = new Set<KeyId>();
	const result: KeyId[] = [];
	for (const key of keyList) {
		if (!seen.has(key)) {
			seen.add(key);
			result.push(key);
		}
	}
	return result;
}

export class KeybindingsManager {
	private definitions: KeybindingDefinitions;
	private userBindings: KeybindingsConfig;
	private keysById = new Map<Keybinding, KeyId[]>();
	private conflicts: KeybindingConflict[] = [];

	constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
		this.definitions = definitions;
		this.userBindings = userBindings;
		this.rebuild();
	}

	private rebuild(): void {
		this.keysById.clear();
		this.conflicts = [];

		const userClaims = new Map<KeyId, Set<Keybinding>>();
		for (const [keybinding, keys] of Object.entries(this.userBindings)) {
			if (!(keybinding in this.definitions)) continue;
			for (const key of normalizeKeys(keys)) {
				const claimants = userClaims.get(key) ?? new Set<Keybinding>();
				claimants.add(keybinding as Keybinding);
				userClaims.set(key, claimants);
			}
		}

		for (const [key, keybindings] of userClaims) {
			if (keybindings.size > 1) {
				this.conflicts.push({ key, keybindings: [...keybindings] });
			}
		}

		for (const [id, definition] of Object.entries(this.definitions)) {
			const userKeys = this.userBindings[id];
			const keys =
				userKeys === undefined ? normalizeKeys(definition.defaultKeys) : normalizeKeys(userKeys);
			this.keysById.set(id as Keybinding, keys);
		}
	}

	matches(data: string, keybinding: Keybinding): boolean {
		const keys = this.keysById.get(keybinding) ?? [];
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		return [...(this.keysById.get(keybinding) ?? [])];
	}

	getDefinition(keybinding: Keybinding): KeybindingDefinition {
		return this.definitions[keybinding];
	}

	getConflicts(): KeybindingConflict[] {
		return this.conflicts.map((conflict) => ({
			...conflict,
			keybindings: [...conflict.keybindings],
		}));
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.userBindings = userBindings;
		this.rebuild();
	}

	getUserBindings(): KeybindingsConfig {
		return { ...this.userBindings };
	}

	getResolvedBindings(): KeybindingsConfig {
		const resolved: KeybindingsConfig = {};
		for (const id of Object.keys(this.definitions)) {
			const keys = this.keysById.get(id as Keybinding) ?? [];
			resolved[id] = keys.length === 1 ? keys[0]! : [...keys];
		}
		return resolved;
	}
}

let globalKeybindings: KeybindingsManager | null = null;

export function setKeybindings(keybindings: KeybindingsManager): void {
	globalKeybindings = keybindings;
}

export function getKeybindings(): KeybindingsManager {
	if (!globalKeybindings) {
		globalKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	}
	return globalKeybindings;
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
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	jumpBackward: "tui.editor.jumpBackward",
	jumpForward: "tui.editor.jumpForward",
	newLine: "tui.input.newLine",
	pageDown: "tui.editor.pageDown",
	pageUp: "tui.editor.pageUp",
	selectCancel: "tui.select.cancel",
	selectConfirm: "tui.select.confirm",
	selectDown: "tui.select.down",
	selectPageDown: "tui.select.pageDown",
	selectPageUp: "tui.select.pageUp",
	selectUp: "tui.select.up",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	undo: "tui.editor.undo",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
} as const;

export type EditorAction = keyof typeof LEGACY_TO_MODERN_KEYBINDINGS;
export type EditorKeybindingsConfig = Partial<Record<EditorAction, KeyId | KeyId[] | undefined>>;
export const DEFAULT_EDITOR_KEYBINDINGS: Required<Record<EditorAction, KeyId | KeyId[]>> = {
	copy: TUI_KEYBINDINGS["tui.input.copy"].defaultKeys,
	cursorDown: TUI_KEYBINDINGS["tui.editor.cursorDown"].defaultKeys,
	cursorLeft: TUI_KEYBINDINGS["tui.editor.cursorLeft"].defaultKeys,
	cursorLineEnd: TUI_KEYBINDINGS["tui.editor.cursorLineEnd"].defaultKeys,
	cursorLineStart: TUI_KEYBINDINGS["tui.editor.cursorLineStart"].defaultKeys,
	cursorRight: TUI_KEYBINDINGS["tui.editor.cursorRight"].defaultKeys,
	cursorUp: TUI_KEYBINDINGS["tui.editor.cursorUp"].defaultKeys,
	cursorWordLeft: TUI_KEYBINDINGS["tui.editor.cursorWordLeft"].defaultKeys,
	cursorWordRight: TUI_KEYBINDINGS["tui.editor.cursorWordRight"].defaultKeys,
	deleteCharBackward: TUI_KEYBINDINGS["tui.editor.deleteCharBackward"].defaultKeys,
	deleteCharForward: TUI_KEYBINDINGS["tui.editor.deleteCharForward"].defaultKeys,
	deleteToLineEnd: TUI_KEYBINDINGS["tui.editor.deleteToLineEnd"].defaultKeys,
	deleteToLineStart: TUI_KEYBINDINGS["tui.editor.deleteToLineStart"].defaultKeys,
	deleteWordBackward: TUI_KEYBINDINGS["tui.editor.deleteWordBackward"].defaultKeys,
	deleteWordForward: TUI_KEYBINDINGS["tui.editor.deleteWordForward"].defaultKeys,
	jumpBackward: TUI_KEYBINDINGS["tui.editor.jumpBackward"].defaultKeys,
	jumpForward: TUI_KEYBINDINGS["tui.editor.jumpForward"].defaultKeys,
	newLine: TUI_KEYBINDINGS["tui.input.newLine"].defaultKeys,
	pageDown: TUI_KEYBINDINGS["tui.editor.pageDown"].defaultKeys,
	pageUp: TUI_KEYBINDINGS["tui.editor.pageUp"].defaultKeys,
	selectCancel: TUI_KEYBINDINGS["tui.select.cancel"].defaultKeys,
	selectConfirm: TUI_KEYBINDINGS["tui.select.confirm"].defaultKeys,
	selectDown: TUI_KEYBINDINGS["tui.select.down"].defaultKeys,
	selectPageDown: TUI_KEYBINDINGS["tui.select.pageDown"].defaultKeys,
	selectPageUp: TUI_KEYBINDINGS["tui.select.pageUp"].defaultKeys,
	selectUp: TUI_KEYBINDINGS["tui.select.up"].defaultKeys,
	submit: TUI_KEYBINDINGS["tui.input.submit"].defaultKeys,
	tab: TUI_KEYBINDINGS["tui.input.tab"].defaultKeys,
	undo: TUI_KEYBINDINGS["tui.editor.undo"].defaultKeys,
	yank: TUI_KEYBINDINGS["tui.editor.yank"].defaultKeys,
	yankPop: TUI_KEYBINDINGS["tui.editor.yankPop"].defaultKeys,
};

export class EditorKeybindingsManager {
	private readonly manager: KeybindingsManager;

	constructor(config: EditorKeybindingsConfig = {}) {
		const normalized: KeybindingsConfig = {};
		for (const [legacy, modern] of Object.entries(LEGACY_TO_MODERN_KEYBINDINGS)) {
			const value = config[legacy as EditorAction];
			if (value !== undefined) {
				normalized[modern as Keybinding] = value;
			}
		}
		this.manager = new KeybindingsManager(TUI_KEYBINDINGS, normalized);
	}

	matches(data: string, keybinding: EditorAction): boolean {
		return this.manager.matches(data, LEGACY_TO_MODERN_KEYBINDINGS[keybinding] as Keybinding);
	}

	getKeys(keybinding: EditorAction): KeyId[] {
		return this.manager.getKeys(LEGACY_TO_MODERN_KEYBINDINGS[keybinding] as Keybinding);
	}

	getResolvedBindings(): EditorKeybindingsConfig {
		const resolved: EditorKeybindingsConfig = {};
		for (const [legacy, modern] of Object.entries(LEGACY_TO_MODERN_KEYBINDINGS)) {
			resolved[legacy as EditorAction] = this.manager.getResolvedBindings()[modern as Keybinding];
		}
		return resolved;
	}
}

let globalEditorKeybindings: EditorKeybindingsManager | null = null;

export function getEditorKeybindings(): EditorKeybindingsManager {
	if (!globalEditorKeybindings) {
		globalEditorKeybindings = new EditorKeybindingsManager();
	}
	return globalEditorKeybindings;
}

export function setEditorKeybindings(manager: EditorKeybindingsManager): void {
	globalEditorKeybindings = manager;
}
