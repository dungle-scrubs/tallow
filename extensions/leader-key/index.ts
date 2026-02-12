/**
 * Leader Key Extension
 *
 * Ctrl+X activates Vimium-style hint labels. A floating panel lists all
 * hintable elements (tool outputs). Type the label characters to act on
 * that element — opening a full-screen pager with the complete content.
 *
 * The screen is "frozen" while the panel is visible: the overlay covers
 * normal interaction, and the LeaderKeyLayer middleware intercepts all
 * keystrokes until the user selects a hint or cancels.
 *
 * Supported hintable types:
 * - Tool outputs (bash, etc.) → full-screen pager showing complete content
 * - File tools (read/write/edit) → pager with option to open in yazi
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	type Component,
	type Focusable,
	generateHintLabels,
	Key,
	LeaderKeyLayer,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

// ═══════════════════════════════════════════════════════════════════════════
// Hintable abstraction — generic target for leader key actions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Action to perform when a hint is selected.
 * Extend this union to support new element types.
 */
type HintAction =
	| { kind: "pager"; title: string; content: string; filePath?: string }
	| { kind: "open"; filePath: string };

/**
 * An interactive element that can be labeled and acted upon.
 */
interface Hintable {
	title: string;
	action: HintAction;
}

// ═══════════════════════════════════════════════════════════════════════════
// Hint finders — discover hintable elements in the TUI tree
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Shape of an expandable tool component (duck-typed).
 * Matches ToolExecutionComponent, BashExecutionComponent, etc.
 */
interface ToolLikeComponent extends Component {
	setExpanded(expanded: boolean): void;
	contentBox: { badge: string | null };
	expanded: boolean;
	toolName?: string;
	args?: Record<string, unknown>;
	result?: {
		content?: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	};
}

/**
 * Recursively yield all objects in the TUI component tree.
 *
 * @param node - Root node to walk
 * @yields Each node in depth-first order
 */
function* walkTree(node: unknown): Generator<unknown> {
	if (!node || typeof node !== "object") return;
	yield node;
	const children = (node as Record<string, unknown>).children;
	if (Array.isArray(children)) {
		for (const child of children) {
			yield* walkTree(child);
		}
	}
}

/**
 * Check if a component looks like a tool execution component.
 *
 * @param c - Component to check
 * @returns true if it has setExpanded + contentBox + result
 */
function isToolLike(c: unknown): c is ToolLikeComponent {
	if (!c || typeof c !== "object") return false;
	const obj = c as Record<string, unknown>;
	return (
		typeof obj.setExpanded === "function" &&
		obj.contentBox != null &&
		typeof obj.contentBox === "object" &&
		obj.result != null
	);
}

/**
 * Extract text content from a tool component's result.
 * For bash tools with truncated output, reads the full output file.
 *
 * @param comp - Tool component
 * @returns Text content string
 */
function extractContent(comp: ToolLikeComponent): string {
	const fullPath = comp.result?.details?.fullOutputPath;
	if (typeof fullPath === "string") {
		try {
			return fs.readFileSync(fullPath, "utf-8");
		} catch {
			// Fall through to result content
		}
	}

	if (!comp.result?.content) return "(no output)";
	const text = comp.result.content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text ?? "")
		.join("\n");
	return text || "(no output)";
}

/**
 * Build a display title for a tool component.
 *
 * @param comp - Tool component
 * @returns Human-readable title
 */
function extractTitle(comp: ToolLikeComponent): string {
	const name = comp.toolName ?? "tool";
	const args = comp.args ?? {};
	if (name === "bash" && typeof args.command === "string") return `$ ${args.command}`;
	if (typeof args.path === "string") return `${name} ${args.path}`;
	return name;
}

/**
 * Find all hintable tool components in the TUI tree.
 * Returns them in reverse document order (most recent first).
 *
 * @param tui - TUI instance to walk
 * @returns Array of hintables
 */
