const APPLY_FLAG = "__tallow_pi_tui_patch_applied__";
const GHOST_TEXT_COLOR = "\x1b[38;5;242m";
const RESET = "\x1b[0m";
const CURSOR_SEGMENT_WITH_MARKER = `${String.fromCharCode(0xffff)}\x1b[7m \x1b[0m`;
const CURSOR_SEGMENT = "\x1b[7m \x1b[0m";

type ChangeListener = (text: string) => void;

type SettingsListPatchedLike = {
	__tallow_lastRenderLineCount?: number;
	__tallow_layoutTransitionCallback?: () => void;
	__tallow_nextMinLineCount?: number;
};

type EditorPrototypeLike = {
	[APPLY_FLAG]?: boolean;
	handleInput?: (data: string) => void;
	render?: (width: number) => string[];
	setText?: (text: string) => void;
};

type SettingsListPrototypeLike = {
	activateItem?: () => void;
	closeSubmenu?: () => void;
	[APPLY_FLAG]?: boolean;
	render?: (width: number) => string[];
	setLayoutTransitionCallback?: (callback?: () => void) => void;
};

type EditorPatchedLike = {
	autocompleteState?: "regular" | "force" | null;
	disableSubmit?: boolean;
	getText(): string;
	onSubmit?: (text: string) => void;
	render(width: number): string[];
	handleInput(data: string): void;
	setText(text: string): void;
	setGhostText?(text: string | null): void;
	getGhostText?(): string | null;
	addChangeListener?(fn: ChangeListener): void;
	insertTextAtCursor?(text: string): void;
	tui?: { requestRender?: () => void };
};

const editorGhostText = new WeakMap<object, string | null>();
const editorChangeListeners = new WeakMap<object, ChangeListener[]>();

function getGhostText(editor: object): string | null {
	return editorGhostText.get(editor) ?? null;
}

function setGhostText(editor: object, text: string | null): void {
	editorGhostText.set(editor, text);
}

function getChangeListeners(editor: object): ChangeListener[] {
	let listeners = editorChangeListeners.get(editor);
	if (!listeners) {
		listeners = [];
		editorChangeListeners.set(editor, listeners);
	}
	return listeners;
}

function notifyChangeListeners(editor: EditorPatchedLike): void {
	const text = editor.getText();
	for (const listener of getChangeListeners(editor as object)) {
		listener(text);
	}
}

function acceptGhostText(editor: EditorPatchedLike): boolean {
	const ghostText = getGhostText(editor as object);
	if (!ghostText) return false;
	setGhostText(editor as object, null);
	editor.insertTextAtCursor?.(ghostText);
	notifyChangeListeners(editor);
	return true;
}

function visibleWidth(text: string): number {
	return text.length;
}

function truncateToWidth(text: string, maxWidth: number, ellipsis = ""): string {
	if (maxWidth <= 0) return "";
	return text.length <= maxWidth ? text : `${text.slice(0, maxWidth - ellipsis.length)}${ellipsis}`;
}

function isEscapeInput(data: string): boolean {
	return data === "\x1b";
}

function isTabInput(data: string): boolean {
	return data === "\t";
}

function isEnterInput(data: string): boolean {
	return data === "\r" || data === "\n" || data === "\x1bOM";
}

function maybeInjectGhostText(line: string, ghostText: string | null): string {
	if (!ghostText) return line;
	for (const cursorSegment of [CURSOR_SEGMENT_WITH_MARKER, CURSOR_SEGMENT]) {
		const cursorIndex = line.indexOf(cursorSegment);
		if (cursorIndex === -1) continue;
		const afterCursor = line.slice(cursorIndex + cursorSegment.length);
		const trailingSpaces = afterCursor.match(/^ +/);
		if (!trailingSpaces) continue;
		const availableWidth = trailingSpaces[0].length;
		if (availableWidth <= 0) continue;
		const truncatedGhost = truncateToWidth(ghostText, availableWidth, "");
		const remainingSpaces = " ".repeat(Math.max(0, availableWidth - visibleWidth(truncatedGhost)));
		return `${line.slice(0, cursorIndex + cursorSegment.length)}${GHOST_TEXT_COLOR}${truncatedGhost}${RESET}${remainingSpaces}${afterCursor.slice(trailingSpaces[0].length)}`;
	}
	return line;
}

function shouldClearGhostText(editor: EditorPatchedLike, data: string): boolean {
	if (!getGhostText(editor as object)) return false;
	if (editor.autocompleteState) return false;
	if (isTabInput(data)) return false;
	if (isEnterInput(data) && editor.getText().trim().length === 0) return false;
	return true;
}

