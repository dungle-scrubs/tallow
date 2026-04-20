import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	truncateToWidth as piTruncateToWidth,
	visibleWidth as piVisibleWidth,
} from "@mariozechner/pi-tui";
import { patchEditorPrototype } from "./pi-tui-editor-patch.js";
import { patchSettingsListPrototype } from "./pi-tui-settings-list-patch.js";

const APPLY_FLAG = "__tallow_pi_tui_patch_applied__";
const STARTUP_GRACE_MS = 3000;
const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";

function isImageLineLocal(line: string): boolean {
	return (
		line.startsWith(KITTY_PREFIX) ||
		line.startsWith(ITERM2_PREFIX) ||
		line.includes(KITTY_PREFIX) ||
		line.includes(ITERM2_PREFIX)
	);
}

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

type CursorPosition = { row: number; col: number } | null;

type RenderSnapshot = {
	readonly cursorPos: CursorPosition;
	readonly height: number;
	readonly inStartupGrace: boolean;
	readonly newLines: string[];
	readonly width: number;
	readonly widthChanged: boolean;
};

type ViewportState = {
	hardwareCursorRow: number;
	prevViewportTop: number;
	viewportTop: number;
};

type ChangedWindow = {
	readonly appendStart: boolean;
	readonly firstChanged: number;
	readonly lastChanged: number;
};

/**
 * Build the current render snapshot from the patched TUI.
 *
 * @param tui - Patched TUI instance
 * @returns Snapshot used by render helpers
 */
function createRenderSnapshot(tui: TuiPatchedLike & object): RenderSnapshot {
	const width = tui.terminal.columns;
	const height = tui.terminal.rows;
	let newLines = tui.render(width);
	if (tui.overlayStack.length > 0) {
		newLines = tui.compositeOverlays(newLines, width, height);
	}
	const cursorPos = tui.extractCursorPosition(newLines, height);
	newLines = tui.applyLineResets(newLines);
	const startedAt = tuiStartedAtMs.get(tui) ?? 0;
	return {
		cursorPos,
		height,
		inStartupGrace: startedAt > 0 && Date.now() - startedAt < STARTUP_GRACE_MS,
		newLines,
		width,
		widthChanged: tui.previousWidth !== 0 && tui.previousWidth !== width,
	};
}

/**
 * Create a redraw logger when debug logging is enabled.
 *
 * @param tui - Patched TUI instance
 * @param snapshot - Current render snapshot
 * @returns Logger callback
 */