function findToolHintables(tui: TUI): Hintable[] {
	const tools = [...walkTree(tui)].filter(isToolLike).reverse();
	return tools.map((comp) => {
		const title = extractTitle(comp);
		const content = extractContent(comp);
		const filePath = typeof comp.args?.path === "string" ? (comp.args.path as string) : undefined;
		return {
			title,
			action: { kind: "pager" as const, title, content, filePath },
		};
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// HintListOverlay — floating panel listing hintable elements
// ═══════════════════════════════════════════════════════════════════════════

/** Magenta ANSI foreground */
const M = "\x1b[38;5;201m";
/** Bold */
const B = "\x1b[1m";
/** Dim */
const D = "\x1b[2m";
/** Reset all */
const R = "\x1b[0m";

/**
 * Build a styled label showing the full hint with typed prefix dimmed.
 * Returns null for labels that don't match the current buffer.
 *
 * @param label - Full hint label (e.g., "ab")
 * @param buffer - Characters typed so far (e.g., "a")
 * @returns Styled label string, or null if label doesn't match buffer
 */
function styledLabel(label: string, buffer: string): string | null {
	if (buffer && !label.startsWith(buffer)) return null;
	if (buffer.length === 0) return `${M}${B}${label}${R}`;
	const typed = label.slice(0, buffer.length);
	const remaining = label.slice(buffer.length);
	if (!remaining) return null; // fully matched — handler should have fired
	return `${D}${typed}${M}${B}${remaining}${R}`;
}

/**
 * Floating panel that displays hintable elements with their labels.
 * Display-only — input is handled by the LeaderKeyLayer middleware.
 */
class HintListOverlay implements Component {
	private items: { label: string; title: string }[];
	private tui: TUI;

	/** Current typed buffer — updated by the extension on each keystroke. */
	buffer = "";

	/**
	 * @param tui - TUI instance for terminal dimensions
	 * @param items - Hintable items with labels and display titles
	 */
	constructor(tui: TUI, items: { label: string; title: string }[]) {
		this.tui = tui;
		this.items = items;
	}

	invalidate(): void {
		// No cached state to invalidate
	}

	/**
	 * Render the hint list as a bordered panel.
	 *
	 * @param width - Available width from overlay layout
	 * @returns Rendered lines
	 */
	render(width: number): string[] {
		const innerWidth = width - 2; // border chars
		const padWidth = innerWidth - 2; // inner padding
		if (padWidth < 4) return [];

		const result: string[] = [];

		// ── Top border ──
		const headerText = " ⌨ LEADER ";
		const headerVis = visibleWidth(headerText);
		const headerFill = Math.max(0, innerWidth - headerVis - 1);
		result.push(`${M}╭─${B}${headerText}${R}${M}${"─".repeat(headerFill)}╮${R}`);

		// ── Empty line for spacing ──
		result.push(`${M}│${R}${" ".repeat(innerWidth)}${M}│${R}`);

		// ── Items ──
		const maxItems = this.tui.terminal.rows - 6; // leave room for borders/footer
		let visibleCount = 0;

		for (const { label, title } of this.items) {
			if (visibleCount >= maxItems) break;
			const badge = styledLabel(label, this.buffer);
			if (badge == null) continue;
			visibleCount++;

			const labelColWidth = Math.max(...this.items.map((i) => i.label.length)) + 1;
			const labelPad = " ".repeat(Math.max(0, labelColWidth - label.length));
			const itemText = ` ${badge}${labelPad} ${title}`;
			const itemVis = visibleWidth(itemText);
			const truncated = itemVis > padWidth ? truncateToWidth(itemText, padWidth, "…") : itemText;
			const truncVis = visibleWidth(truncated);
			const truncPad = Math.max(0, padWidth - truncVis);
			result.push(`${M}│${R} ${truncated}${" ".repeat(truncPad)} ${M}│${R}`);
		}

		if (visibleCount === 0) {
			const msg = "No matching hints";
			const pad = Math.max(0, padWidth - msg.length);
			result.push(`${M}│${R} ${msg}${" ".repeat(pad)} ${M}│${R}`);
		}

		// ── Empty line for spacing ──
		result.push(`${M}│${R}${" ".repeat(innerWidth)}${M}│${R}`);

		// ── Bottom border with hints ──
		const footer = `${D}type label · esc cancel${R}`;
		const footerVis = visibleWidth(footer);
		const footerFill = Math.max(0, innerWidth - footerVis - 2);
		result.push(`${M}╰${"─".repeat(footerFill)} ${footer} ${M}╯${R}`);

		return result;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// ContentViewer — full-screen pager overlay
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full-screen pager component with rounded border, scrolling,
 * and optional "open in yazi" support.
 *
 * Keybindings:
 * - Escape / q → dismiss
 * - ↑ / k → scroll up
 * - ↓ / j → scroll down
 * - PgUp / PgDn → page scroll
 * - g / G → top / bottom
 * - o → open in yazi (when filePath is set)
 */
class ContentViewer implements Component, Focusable {
	focused = false;

	private tui: TUI;
	private title: string;
	private rawLines: string[];
	private filePath?: string;
	private cwd: string;

	private wrappedLines: string[] = [];
	private lastWrapWidth = 0;
	private scrollOffset = 0;

	onDismiss?: () => void;

	/**
	 * @param tui - TUI instance for terminal dimensions and render requests
	 * @param title - Header title
	 * @param content - Full text content to display
	 * @param filePath - Optional file path for "open in yazi" support
	 * @param cwd - Working directory for resolving relative paths
	 */
	constructor(tui: TUI, title: string, content: string, filePath?: string, cwd?: string) {
		this.tui = tui;
		this.title = title;
		this.rawLines = content.split("\n");
		this.filePath = filePath;
		this.cwd = cwd ?? process.cwd();
	}

	invalidate(): void {
		this.lastWrapWidth = 0;
	}

	/**
	 * Render the pager as a bordered frame filling the overlay area.
	 *
	 * @param width - Available width from overlay
	 * @returns Rendered lines
	 */
	render(width: number): string[] {
		const padWidth = width - 4; // 2 border + 2 inner padding
		if (padWidth < 1) return [];

		if (this.lastWrapWidth !== padWidth) {
			this.wrappedLines = [];
			for (const line of this.rawLines) {
				if (visibleWidth(line) <= padWidth) {
					this.wrappedLines.push(line);
				} else {
					this.wrappedLines.push(...wrapTextWithAnsi(line, padWidth));
				}
			}
			this.lastWrapWidth = padWidth;
		}

		const termHeight = this.tui.terminal.rows;
		const frameHeight = Math.max(5, termHeight - 2);
		const contentHeight = frameHeight - 2; // top + bottom border
		const totalLines = this.wrappedLines.length;
		const maxScroll = Math.max(0, totalLines - contentHeight);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

		const innerWidth = width - 2;
		const result: string[] = [];

		// ── Top border with title ──
		const titleText = ` ${this.title} `;
		const titleVis = visibleWidth(titleText);
		const topFill = Math.max(0, innerWidth - titleVis - 1);
		result.push(`${M}╭─${B}${titleText}${R}${M}${"─".repeat(topFill)}╮${R}`);

		// ── Content lines ──
		const visible = this.wrappedLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		for (let i = 0; i < contentHeight; i++) {
			const line = visible[i] ?? "";
			const vw = visibleWidth(line);
			const pad = Math.max(0, padWidth - vw);
			result.push(`${M}│${R} ${line}${" ".repeat(pad)} ${M}│${R}`);
		}

		// ── Bottom border with hints + scroll position ──
		const hints: string[] = [`${D}esc/q close · ↑↓/jk scroll${R}`];
		if (this.filePath) hints.push(`${D}o open in yazi${R}`);
		const scrollInfo =
			totalLines > contentHeight
				? `${M}${this.scrollOffset + 1}-${Math.min(this.scrollOffset + contentHeight, totalLines)}/${totalLines}${R}`
				: "";
		const hintStr = ` ${hints.join(" · ")} ${scrollInfo} `;
		const hintVis = visibleWidth(hintStr);
		const botFill = Math.max(0, innerWidth - hintVis - 1);
		result.push(`${M}╰${"─".repeat(botFill)}${hintStr}${M}╯${R}`);

		return result;
	}

	/**
	 * Handle keyboard input for scrolling and dismissal.
	 *
	 * @param data - Raw terminal input
	 */
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.onDismiss?.();
			return;
		}

		if (matchesKey(data, "o") && this.filePath) {
			const resolved = path.isAbsolute(this.filePath)
				? this.filePath
				: path.resolve(this.cwd, this.filePath);
			this.onDismiss?.();
			openInYazi(this.tui, resolved);
			return;
		}

		const contentHeight = Math.max(1, this.tui.terminal.rows - 4);
		const maxScroll = Math.max(0, this.wrappedLines.length - contentHeight);

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - contentHeight);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + contentHeight);
		} else if (matchesKey(data, "g")) {
			this.scrollOffset = 0;
		} else if (matchesKey(data, "shift+g")) {
			this.scrollOffset = maxScroll;
		}

		this.tui.requestRender();
	}
}