function patchEditorPrototype(prototype: EditorPrototypeLike): void {
	if (prototype[APPLY_FLAG]) return;
	prototype[APPLY_FLAG] = true;

	const originalRender = prototype.render;
	if (typeof originalRender === "function") {
		prototype.render = function (this: EditorPatchedLike, width: number): string[] {
			const lines = originalRender.call(this, width);
			const ghostText = getGhostText(this as object);
			return ghostText ? lines.map((line) => maybeInjectGhostText(line, ghostText)) : lines;
		};
	}

	const originalSetText = prototype.setText;
	if (typeof originalSetText === "function") {
		prototype.setText = function (this: EditorPatchedLike, text: string): void {
			setGhostText(this as object, null);
			originalSetText.call(this, text);
			notifyChangeListeners(this);
		};
	}

	const originalHandleInput = prototype.handleInput;
	if (typeof originalHandleInput === "function") {
		prototype.handleInput = function (this: EditorPatchedLike, data: string): void {
			if (isEscapeInput(data) && !this.autocompleteState && getGhostText(this as object)) {
				setGhostText(this as object, null);
				this.tui?.requestRender?.();
				return;
			}
			if (isTabInput(data) && !this.autocompleteState && acceptGhostText(this)) {
				return;
			}
			if (
				isEnterInput(data) &&
				!this.disableSubmit &&
				this.getText().trim().length === 0 &&
				acceptGhostText(this)
			) {
				originalHandleInput.call(this, data);
				return;
			}
			if (shouldClearGhostText(this, data)) {
				setGhostText(this as object, null);
			}
			const beforeText = this.getText();
			originalHandleInput.call(this, data);
			if (beforeText !== this.getText()) {
				notifyChangeListeners(this);
			}
		};
	}

	Object.defineProperty(prototype, "setGhostText", {
		value: function (this: EditorPatchedLike, text: string | null): void {
			if (getGhostText(this as object) !== text) {
				setGhostText(this as object, text);
				this.tui?.requestRender?.();
			}
		},
		configurable: true,
	});

	Object.defineProperty(prototype, "getGhostText", {
		value: function (this: EditorPatchedLike): string | null {
			return getGhostText(this as object);
		},
		configurable: true,
	});

	Object.defineProperty(prototype, "addChangeListener", {
		value: function (this: EditorPatchedLike, listener: ChangeListener): void {
			getChangeListeners(this as object).push(listener);
		},
		configurable: true,
	});
}

function patchSettingsListPrototype(prototype: SettingsListPrototypeLike): void {
	if (prototype[APPLY_FLAG]) return;
	prototype[APPLY_FLAG] = true;

	prototype.setLayoutTransitionCallback = function (
		this: SettingsListPatchedLike,
		callback?: () => void
	): void {
		this.__tallow_layoutTransitionCallback = callback;
	};

	const originalRender = prototype.render;
	if (typeof originalRender === "function") {
		prototype.render = function (this: SettingsListPatchedLike, width: number): string[] {
			const lines = originalRender.call(this, width);
			const minLineCount = this.__tallow_nextMinLineCount ?? 0;
			const paddedLines =
				minLineCount > lines.length
					? [...lines, ...Array.from({ length: minLineCount - lines.length }, () => "")]
					: lines;
			this.__tallow_nextMinLineCount = 0;
			this.__tallow_lastRenderLineCount = paddedLines.length;
			return paddedLines;
		};
	}

	const originalActivateItem = prototype.activateItem;
	if (typeof originalActivateItem === "function") {
		prototype.activateItem = function (this: SettingsListPatchedLike): void {
			this.__tallow_layoutTransitionCallback?.();
			originalActivateItem.call(this);
		};
	}

	const originalCloseSubmenu = prototype.closeSubmenu;
	if (typeof originalCloseSubmenu === "function") {
		prototype.closeSubmenu = function (this: SettingsListPatchedLike): void {
			this.__tallow_layoutTransitionCallback?.();
			this.__tallow_nextMinLineCount = this.__tallow_lastRenderLineCount ?? 0;
			originalCloseSubmenu.call(this);
		};
	}
}

export async function applyPiTuiPatches(): Promise<void> {
	const mod = (await import("@mariozechner/pi-tui")) as unknown as {
		Editor?: { prototype?: EditorPrototypeLike };
		SettingsList?: { prototype?: SettingsListPrototypeLike };
	};
	const editorPrototype = mod.Editor?.prototype;
	if (editorPrototype) {
		patchEditorPrototype(editorPrototype);
	}
	const settingsListPrototype = mod.SettingsList?.prototype;
	if (settingsListPrototype) {
		patchSettingsListPrototype(settingsListPrototype);
	}
}