function createRedrawLogger(
	tui: TuiPatchedLike,
	snapshot: RenderSnapshot
): (reason: string) => void {
	const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
	return (reason: string): void => {
		if (!debugRedraw) return;
		const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
		const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${tui.previousLines.length}, new=${snapshot.newLines.length}, height=${snapshot.height})\n`;
		fs.appendFileSync(logPath, msg);
	};
}

/**
 * Persist render bookkeeping shared by all render strategies.
 *
 * @param tui - Patched TUI instance
 * @param snapshot - Current render snapshot
 * @param viewportTopForRender - Top line rendered into the viewport
 * @param preserveMaxLines - Whether maxLinesRendered should grow instead of reset
 * @returns Nothing
 */
function finalizeRenderedState(
	tui: TuiPatchedLike,
	snapshot: RenderSnapshot,
	viewportTopForRender: number,
	preserveMaxLines: boolean
): void {
	tui.cursorRow = Math.max(0, snapshot.newLines.length - 1);
	tui.hardwareCursorRow = tui.cursorRow;
	tui.maxLinesRendered = preserveMaxLines
		? Math.max(tui.maxLinesRendered, snapshot.newLines.length)
		: snapshot.newLines.length;
	tui.previousViewportTop = viewportTopForRender;
	setTuiRollingShrinkPeak(tui, snapshot.newLines.length);
	tui.positionHardwareCursor(snapshot.cursorPos, snapshot.newLines.length);
	tui.previousLines = snapshot.newLines;
	tui.previousWidth = snapshot.width;
}

/**
 * Write a full redraw of the visible tail.
 *
 * @param tui - Patched TUI instance
 * @param snapshot - Current render snapshot
 * @param clear - Whether to clear the screen before rendering
 * @returns Nothing
 */
function writeFullRender(
	tui: TuiPatchedLike & object,
	snapshot: RenderSnapshot,
	clear: boolean
): void {
	tui.fullRedrawCount += 1;
	const viewportTopForRender = Math.max(0, snapshot.newLines.length - snapshot.height);
	const visibleLines = snapshot.newLines.slice(viewportTopForRender);
	let buffer = "\x1b[?2026h";
	if (clear && getTuiPendingScrollbackClear(tui)) {
		buffer += "\x1b[3J\x1b[2J\x1b[H";
		setTuiPendingScrollbackClear(tui, false);
	} else if (clear) {
		buffer += "\x1b[2J\x1b[H";
	}
	for (let index = 0; index < visibleLines.length; index += 1) {
		if (index > 0) buffer += "\r\n";
		buffer += visibleLines[index];
	}
	buffer += "\x1b[?2026l";
	tui.terminal.write(buffer);
	finalizeRenderedState(tui, snapshot, viewportTopForRender, !clear);
}

/**
 * Write a startup-safe redraw that clears only stale visible rows.
 *
 * @param tui - Patched TUI instance
 * @param snapshot - Current render snapshot
 * @returns Nothing
 */
function writeGentleFullRender(tui: TuiPatchedLike, snapshot: RenderSnapshot): void {
	tui.fullRedrawCount += 1;
	const viewportTopForRender = Math.max(0, snapshot.newLines.length - snapshot.height);
	const visibleLines = snapshot.newLines.slice(viewportTopForRender);
	let buffer = "\x1b[?2026h\x1b[H";
	for (let index = 0; index < visibleLines.length; index += 1) {
		buffer += "\x1b[2K";
		buffer += visibleLines[index];
		if (index < visibleLines.length - 1) buffer += "\r\n";
	}
	const staleLines = Math.max(
		0,
		Math.min(tui.maxLinesRendered, snapshot.height) - visibleLines.length
	);
	for (let index = 0; index < staleLines; index += 1) {
		buffer += "\r\n\x1b[2K";
	}
	buffer += "\x1b[?2026l";
	tui.terminal.write(buffer);
	finalizeRenderedState(tui, snapshot, viewportTopForRender, false);
}

/**
 * Apply render rules that require a full redraw and report whether rendering is done.
 *
 * @param tui - Patched TUI instance
 * @param snapshot - Current render snapshot
 * @param logRedraw - Debug logger
 * @returns True when rendering was handled
 */
function handleEarlyFullRender(
	tui: TuiPatchedLike & object,
	snapshot: RenderSnapshot,
	logRedraw: (reason: string) => void
): boolean {
	if (tui.previousLines.length === 0 && !snapshot.widthChanged) {
		logRedraw("first render");
		writeFullRender(tui, snapshot, false);
		return true;
	}
	if (snapshot.widthChanged) {
		logRedraw(`width changed (${tui.previousWidth} -> ${snapshot.width})`);
		writeFullRender(tui, snapshot, true);
		return true;
	}
	if (
		tui.clearOnShrink &&
		snapshot.newLines.length < tui.maxLinesRendered &&
		tui.overlayStack.length === 0
	) {
		logRedraw(`clearOnShrink (maxLinesRendered=${tui.maxLinesRendered})`);
		if (snapshot.inStartupGrace) {
			writeGentleFullRender(tui, snapshot);
		} else {
			writeFullRender(tui, snapshot, true);
		}
		return true;
	}
	const shrinkDelta = tui.previousLines.length - snapshot.newLines.length;
	if (shrinkDelta > 5 && tui.overlayStack.length === 0) {
		logRedraw(`large shrink (${shrinkDelta} lines)`);
		if (snapshot.inStartupGrace) {
			writeGentleFullRender(tui, snapshot);
		} else {
			writeFullRender(tui, snapshot, true);
		}
		return true;
	}
	const rollingPeak = getTuiRollingShrinkPeak(tui);
	if (snapshot.newLines.length >= rollingPeak) {
		setTuiRollingShrinkPeak(tui, snapshot.newLines.length);
		return false;
	}
	if (tui.overlayStack.length > 0 || rollingPeak - snapshot.newLines.length <= 5) {
		return false;
	}
	logRedraw(
		`rolling shrink (peak=${rollingPeak}, now=${snapshot.newLines.length}, delta=${rollingPeak - snapshot.newLines.length})`
	);
	if (snapshot.inStartupGrace) {
		writeGentleFullRender(tui, snapshot);
	} else {
		writeFullRender(tui, snapshot, true);
	}
	return true;
}

/**
 * Normalize viewport state when previous viewport math drifted after a shrink.
 *
 * @param tui - Patched TUI instance
 * @param snapshot - Current render snapshot
 * @param viewportState - Mutable viewport state
 * @returns Nothing
 */
function normalizeViewportBasisDrift(
	tui: TuiPatchedLike,
	snapshot: RenderSnapshot,
	viewportState: ViewportState
): void {
	const previousContentViewportTop = Math.max(0, tui.previousLines.length - snapshot.height);
	const hasViewportBasisDrift =
		tui.overlayStack.length === 0 &&
		tui.previousLines.length > 0 &&
		tui.maxLinesRendered > snapshot.newLines.length &&
		viewportState.prevViewportTop !== previousContentViewportTop;
	if (!hasViewportBasisDrift) return;
	tui.maxLinesRendered = snapshot.newLines.length;
	viewportState.viewportTop = Math.max(0, tui.maxLinesRendered - snapshot.height);
	viewportState.prevViewportTop = viewportState.viewportTop;
	tui.previousViewportTop = viewportState.viewportTop;
}

/**
 * Find the changed window between the previous and current frames.
 *
 * @param previousLines - Previously rendered lines
 * @param newLines - Newly rendered lines
 * @returns Changed window metadata
 */
function findChangedWindow(previousLines: string[], newLines: string[]): ChangedWindow {
	let firstChanged = -1;
	let lastChanged = -1;
	const maxLines = Math.max(newLines.length, previousLines.length);
	for (let index = 0; index < maxLines; index += 1) {
		const oldLine = index < previousLines.length ? previousLines[index] : "";
		const newLine = index < newLines.length ? newLines[index] : "";
		if (oldLine !== newLine) {
			if (firstChanged === -1) firstChanged = index;
			lastChanged = index;
		}
	}
	const appendedLines = newLines.length > previousLines.length;
	if (appendedLines) {
		if (firstChanged === -1) firstChanged = previousLines.length;
		lastChanged = newLines.length - 1;
	}
	return {
		appendStart: appendedLines && firstChanged === previousLines.length && firstChanged > 0,
		firstChanged,
		lastChanged,
	};
}

/**
 * Move the diff renderer to the target row, scrolling if needed.
 *
 * @param buffer - Escape-sequence buffer
 * @param viewportState - Mutable viewport state
 * @param moveTargetRow - Target row in the content
 * @param height - Terminal height
 * @returns Updated buffer
 */
function moveBufferToTargetRow(
	buffer: string,
	viewportState: ViewportState,
	moveTargetRow: number,
	height: number
): string {
	const prevViewportBottom = viewportState.prevViewportTop + height - 1;
	if (moveTargetRow <= prevViewportBottom) return buffer;
	const currentScreenRow = Math.max(
		0,
		Math.min(height - 1, viewportState.hardwareCursorRow - viewportState.prevViewportTop)
	);
	const moveToBottom = height - 1 - currentScreenRow;
	if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
	const scroll = moveTargetRow - prevViewportBottom;
	buffer += "\r\n".repeat(scroll);
	viewportState.prevViewportTop += scroll;
	viewportState.viewportTop += scroll;
	viewportState.hardwareCursorRow = moveTargetRow;
	return buffer;
}

/**
 * Compute the relative line movement needed for cursor positioning.
 *
 * @param viewportState - Mutable viewport state
 * @param targetRow - Target content row
 * @returns Relative line movement
 */
function computeLineDiff(viewportState: ViewportState, targetRow: number): number {
	const currentScreenRow = viewportState.hardwareCursorRow - viewportState.prevViewportTop;
	const targetScreenRow = targetRow - viewportState.viewportTop;
	return targetScreenRow - currentScreenRow;
}

/**
 * Ensure a rendered line never exceeds terminal width.
 *
 * @param tui - Patched TUI instance
 * @param snapshot - Current render snapshot
 * @param line - Rendered line
 * @param lineIndex - Line index in the frame
 * @returns Safe line content
 */
function normalizeRenderedLine(
	tui: TuiPatchedLike,
	snapshot: RenderSnapshot,
	line: string,
	lineIndex: number
): string {
	if (isImageLineLocal(line) || piVisibleWidth(line) <= snapshot.width) {
		return line;
	}
	const crashLogPath = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
	const crashData = [
		`Crash at ${new Date().toISOString()}`,
		`Terminal width: ${snapshot.width}`,
		`Line ${lineIndex} visible width: ${piVisibleWidth(line)}`,
		"",
		"=== All rendered lines ===",
		...snapshot.newLines.map(
			(renderedLine, index) => `[${index}] (w=${piVisibleWidth(renderedLine)}) ${renderedLine}`
		),
		"",
	].join("\n");
	fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
	fs.writeFileSync(crashLogPath, crashData);
	if (process.env.TALLOW_DEBUG || process.env.PI_DEBUG) {
		tui.stop?.();
		throw new Error(
			`Rendered line ${lineIndex} exceeds terminal width (${piVisibleWidth(line)} > ${snapshot.width}).`
		);
	}
	return piTruncateToWidth(line, snapshot.width, "");
}

/**
 * Handle frames where only trailing lines were removed.
 *
 * @param tui - Patched TUI instance
 * @param snapshot - Current render snapshot
 * @param viewportState - Mutable viewport state
 * @param changedWindow - Changed window metadata
 * @param logRedraw - Debug logger
 * @returns True when rendering was handled
 */
function handleTailRemovalOnly(
	tui: TuiPatchedLike,
	snapshot: RenderSnapshot,
	viewportState: ViewportState,
	changedWindow: ChangedWindow,
	logRedraw: (reason: string) => void
): boolean {
	if (changedWindow.firstChanged < snapshot.newLines.length) return false;
	if (tui.previousLines.length <= snapshot.newLines.length) {
		tui.positionHardwareCursor(snapshot.cursorPos, snapshot.newLines.length);
		tui.previousLines = snapshot.newLines;
		tui.previousWidth = snapshot.width;
		tui.previousViewportTop = Math.max(0, tui.maxLinesRendered - snapshot.height);
		return true;
	}
	let buffer = "\x1b[?2026h";
	const targetRow = Math.max(0, snapshot.newLines.length - 1);
	const lineDiff = computeLineDiff(viewportState, targetRow);
	if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
	else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
	buffer += "\r";
	const extraLines = tui.previousLines.length - snapshot.newLines.length;
	if (extraLines > snapshot.height) {
		logRedraw(`extraLines > height (${extraLines} > ${snapshot.height})`);
		if (snapshot.inStartupGrace) {
			writeGentleFullRender(tui, snapshot);
		} else {
			writeFullRender(tui, snapshot, true);
		}
		return true;
	}
	if (extraLines > 0) buffer += "\x1b[1B";
	for (let index = 0; index < extraLines; index += 1) {
		buffer += "\r\x1b[2K";
		if (index < extraLines - 1) buffer += "\x1b[1B";
	}
	if (extraLines > 0) buffer += `\x1b[${extraLines}A`;
	buffer += "\x1b[?2026l";
	tui.terminal.write(buffer);
	tui.cursorRow = targetRow;
	tui.hardwareCursorRow = targetRow;
	tui.positionHardwareCursor(snapshot.cursorPos, snapshot.newLines.length);
	tui.previousLines = snapshot.newLines;
	tui.previousWidth = snapshot.width;
	tui.previousViewportTop = Math.max(0, tui.maxLinesRendered - snapshot.height);
	return true;
}

/**
 * Render the changed diff window into the current viewport.
 *
 * @param tui - Patched TUI instance
 * @param snapshot - Current render snapshot
 * @param viewportState - Mutable viewport state
 * @param changedWindow - Changed window metadata
 * @param logRedraw - Debug logger
 * @returns Nothing
 */
function renderDiffWindow(
	tui: TuiPatchedLike & object,
	snapshot: RenderSnapshot,
	viewportState: ViewportState,
	changedWindow: ChangedWindow,
	logRedraw: (reason: string) => void
): void {
	if (changedWindow.firstChanged < viewportState.prevViewportTop) {
		logRedraw(
			`firstChanged < viewportTop (${changedWindow.firstChanged} < ${viewportState.prevViewportTop})`
		);
		if (snapshot.inStartupGrace) {
			writeGentleFullRender(tui, snapshot);
		} else {
			writeFullRender(tui, snapshot, true);
		}
		return;
	}
	let buffer = "\x1b[?2026h";
	const moveTargetRow = changedWindow.appendStart
		? changedWindow.firstChanged - 1
		: changedWindow.firstChanged;
	buffer = moveBufferToTargetRow(buffer, viewportState, moveTargetRow, snapshot.height);
	const lineDiff = computeLineDiff(viewportState, moveTargetRow);
	if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
	else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
	buffer += changedWindow.appendStart ? "\r\n" : "\r";
	const renderEnd = Math.min(changedWindow.lastChanged, snapshot.newLines.length - 1);
	for (let index = changedWindow.firstChanged; index <= renderEnd; index += 1) {
		if (index > changedWindow.firstChanged) buffer += "\r\n";
		buffer += "\x1b[2K";
		const normalizedLine = normalizeRenderedLine(tui, snapshot, snapshot.newLines[index], index);
		snapshot.newLines[index] = normalizedLine;
		buffer += normalizedLine;
	}
	let finalCursorRow = renderEnd;
	if (tui.previousLines.length > snapshot.newLines.length) {
		const extraLines = tui.previousLines.length - snapshot.newLines.length;
		if (extraLines > snapshot.height) {
			logRedraw(`extraLines > height in diff path (${extraLines} > ${snapshot.height})`);
			writeFullRender(tui, snapshot, true);
			return;
		}
		if (renderEnd < snapshot.newLines.length - 1) {
			const moveDown = snapshot.newLines.length - 1 - renderEnd;
			buffer += `\x1b[${moveDown}B`;
			finalCursorRow = snapshot.newLines.length - 1;
		}
		for (let index = snapshot.newLines.length; index < tui.previousLines.length; index += 1) {
			buffer += "\r\n\x1b[2K";
		}
		buffer += `\x1b[${extraLines}A`;
	}
	buffer += "\x1b[?2026l";
	tui.terminal.write(buffer);
	tui.cursorRow = Math.max(0, snapshot.newLines.length - 1);
	tui.hardwareCursorRow = finalCursorRow;
	tui.maxLinesRendered =
		tui.overlayStack.length === 0
			? snapshot.newLines.length
			: Math.max(tui.maxLinesRendered, snapshot.newLines.length);
	tui.previousViewportTop = Math.max(0, tui.maxLinesRendered - snapshot.height);
	setTuiRollingShrinkPeak(tui, Math.max(getTuiRollingShrinkPeak(tui), snapshot.newLines.length));
	tui.positionHardwareCursor(snapshot.cursorPos, snapshot.newLines.length);
	tui.previousLines = snapshot.newLines;
	tui.previousWidth = snapshot.width;
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
		const snapshot = createRenderSnapshot(this);
		const logRedraw = createRedrawLogger(this, snapshot);
		if (handleEarlyFullRender(this, snapshot, logRedraw)) {
			return;
		}
		const viewportState: ViewportState = {
			hardwareCursorRow: this.hardwareCursorRow,
			prevViewportTop: this.previousViewportTop,
			viewportTop: Math.max(0, this.maxLinesRendered - snapshot.height),
		};
		normalizeViewportBasisDrift(this, snapshot, viewportState);
		const changedWindow = findChangedWindow(this.previousLines, snapshot.newLines);
		if (changedWindow.firstChanged === -1) {
			this.positionHardwareCursor(snapshot.cursorPos, snapshot.newLines.length);
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - snapshot.height);
			return;
		}
		if (handleTailRemovalOnly(this, snapshot, viewportState, changedWindow, logRedraw)) {
			return;
		}
		renderDiffWindow(this, snapshot, viewportState, changedWindow, logRedraw);
	};
}

export async function applyPiTuiPatches(): Promise<void> {
	const mod = (await import("@mariozechner/pi-tui")) as unknown as {
		Editor?: { prototype?: object };
		SettingsList?: { prototype?: object };
		TUI?: { prototype?: TuiPrototypeLike };
	};
	const editorPrototype = mod.Editor?.prototype;
	if (editorPrototype) {
		patchEditorPrototype(editorPrototype as Parameters<typeof patchEditorPrototype>[0]);
	}
	const settingsListPrototype = mod.SettingsList?.prototype;
	if (settingsListPrototype) {
		patchSettingsListPrototype(
			settingsListPrototype as Parameters<typeof patchSettingsListPrototype>[0]
		);
	}
	const tuiPrototype = mod.TUI?.prototype;
	if (tuiPrototype) {
		patchTuiPrototype(tuiPrototype);
	}
}