/**
 * Stop the TUI, spawn yazi at the given path, then restart.
 *
 * @param tui - TUI instance to suspend/resume
 * @param filePath - File or directory path to open
 */
function openInYazi(tui: TUI, filePath: string): void {
	tui.stop();
	try {
		spawnSync("yazi", [filePath], { stdio: "inherit" });
	} catch {
		// yazi not installed or failed — silently ignore
	}
	tui.start();
	tui.requestRender(true);
}

// ═══════════════════════════════════════════════════════════════════════════
// Editor border label
// ═══════════════════════════════════════════════════════════════════════════

const LEADER_LABEL = " ⌨ LEADER ";

/**
 * Editor that shows a LEADER label in its top border when active.
 */
class LeaderModeEditor extends CustomEditor {
	public leaderActive = false;

	/**
	 * @param width - Available render width
	 * @returns Rendered lines with optional LEADER label
	 */
	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.leaderActive || lines.length === 0) return lines;

		const first = lines[0];
		const labelVis = visibleWidth(LEADER_LABEL);
		const lineVis = visibleWidth(first);
		if (lineVis >= labelVis + 4) {
			const colored = `\x1b[38;5;201;1m${LEADER_LABEL}\x1b[22;39m`;
			lines[0] = truncateToWidth(first, width - labelVis, "") + colored;
		}
		return lines;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════

