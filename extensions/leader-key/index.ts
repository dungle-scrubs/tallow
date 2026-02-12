/**
 * Leader Key Extension
 *
 * Ctrl+X activates leader mode: two-char hint labels appear at the
 * bottom-right of every visible tool component. Scroll is frozen so
 * labels render in place without jumping. Type the two chars to open
 * a full-screen pager with that tool's complete output.
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
// Tool component discovery
// ═══════════════════════════════════════════════════════════════════════════

/** Duck-typed expandable tool component. */
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
 * Find all tool components in the TUI tree (most recent first).
 *
 * @param tui - TUI instance to walk
 * @returns Array of tool components
 */
function findTools(tui: TUI): ToolLikeComponent[] {
	return [...walkTree(tui)].filter(isToolLike).reverse() as ToolLikeComponent[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Content extraction
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Label styling
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
 * Build a styled badge showing the full label with typed prefix dimmed.
 * Returns null for non-matching labels.
 *
 * @param label - Full label (e.g., "ab")
 * @param buffer - Characters typed so far
 * @returns Styled badge string or null
 */
function styledBadge(label: string, buffer: string): string | null {
	if (buffer && !label.startsWith(buffer)) return null;
	if (buffer.length === 0) return `\x1b[38;5;201;1m ${label} \x1b[22;39m`;
	const typed = label.slice(0, buffer.length);
	const remaining = label.slice(buffer.length);
	if (!remaining) return null;
	return `\x1b[38;5;240m ${typed}\x1b[38;5;201;1m${remaining} \x1b[22;39m`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ContentViewer — full-screen pager overlay
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full-screen pager with scroll, yazi integration.
 *
 * Keys: esc/q dismiss, ↑↓/jk scroll, PgUp/PgDn page, g/G top/bottom, o yazi
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
	 * @param tui - TUI instance
	 * @param title - Header title
	 * @param content - Full text content
	 * @param filePath - Optional file path for yazi
	 * @param cwd - Working directory
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
	 * @param width - Available width
	 * @returns Rendered pager lines
	 */
	render(width: number): string[] {
		const padWidth = width - 4;
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
		const contentHeight = frameHeight - 2;
		const totalLines = this.wrappedLines.length;
		const maxScroll = Math.max(0, totalLines - contentHeight);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

		const innerWidth = width - 2;
		const result: string[] = [];

		const titleText = ` ${this.title} `;
		const titleVis = visibleWidth(titleText);
		const topFill = Math.max(0, innerWidth - titleVis - 1);
		result.push(`${M}╭─${B}${titleText}${R}${M}${"─".repeat(topFill)}╮${R}`);

		const visible = this.wrappedLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		for (let i = 0; i < contentHeight; i++) {
			const line = visible[i] ?? "";
			const vw = visibleWidth(line);
			const pad = Math.max(0, padWidth - vw);
			result.push(`${M}│${R} ${line}${" ".repeat(pad)} ${M}│${R}`);
		}

		const hints: string[] = [`${D}esc/q close · ↑↓/jk scroll${R}`];
		if (this.filePath) hints.push(`${D}o yazi${R}`);
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
 * Stop TUI, spawn yazi, restart.
 *
 * @param tui - TUI instance
 * @param filePath - Path to open
 */
function openInYazi(tui: TUI, filePath: string): void {
	tui.stop();
	try {
		spawnSync("yazi", [filePath], { stdio: "inherit" });
	} catch {
		// yazi not installed — silently ignore
	}
	tui.start();
	tui.requestRender(true);
}

// ═══════════════════════════════════════════════════════════════════════════
// Editor with LEADER indicator
// ═══════════════════════════════════════════════════════════════════════════

const LEADER_LABEL = " ⌨ LEADER ";

/** Editor that shows LEADER in its top border when active. */
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
	let hints: { tool: ToolLikeComponent; label: string }[] = [];
	let cwd = process.cwd();

	/**
	 * Open a pager showing the full content of a tool component.
	 *
	 * @param tool - Tool component to show
	 */
	function openPager(tool: ToolLikeComponent): void {
		if (!tuiRef) return;
		const title = extractTitle(tool);
		const content = extractContent(tool);
		const filePath = typeof tool.args?.path === "string" ? (tool.args.path as string) : undefined;
		const viewer = new ContentViewer(tuiRef, title, content, filePath, cwd);
		const handle = tuiRef.showOverlay(viewer, {
			width: "100%",
			maxHeight: "100%",
			margin: { top: 1, bottom: 1, left: 2, right: 2 },
		});
		viewer.onDismiss = () => handle.hide();
	}

	/** Find tools, assign badges, freeze scroll. */
	function activate(): void {
		if (!tuiRef || !layer) return;

		const tools = findTools(tuiRef);
		if (tools.length === 0) {
			layer.deactivate();
			return;
		}

		const labels = generateHintLabels(tools.length);
		hints = tools.map((tool, i) => ({ tool, label: labels[i] }));

		// Set badges on all tool contentBoxes
		for (const { tool, label } of hints) {
			tool.contentBox.badge = styledBadge(label, "");
			layer.registerSequence(label, () => openPager(tool));
		}

		// Freeze scroll so badge render doesn't jump
		tuiRef.setScrollFrozen(true);
		tuiRef.requestRender();
	}

	/** Clear badges, unfreeze scroll. */
	function deactivate(): void {
		for (const { tool } of hints) {
			tool.contentBox.badge = null;
		}
		hints = [];
		layer?.clearSequences();
		if (tuiRef) {
			tuiRef.setScrollFrozen(false);
			tuiRef.requestRender();
		}
	}

	/**
	 * Update badges: matching labels show next char, others hide.
	 *
	 * @param buffer - Characters typed so far
	 */
	function narrowLabels(buffer: string): void {
		for (const { tool, label } of hints) {
			tool.contentBox.badge = styledBadge(label, buffer);
		}
		tuiRef?.requestRender();
	}

	/** Update status bar indicator. */
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
				activate();
			},
			onDeactivate: () => {
				if (editor) editor.leaderActive = false;
				setStatus(ctx, false);
				deactivate();
			},
			onBufferChange: narrowLabels,
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
		deactivate();
		layer?.detach();
		layer = null;
		editor = null;
		tuiRef = null;
	});
}
