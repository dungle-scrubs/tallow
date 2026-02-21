/**
 * Shared configuration for tool output display.
 *
 * Controls how many lines each tool shows during execution and
 * after completion. Truncation position (head/tail) determines
 * whether the first or last N lines are visible.
 *
 * Tools with truncate: false always show full output.
 *
 * This is a shared library — the default export is a noop extension.
 * Other extensions import the named exports.
 */
import type { ExtensionAPI, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

/**
 * Minimal TUI component interface for explicit line-order control.
 *
 * Tool renderResult functions return this instead of Text so that
 * each output line is independently styled and ordered — the summary
 * footer is always the last element in the returned string[].
 */
export interface RenderComponent {
	render(width: number): string[];
	invalidate(): void;
}

/** Semantic roles for presentation hierarchy across tool output surfaces. */
export type PresentationRole =
	| "title"
	| "action"
	| "identity"
	| "meta"
	| "process_output"
	| "status_success"
	| "status_warning"
	| "status_error"
	| "hint";

/** Theme-token mapping for semantic presentation roles. */
const ROLE_THEME_COLORS: Readonly<Record<PresentationRole, ThemeColor>> = {
	action: "accent",
	hint: "dim",
	identity: "accent",
	meta: "muted",
	process_output: "dim",
	status_error: "error",
	status_success: "success",
	status_warning: "warning",
	title: "toolTitle",
};

/**
 * Apply semantic presentation styling to a text fragment.
 *
 * @param theme - Active UI theme
 * @param role - Semantic role for the text fragment
 * @param text - Raw text content
 * @returns Styled text mapped to the role's visual treatment
 */
export function formatPresentationText(theme: Theme, role: PresentationRole, text: string): string {
	const themed = theme.fg(ROLE_THEME_COLORS[role], text);
	if (role === "title" || role === "identity") return theme.bold(themed);
	return themed;
}

/**
 * Format a muted section divider with consistent structure.
 *
 * @param theme - Active UI theme
 * @param label - Section title
 * @returns Styled divider line (e.g. "─── Output ───")
 */
export function formatSectionDivider(theme: Theme, label: string): string {
	return formatPresentationText(theme, "meta", `─── ${label} ───`);
}

/**
 * Push a section of lines with optional blank-line spacing.
 *
 * @param lines - Mutable output line buffer
 * @param section - Lines for this section
 * @param options - Optional spacing controls
 * @returns Nothing
 */
export function appendSection(
	lines: string[],
	section: readonly string[],
	options?: { blankAfter?: boolean; blankBefore?: boolean }
): void {
	if (options?.blankBefore && lines.length > 0 && lines.at(-1) !== "") lines.push("");
	for (const line of section) lines.push(line);
	if (options?.blankAfter) lines.push("");
}

/**
 * Return true when a line already has ANSI escape sequences.
 *
 * @param line - Output line to inspect
 * @returns True when line contains ANSI styling
 */
export function hasAnsiStyling(line: string): boolean {
	return line.includes("\u001b[") || line.includes("\u001b]");
}

/**
 * Dim process-output text without double-styling pre-colored lines.
 *
 * @param line - Output line to style
 * @param dim - Function applying dim styling
 * @returns Safely styled line
 */
export function dimProcessOutputLine(line: string, dim: (value: string) => string): string {
	return hasAnsiStyling(line) ? line : dim(line);
}

/** Deterministic identity palette used across tasks/subagents/teams. */
export const IDENTITY_COLOR_NAMES = ["green", "cyan", "magenta", "yellow", "blue", "red"] as const;

/** Identity color name. */
export type IdentityColorName = (typeof IDENTITY_COLOR_NAMES)[number];

/** ANSI 256-color mapping for identity colors. */
const IDENTITY_ANSI_CODES: Readonly<Record<IdentityColorName, number>> = {
	blue: 75,
	cyan: 80,
	green: 78,
	magenta: 170,
	red: 203,
	yellow: 220,
};

/**
 * Hash a string deterministically for palette selection.
 *
 * @param value - Identity seed
 * @returns Signed hash value
 */
export function hashIdentity(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = Math.imul(31, hash) + value.charCodeAt(i);
	}
	return hash;
}

/**
 * Pick an identity color name deterministically from a seed.
 *
 * @param value - Identity seed
 * @returns Stable identity color name
 */
export function getIdentityColorName(value: string): IdentityColorName {
	const index = Math.abs(hashIdentity(value)) % IDENTITY_COLOR_NAMES.length;
	return IDENTITY_COLOR_NAMES[index] ?? "green";
}