/** Bright magenta border for leader mode */
const ACTIVE_BORDER_COLOR = (s: string): string => `\x1b[38;5;201m${s}\x1b[39m`;

/**
 * Registers the leader key extension.
 *
 * @param pi - Extension API
 */
export default function leaderKeyExtension(pi: ExtensionAPI): void {
	let layer: LeaderKeyLayer | null = null;
	let editor: LeaderModeEditor | null = null;
	let tuiRef: TUI | null = null;
	let overlayHandle: { hide: () => void } | null = null;
	let hintOverlay: HintListOverlay | null = null;
	let hints: { label: string; action: HintAction }[] = [];
	let cwd = process.cwd();

	/**
	 * Execute a hint action (pager, open, etc.).
	 *
	 * @param action - The action to perform
	 */
	function executeAction(action: HintAction): void {
		if (!tuiRef) return;
		switch (action.kind) {
			case "pager": {
				const viewer = new ContentViewer(
					tuiRef,
					action.title,
					action.content,
					action.filePath,
					cwd
				);
				const handle = tuiRef.showOverlay(viewer, {
					width: "100%",
					maxHeight: "100%",
					margin: { top: 1, bottom: 1, left: 2, right: 2 },
				});
				viewer.onDismiss = () => handle.hide();
				break;
			}
			case "open":
				openInYazi(tuiRef, action.filePath);
				break;
		}
	}

	/**
	 * Show the hint overlay listing all discoverable tools.
	 */
	function showHints(): void {
		if (!tuiRef || !layer) return;

		const hintables = findToolHintables(tuiRef);
		if (hintables.length === 0) {
			layer.deactivate();
			return;
		}

		const labels = generateHintLabels(hintables.length);
		hints = hintables.map((h, i) => ({ label: labels[i], action: h.action }));

		// Register sequences with the leader layer
		for (const { label, action } of hints) {
			layer.registerSequence(label, () => executeAction(action));
		}

		// Create and show the overlay panel
		const items = hintables.map((h, i) => ({ label: labels[i], title: h.title }));
		hintOverlay = new HintListOverlay(tuiRef, items);
		overlayHandle = tuiRef.showOverlay(hintOverlay, {
			width: "80%",
			margin: { top: 2, bottom: 2 },
		});

		tuiRef.requestRender();
	}

	/** Hide the hint overlay and clean up. */
	function hideHints(): void {
		overlayHandle?.hide();
		overlayHandle = null;
		hintOverlay = null;
		hints = [];
		layer?.clearSequences();
	}

	/**
	 * Update the overlay to reflect the current typed buffer.
	 *
	 * @param buffer - Characters typed so far
	 */
	function narrowHints(buffer: string): void {
		if (hintOverlay) {
			hintOverlay.buffer = buffer;
			tuiRef?.requestRender();
		}
	}

	/** Update footer status indicator. */
	function setStatus(ctx: ExtensionContext, active: boolean): void {
		ctx.ui.setStatus("leader-key", active ? "\x1b[38;5;201m⌨ LEADER\x1b[39m" : undefined);
	}

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;

		layer = new LeaderKeyLayer({
			leaderKey: Key.ctrl("x"),
			timeout: 5000,
			activeBorderColor: ACTIVE_BORDER_COLOR,
			onActivate: () => {
				if (editor) editor.leaderActive = true;
				setStatus(ctx, true);
				showHints();
			},
			onDeactivate: () => {
				if (editor) editor.leaderActive = false;
				setStatus(ctx, false);
				hideHints();
			},
			onBufferChange: narrowHints,
		});

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			tuiRef = tui;
			const ed = new LeaderModeEditor(tui, theme, keybindings);
			editor = ed;
			layer?.attach(tui, ed);
			return ed;
		});
	});

	pi.on("session_shutdown", async () => {
		hideHints();
		layer?.detach();
		layer = null;
		editor = null;
		tuiRef = null;
	});
}
