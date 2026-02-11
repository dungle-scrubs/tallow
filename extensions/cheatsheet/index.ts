/**
 * Cheatsheet Extension - Displays keyboard shortcuts inline in conversation
 *
 * Usage: /cheatsheet, /keys, /keymap, /keybindings, or Ctrl+?
 * Responsive 1/2/3 column layout based on terminal width.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, visibleWidth } from "@mariozechner/pi-tui";

/** A single keyboard shortcut entry. */
interface Shortcut {
	key: string;
	description: string;
}

/** A named group of related shortcuts. */
interface Section {
	title: string;
	shortcuts: Shortcut[];
}

// ── Shortcut sections ────────────────────────────────────────────────

const SECTIONS: Section[] = [
	{
		title: "Global",
		shortcuts: [
			{ key: "Escape", description: "Interrupt / abort" },
			{ key: "Ctrl+C", description: "Clear input" },
			{ key: "Ctrl+D", description: "Exit pi" },
			{ key: "Ctrl+Z", description: "Suspend" },
		],
	},
	{
		title: "Input",
		shortcuts: [
			{ key: "Enter", description: "Submit" },
			{ key: "Shift+Enter", description: "Newline" },
			{ key: "↑ / ↓", description: "History" },
			{ key: "Tab", description: "Autocomplete" },
			{ key: "Ctrl+U", description: "Clear to start" },
			{ key: "Ctrl+K", description: "Clear to end" },
			{ key: "Ctrl+W", description: "Delete word back" },
			{ key: "Ctrl+Y", description: "Yank (paste)" },
			{ key: "Ctrl+-", description: "Undo" },
		],
	},
	{
		title: "Model",
		shortcuts: [
			{ key: "Ctrl+P", description: "Next model" },
			{ key: "Ctrl+Shift+P", description: "Previous model" },
			{ key: "Ctrl+L", description: "Select model" },
			{ key: "Shift+Tab", description: "Cycle thinking" },
			{ key: "Ctrl+T", description: "Toggle thinking" },
		],
	},
	{
		title: "Session",
		shortcuts: [
			{ key: "Ctrl+G", description: "External editor" },
			{ key: "Ctrl+O", description: "Expand tool output" },
			{ key: "Ctrl+N", description: "Filter named" },
			{ key: "Alt+Enter", description: "Follow-up" },
			{ key: "Alt+↑", description: "Dequeue message" },
			{ key: "Ctrl+V", description: "Paste image" },
		],
	},
	{
		title: "Shortcuts",
		shortcuts: [
			{ key: "Ctrl+Shift+B", description: "Background tasks" },
			{ key: "Ctrl+Shift+T", description: "Toggle tasks" },
			{ key: "Ctrl+?", description: "This cheatsheet" },
		],
	},
	{
		title: "Viewers",
		shortcuts: [
			{ key: "Esc / q", description: "Close" },
			{ key: "↑ ↓", description: "Scroll" },
			{ key: "g / G", description: "Top / bottom" },
			{ key: "Enter", description: "Select" },
		],
	},
];

// ── Layout constants ─────────────────────────────────────────────────

const THREE_COL_MIN = 105;
const TWO_COL_MIN = 68;

/**
 * Pad a string to a target visible width.
 * @param str - String to pad (may contain ANSI escape codes)
 * @param len - Target visible width
 * @returns Padded string
 */
function pad(str: string, len: number): string {
	return str + " ".repeat(Math.max(0, len - visibleWidth(str)));
}

/** Renderable row: either a section header or a key+description pair. */
type Row =
	| { kind: "header"; title: string }
	| { kind: "entry"; key: string; desc: string }
	| { kind: "spacer" };

/**
 * Flatten sections into a linear list of rows for column layout.
 * @param sections - Shortcut sections to flatten
 * @returns Array of renderable rows
 */
function flattenSections(sections: Section[]): Row[] {
	const rows: Row[] = [];
	for (const s of sections) {
		rows.push({ kind: "header", title: s.title });
		for (const sc of s.shortcuts) {
			rows.push({ kind: "entry", key: sc.key, desc: sc.description });
		}
		rows.push({ kind: "spacer" });
	}
	// Remove trailing spacer
	if (rows.length > 0 && rows[rows.length - 1].kind === "spacer") rows.pop();
	return rows;
}