/**
 * Convert an identity color name to its ANSI 256-color code.
 *
 * @param color - Identity color name
 * @returns ANSI color code
 */
export function identityColorToAnsi(color: IdentityColorName): number {
	return IDENTITY_ANSI_CODES[color];
}

/**
 * Resolve a seed directly to an ANSI 256-color identity code.
 *
 * @param value - Identity seed
 * @returns ANSI color code
 */
export function getIdentityAnsiColor(value: string): number {
	return identityColorToAnsi(getIdentityColorName(value));
}

/**
 * Apply deterministic ANSI identity styling to a text fragment.
 *
 * @param text - Text to style
 * @param value - Identity seed
 * @param highlighted - Whether to apply bold emphasis
 * @returns ANSI-styled text
 */
export function formatIdentityText(text: string, value: string, highlighted = false): string {
	const color = getIdentityAnsiColor(value);
	const prefix = highlighted ? `\x1b[1;38;5;${color}m` : `\x1b[38;5;${color}m`;
	const suffix = highlighted ? "\x1b[22;39m" : "\x1b[39m";
	return `${prefix}${text}${suffix}`;
}

/**
 * Select a color code from a numeric ANSI palette deterministically.
 *
 * @param value - Identity seed
 * @param palette - Palette of ANSI color codes
 * @returns Deterministic ANSI color code
 */
export function pickAnsiColor(value: string, palette: readonly number[]): number {
	if (palette.length === 0) return 78;
	return palette[Math.abs(hashIdentity(value)) % palette.length] ?? palette[0] ?? 78;
}

/**
 * Replace tab characters with spaces for consistent terminal rendering.
 *
 * Terminals do not fill tab-stop gaps with the current ANSI background
 * color, so tabs appear as dark rectangular blocks over styled backgrounds.
 * Three spaces matches pi-tui's `visibleWidth()` tab assumption.
 *
 * @param text - String that may contain tab characters
 * @returns String with tabs replaced by three spaces
 */
export function sanitizeTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/** Options for {@link renderLines}. */
export interface RenderLinesOptions {
	/** When true, wrap long lines instead of truncating. Default: false. */
	wrap?: boolean;
}

/**
 * Build a render component from pre-styled lines.
 *
 * By default each line is truncated to the available width at render time.
 * When `wrap` is true, long lines are soft-wrapped (ANSI-aware) instead.
 * Tabs are always replaced with spaces to prevent background rendering artifacts.
 *
 * @param lines - Individually-styled lines in display order (footer last)
 * @param options - Optional rendering behavior overrides
 * @returns A render component that produces width-fitted lines
 */
export function renderLines(lines: string[], options?: RenderLinesOptions): RenderComponent {
	return {
		render(width: number): string[] {
			if (options?.wrap) {
				return lines.flatMap((line) => wrapTextWithAnsi(sanitizeTabs(line), width));
			}
			return lines.map((line) => truncateToWidth(sanitizeTabs(line), width, "…"));
		},
		invalidate() {},
	};
}

/** Per-tool display configuration */
export interface ToolDisplayConfig {
	/** Maximum visible lines (default: 7) */
	maxLines: number;
	/** Maximum characters per visible line before truncation (default: 500) */
	maxLineWidth: number;
	/** Which end to keep: "head" (first N) or "tail" (last N) */
	position: "head" | "tail";
	/** If false, show full output without truncation */
	truncate: boolean;
}

/** Default config applied to any tool not explicitly listed */
const DEFAULT_CONFIG: ToolDisplayConfig = {
	maxLines: 7,
	maxLineWidth: 500,
	position: "head",
	truncate: true,
};

/** Per-tool overrides */
const TOOL_CONFIGS: Record<string, Partial<ToolDisplayConfig>> = {
	read: { maxLines: 7, position: "head" },
	bash: { maxLines: 7, position: "tail" },
	write: { truncate: false },
	edit: { truncate: false },
	grep: { maxLines: 7, position: "head" },
	find: { maxLines: 7, position: "head" },
	ls: { maxLines: 7, position: "head" },
	execute_tool: { maxLines: 7, position: "head" },
	discover_tools: { maxLines: 7, position: "head" },
	get_app_context: { maxLines: 7, position: "head" },
	list_apps: { maxLines: 7, position: "head" },
	execute_code: { maxLines: 7, position: "tail" },
};

/**
 * Get the display config for a given tool.
 * @param toolName - Name of the tool
 * @returns Merged config with defaults
 */
