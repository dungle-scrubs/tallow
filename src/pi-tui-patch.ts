import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	truncateToWidth as piTruncateToWidth,
	visibleWidth as piVisibleWidth,
} from "@mariozechner/pi-tui";

const APPLY_FLAG = "__tallow_pi_tui_patch_applied__";
const GHOST_TEXT_COLOR = "\x1b[38;5;242m";
const RESET = "\x1b[0m";
const CURSOR_SEGMENT_WITH_MARKER = `${String.fromCharCode(0xffff)}\x1b[7m \x1b[0m`;
const CURSOR_SEGMENT = "\x1b[7m \x1b[0m";
const STARTUP_GRACE_MS = 3000;
const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";

type ChangeListener = (text: string) => void;

type SettingsListPatchedLike = {
	__tallow_lastRenderLineCount?: number;
	__tallow_layoutTransitionCallback?: () => void;
	__tallow_nextMinLineCount?: number;
};

type TuiPrototypeLike = {
	[APPLY_FLAG]?: boolean;
	start?: () => void;
	queryCellSize?: () => void;
	requestRender?: (force?: boolean) => void;
	doRender?: () => void;
	resetRenderGrace?: () => void;
	requestScrollbackClear?: () => void;
	beginRenderBatch?: () => void;
	endRenderBatch?: () => void;
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

type TuiPatchedLike = {
	stop?(): void;
	applyLineResets(lines: string[]): string[];
	cellSizeQueryPending?: boolean;
	clearOnShrink: boolean;
	compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[];
	cursorRow: number;
	doRender(): void;
	extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null;
	focusedComponent?: { handleInput?: (data: string) => void; wantsKeyRelease?: boolean } | null;
	fullRedrawCount: number;
	hardwareCursorRow: number;
	inputBuffer?: string;
	isOverlayVisible(entry: unknown): boolean;
	maxLinesRendered: number;
	overlayStack: Array<unknown>;
	positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void;
	previousLines: string[];
	previousViewportTop: number;
	previousWidth: number;
	render(width: number): string[];
	renderRequested?: boolean;
	scheduleRender?(): void;
	showHardwareCursor?: boolean;
	stopped?: boolean;
	terminal: { columns: number; rows: number; write(data: string): void };
	requestRender(force?: boolean): void;
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

function simpleVisibleWidth(text: string): number {
	return text.length;
}

function simpleTruncateToWidth(text: string, maxWidth: number, ellipsis = ""): string {
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

function isImageLineLocal(line: string): boolean {
	return (
		line.startsWith(KITTY_PREFIX) ||
		line.startsWith(ITERM2_PREFIX) ||
		line.includes(KITTY_PREFIX) ||
		line.includes(ITERM2_PREFIX)
	);
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
		const truncatedGhost = simpleTruncateToWidth(ghostText, availableWidth, "");
		const remainingSpaces = " ".repeat(
			Math.max(0, availableWidth - simpleVisibleWidth(truncatedGhost))
		);
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

const tuiStartedAtMs = new WeakMap<object, number>();
const tuiPendingScrollbackClear = new WeakMap<object, boolean>();
const tuiRenderBatchDepth = new WeakMap<object, number>();
const tuiRenderDeferredDuringBatch = new WeakMap<object, boolean>();
const tuiRenderForceDeferredDuringBatch = new WeakMap<object, boolean>();
const tuiRollingShrinkPeak = new WeakMap<object, number>();

function getTuiRenderBatchDepth(tui: object): number {
	return tuiRenderBatchDepth.get(tui) ?? 0;
}

function getTuiPendingScrollbackClear(tui: object): boolean {
	return tuiPendingScrollbackClear.get(tui) ?? false;
}

function setTuiPendingScrollbackClear(tui: object, value: boolean): void {
	tuiPendingScrollbackClear.set(tui, value);
}

function getTuiRollingShrinkPeak(tui: object): number {
	return tuiRollingShrinkPeak.get(tui) ?? 0;
}

function setTuiRollingShrinkPeak(tui: object, value: number): void {
	tuiRollingShrinkPeak.set(tui, value);
}

function patchTuiPrototype(prototype: TuiPrototypeLike): void {
	if (prototype[APPLY_FLAG]) return;
	prototype[APPLY_FLAG] = true;

	prototype.resetRenderGrace = function (this: object): void {
		tuiStartedAtMs.set(this, Date.now());
	};

	prototype.requestScrollbackClear = function (this: object): void {
		setTuiPendingScrollbackClear(this, true);
	};

	prototype.beginRenderBatch = function (this: object): void {
		tuiRenderBatchDepth.set(this, getTuiRenderBatchDepth(this) + 1);
	};

	prototype.endRenderBatch = function (this: TuiPatchedLike & object): void {
		const depth = getTuiRenderBatchDepth(this);
		if (depth <= 0) return;
		tuiRenderBatchDepth.set(this, depth - 1);
		if (depth === 1 && (tuiRenderDeferredDuringBatch.get(this) ?? false)) {
			const wasForce = tuiRenderForceDeferredDuringBatch.get(this) ?? false;
			tuiRenderDeferredDuringBatch.set(this, false);
			tuiRenderForceDeferredDuringBatch.set(this, false);
			this.requestRender(wasForce);
		}
	};

	const originalStart = prototype.start;
	if (typeof originalStart === "function") {
		prototype.start = function (this: TuiPatchedLike & object): void {
			tuiStartedAtMs.set(this, Date.now());
			originalStart.call(this);
		};
	}

	const originalQueryCellSize = prototype.queryCellSize;
	if (typeof originalQueryCellSize === "function") {
		prototype.queryCellSize = function (this: TuiPatchedLike): void {
			if (process.env.TMUX) {
				return;
			}
			originalQueryCellSize.call(this);
		};
	}

	const originalRequestRender = prototype.requestRender;
	if (typeof originalRequestRender === "function") {
		prototype.requestRender = function (this: TuiPatchedLike & object, force = false): void {
			if (force) {
				setTuiRollingShrinkPeak(this, 0);
			}
			if (getTuiRenderBatchDepth(this) > 0) {
				tuiRenderDeferredDuringBatch.set(this, true);
				if (force) tuiRenderForceDeferredDuringBatch.set(this, true);
				return;
			}
			originalRequestRender.call(this, force);
		};
	}

	prototype.doRender = function (this: TuiPatchedLike & object): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		let viewportTop = Math.max(0, this.maxLinesRendered - height);
		let prevViewportTop = this.previousViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		let newLines = this.render(width);
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}
		const cursorPos = this.extractCursorPosition(newLines, height);
		newLines = this.applyLineResets(newLines);
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const inStartupGrace =
			(tuiStartedAtMs.get(this) ?? 0) > 0 &&
			Date.now() - (tuiStartedAtMs.get(this) ?? 0) < STARTUP_GRACE_MS;

		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			const viewportTopForRender = Math.max(0, newLines.length - height);
			const visibleLines = newLines.slice(viewportTopForRender);
			let buffer = "\x1b[?2026h";
			if (clear && getTuiPendingScrollbackClear(this)) {
				buffer += "\x1b[3J\x1b[2J\x1b[H";
				setTuiPendingScrollbackClear(this, false);
			} else if (clear) {
				buffer += "\x1b[2J\x1b[H";
			}
			for (let i = 0; i < visibleLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += visibleLines[i];
			}
			buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			this.previousViewportTop = viewportTopForRender;
			setTuiRollingShrinkPeak(this, newLines.length);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
		};

		const gentleFullRender = (): void => {
			this.fullRedrawCount += 1;
			const viewportTopForRender = Math.max(0, newLines.length - height);
			const visibleLines = newLines.slice(viewportTopForRender);
			let buffer = "\x1b[?2026h\x1b[H";
			for (let i = 0; i < visibleLines.length; i++) {
				buffer += "\x1b[2K";
				buffer += visibleLines[i];
				if (i < visibleLines.length - 1) buffer += "\r\n";
			}
			const staleLines = Math.max(0, Math.min(this.maxLinesRendered, height) - visibleLines.length);
			for (let i = 0; i < staleLines; i++) {
				buffer += "\r\n\x1b[2K";
			}
			buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			this.maxLinesRendered = newLines.length;
			this.previousViewportTop = viewportTopForRender;
			setTuiRollingShrinkPeak(this, newLines.length);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		if (this.previousLines.length === 0 && !widthChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}
		if (widthChanged) {
			logRedraw(`width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}
		if (
			this.clearOnShrink &&
			newLines.length < this.maxLinesRendered &&
			this.overlayStack.length === 0
		) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			if (inStartupGrace) {
				gentleFullRender();
			} else {
				fullRender(true);
			}
			return;
		}
		const shrinkDelta = this.previousLines.length - newLines.length;
		if (shrinkDelta > 5 && this.overlayStack.length === 0) {
			logRedraw(`large shrink (${shrinkDelta} lines)`);
			if (inStartupGrace) {
				gentleFullRender();
			} else {
				fullRender(true);
			}
			return;
		}
		if (newLines.length >= getTuiRollingShrinkPeak(this)) {
			setTuiRollingShrinkPeak(this, newLines.length);
		} else if (
			this.overlayStack.length === 0 &&
			getTuiRollingShrinkPeak(this) - newLines.length > 5
		) {
			logRedraw(
				`rolling shrink (peak=${getTuiRollingShrinkPeak(this)}, now=${newLines.length}, delta=${getTuiRollingShrinkPeak(this) - newLines.length})`
			);
			if (inStartupGrace) {
				gentleFullRender();
			} else {
				fullRender(true);
			}
			return;
		}

		const previousContentViewportTop = Math.max(0, this.previousLines.length - height);
		const hasViewportBasisDrift =
			this.overlayStack.length === 0 &&
			this.previousLines.length > 0 &&
			this.maxLinesRendered > newLines.length &&
			prevViewportTop !== previousContentViewportTop;
		if (hasViewportBasisDrift) {
			this.maxLinesRendered = newLines.length;
			viewportTop = Math.max(0, this.maxLinesRendered - height);
			prevViewportTop = viewportTop;
			this.previousViewportTop = viewportTop;
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";
			if (oldLine !== newLine) {
				if (firstChanged === -1) firstChanged = i;
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) firstChanged = this.previousLines.length;
			lastChanged = newLines.length - 1;
		}
		const appendStart =
			appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			return;
		}
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				const targetRow = Math.max(0, newLines.length - 1);
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					if (inStartupGrace) gentleFullRender();
					else fullRender(true);
					return;
				}
				if (extraLines > 0) buffer += "\x1b[1B";
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				if (extraLines > 0) buffer += `\x1b[${extraLines}A`;
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			return;
		}
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			if (inStartupGrace) gentleFullRender();
			else fullRender(true);
			return;
		}

		let buffer = "\x1b[?2026h";
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(
				0,
				Math.min(height - 1, hardwareCursorRow - prevViewportTop)
			);
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
		buffer += appendStart ? "\r\n" : "\r";
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K";
			let line = newLines[i];
			const isImage = isImageLineLocal(line);
			if (!isImage && piVisibleWidth(line) > width) {
				const crashLogPath = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${piVisibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${piVisibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);
				if (process.env.TALLOW_DEBUG || process.env.PI_DEBUG) {
					this.stop?.();
					throw new Error(
						`Rendered line ${i} exceeds terminal width (${piVisibleWidth(line)} > ${width}).`
					);
				}
				line = piTruncateToWidth(line, width, "");
				newLines[i] = line;
			}
			buffer += line;
		}
		let finalCursorRow = renderEnd;
		if (this.previousLines.length > newLines.length) {
			const extraLines = this.previousLines.length - newLines.length;
			if (extraLines > height) {
				logRedraw(`extraLines > height in diff path (${extraLines} > ${height})`);
				fullRender(true);
				return;
			}
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			buffer += `\x1b[${extraLines}A`;
		}
		buffer += "\x1b[?2026l";
		this.terminal.write(buffer);
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		if (this.overlayStack.length === 0) {
			this.maxLinesRendered = newLines.length;
		} else {
			this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		}
		this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
		setTuiRollingShrinkPeak(this, Math.max(getTuiRollingShrinkPeak(this), newLines.length));
		this.positionHardwareCursor(cursorPos, newLines.length);
		this.previousLines = newLines;
		this.previousWidth = width;
		return;
	};
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
		TUI?: { prototype?: TuiPrototypeLike };
	};
	const editorPrototype = mod.Editor?.prototype;
	if (editorPrototype) {
		patchEditorPrototype(editorPrototype);
	}
	const settingsListPrototype = mod.SettingsList?.prototype;
	if (settingsListPrototype) {
		patchSettingsListPrototype(settingsListPrototype);
	}
	const tuiPrototype = mod.TUI?.prototype;
	if (tuiPrototype) {
		patchTuiPrototype(tuiPrototype);
	}
}