/**
 * Split rows into N roughly-equal columns, breaking at spacers when possible.
 * @param rows - Flat row list
 * @param cols - Number of columns
 * @returns Array of columns, each an array of rows
 */
function splitColumns(rows: Row[], cols: number): Row[][] {
	if (cols <= 1) return [rows];

	const targetSize = Math.ceil(rows.length / cols);
	const columns: Row[][] = [];
	let start = 0;

	for (let c = 0; c < cols; c++) {
		if (c === cols - 1) {
			columns.push(rows.slice(start));
			break;
		}
		// Find best break point near target
		const end = Math.min(start + targetSize, rows.length);
		// Try to break at a spacer within ±3 rows of target
		let bestBreak = end;
		for (let i = Math.max(start, end - 3); i <= Math.min(rows.length - 1, end + 3); i++) {
			if (rows[i]?.kind === "spacer") {
				bestBreak = i + 1; // break after the spacer
				break;
			}
		}
		columns.push(rows.slice(start, bestBreak));
		start = bestBreak;
	}

	return columns;
}

/**
 * Render a single row to a styled string.
 * @param row - Row to render
 * @param theme - Theme for styling
 * @param keyWidth - Column width for the key portion
 * @returns Styled string
 */
function renderRow(row: Row, theme: Theme, keyWidth: number): string {
	switch (row.kind) {
		case "header":
			return theme.fg("muted", row.title);
		case "entry":
			return `  ${theme.fg("success", pad(row.key, keyWidth))}${row.desc}`;
		case "spacer":
			return "";
	}
}

/**
 * Build the full cheatsheet string with responsive column layout.
 * @param theme - Theme for styling
 * @param width - Available terminal width
 * @returns Formatted cheatsheet string
 */
function buildCheatsheet(theme: Theme, width: number): string {
	const lines: string[] = [];
	const rows = flattenSections(SECTIONS);

	lines.push("");
	lines.push(theme.fg("accent", "⌨ Keyboard Shortcuts"));
	lines.push("");

	const numCols = width >= THREE_COL_MIN ? 3 : width >= TWO_COL_MIN ? 2 : 1;

	if (numCols === 1) {
		const keyWidth = 18;
		for (const row of rows) {
			lines.push(renderRow(row, theme, keyWidth));
		}
	} else {
		const columns = splitColumns(rows, numCols);
		const gutterWidth = 3; // " │ "
		const colWidth = Math.floor((width - gutterWidth * (numCols - 1)) / numCols);
		const keyWidth = 18;
		const maxRows = Math.max(...columns.map((c) => c.length));
		const sep = ` ${theme.fg("muted", "│")} `;

		for (let i = 0; i < maxRows; i++) {
			const parts: string[] = [];
			for (let c = 0; c < numCols; c++) {
				const row = columns[c]?.[i];
				const rendered = row ? renderRow(row, theme, keyWidth) : "";
				parts.push(c < numCols - 1 ? pad(rendered, colWidth) : rendered);
			}
			lines.push(parts.join(sep));
		}
	}

	lines.push("");
	return lines.join("\n");
}

/**
 * Register cheatsheet commands and shortcuts.
 * @param pi - Extension API
 */
export default function cheatsheetExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<{ width: number }>(
		"keyboard-cheatsheet",
		(_message, _options, theme) => ({
			render(width: number): string[] {
				return buildCheatsheet(theme, width).split("\n");
			},
			invalidate() {},
		})
	);

	const show = () => {
		pi.sendMessage({
			customType: "keyboard-cheatsheet",
			content: "Keyboard shortcuts reference",
			display: true,
			details: { width: process.stdout.columns || 100 },
		});
	};

	const handler = async (_args: string, _ctx: ExtensionContext) => show();

	pi.registerCommand("cheatsheet", { description: "Show keyboard shortcuts", handler });
	pi.registerCommand("keys", { description: "Show keyboard shortcuts", handler });
	pi.registerCommand("keymap", { description: "Show keyboard shortcuts", handler });
	pi.registerCommand("keybindings", { description: "Show keyboard shortcuts", handler });

	pi.registerShortcut(Key.ctrl("?"), {
		description: "Show keyboard shortcuts",
		handler: async () => show(),
	});
}