export function getToolDisplayConfig(toolName: string): ToolDisplayConfig {
	const overrides = TOOL_CONFIGS[toolName] ?? {};
	return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Truncate text for display, keeping head or tail lines.
 * @param text - Full text content
 * @param config - Display configuration
 * @returns Object with visible text, whether truncated, and line counts
 */
export function truncateForDisplay(
	text: string,
	config: ToolDisplayConfig
): {
	visible: string;
	truncated: boolean;
	totalLines: number;
	hiddenLines: number;
} {
	if (!config.truncate) {
		return { visible: text, truncated: false, totalLines: text.split("\n").length, hiddenLines: 0 };
	}

	const lines = text.split("\n");
	const totalLines = lines.length;

	// Cap individual line widths to prevent absurdly long lines
	// (e.g. source maps, minified code) from flooding the display
	const capLine = (line: string): string => {
		if (config.maxLineWidth > 0 && line.length > config.maxLineWidth) {
			return `${line.slice(0, config.maxLineWidth)}…`;
		}
		return line;
	};

	if (totalLines <= config.maxLines) {
		const capped = lines.map(capLine);
		const wasCapped = capped.some((l, i) => l !== lines[i]);
		return { visible: capped.join("\n"), truncated: wasCapped, totalLines, hiddenLines: 0 };
	}

	const hiddenLines = totalLines - config.maxLines;

	if (config.position === "tail") {
		const kept = lines.slice(-config.maxLines).map(capLine);
		return { visible: kept.join("\n"), truncated: true, totalLines, hiddenLines };
	}

	// head
	const kept = lines.slice(0, config.maxLines).map(capLine);
	return { visible: kept.join("\n"), truncated: true, totalLines, hiddenLines };
}

/**
 * Format the truncation indicator line.
 * @param config - Display configuration
 * @param totalLines - Total number of lines
 * @param hiddenLines - Number of hidden lines
 * @param theme - Theme for styling
 * @returns Formatted indicator string
 */
export function formatTruncationIndicator(
	config: ToolDisplayConfig,
	totalLines: number,
	hiddenLines: number,
	theme: Theme
): string {
	const direction = config.position === "tail" ? "above" : "more";
	return theme.fg(
		"dim",
		`... (${hiddenLines} ${direction} lines, ${totalLines} total, ctrl+o to expand)`
	);
}

/**
 * Verb tense pair for tool progress rendering.
 * Present continuous shown during execution, past tense on completion.
 */
interface VerbTense {
	/** Present continuous form with ellipsis (e.g., "Reading…") */
	present: string;
	/** Past tense form (e.g., "Read") */
	past: string;
}

/**
 * Mapping of tool names to their display label and verb tense pairs.
 * Custom tools not in this map fall back to title-casing the tool name.
 */
const VERB_TENSES: ReadonlyMap<string, VerbTense> = new Map([
	["read", { present: "Reading…", past: "Read" }],
	["write", { present: "Writing…", past: "Wrote" }],
	["edit", { present: "Editing…", past: "Edited" }],
	["bash", { present: "Running…", past: "Ran" }],
	["ls", { present: "Listing…", past: "Listed" }],
	["grep", { present: "Searching…", past: "Searched" }],
	["find", { present: "Finding…", past: "Found" }],
	["web_search", { present: "Searching…", past: "Searched" }],
	["generate_image", { present: "Generating…", past: "Generated" }],
]);

/**
 * Get the display label for a tool.
 *
 * Returns the raw tool name as-is — no casing transformation.
 * Tool names are snake_case by convention and displayed that way.
 *
 * @param toolName - Tool name (e.g., "bash", "web_search")
 * @returns The tool name unchanged
 */
function getToolLabel(toolName: string): string {
	return toolName;
}

/**
 * Get the appropriate verb form for a tool based on execution state.
 *
 * Returns the tool name followed by a verb: "bash: Running…" during
 * execution, "bash: Ran" on completion. Falls back to the tool name
 * with "…" appended (present) or as-is (past) for unmapped tools.
 *
 * @param toolName - Name of the tool (e.g., "read", "bash")
 * @param isComplete - Whether the tool has finished executing
 * @returns Formatted verb string for display (e.g., "bash: Running…")
 */
export function formatToolVerb(toolName: string, isComplete: boolean): string {
	const label = getToolLabel(toolName);
	const tense = VERB_TENSES.get(toolName);
	if (tense) return `${label}: ${isComplete ? tense.past : tense.present}`;
	return isComplete ? label : `${label}…`;
}

/** Noop — this extension is a shared library, not an active extension */
export default function (_pi: ExtensionAPI) {}
