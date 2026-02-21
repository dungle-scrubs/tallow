import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import {
	BorderedBox,
	type EditorTheme,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { getIcon, getSpinner } from "../_icons/index.js";
import {
	formatIdentityText,
	formatPresentationText,
	getIdentityAnsiColor,
	type PresentationRole,
} from "../tool-display/index.js";

/** Minimum width for the left tree pane. */
export const DASHBOARD_LEFT_MIN_WIDTH = 24;
/** Proportional width for the left pane when enough space exists. */
export const DASHBOARD_LEFT_RATIO = 0.25;
/** Separator width between panes. */
export const DASHBOARD_SEPARATOR_WIDTH = 1;
/** Gap between cards in two-column mode. */
export const DASHBOARD_CARD_GAP = 2;
/** Minimum width required for each card in two-column mode. */
export const DASHBOARD_CARD_MIN_WIDTH = 42;
/** Maximum rolling output buffer per teammate. */
export const DASHBOARD_MAX_OUTPUT_CHARS = 2400;
/** Number of live output lines shown in each card preview. */
export const DASHBOARD_OUTPUT_PREVIEW_LINES = 5;
/** Palette used for deterministic per-team colors in the left tree. */
const DASHBOARD_TEAM_COLORS = [110, 109, 108, 103, 144, 138, 66, 72] as const;
/** Fallback spinner frames for working-agent indicators. */
const DASHBOARD_FALLBACK_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** Mouse wheel line delta for dashboard card scrolling. */
export const DASHBOARD_MOUSE_SCROLL_LINES = 3;

/** Split geometry for the dashboard workspace. */
export interface DashboardSplit {
	readonly leftWidth: number;
	readonly rightWidth: number;
	readonly separatorWidth: number;
}

/** Action requested by `/team-dashboard`. */
export type DashboardCommandAction = "toggle" | "on" | "off" | "status" | "invalid";

/** Parsed command behavior for dashboard toggling. */
export interface DashboardCommandResolution {
	readonly action: DashboardCommandAction;
	readonly changed: boolean;
	readonly isError: boolean;
	readonly message: string;
	readonly nextEnabled: boolean;
}

/** Teammate state rendered inside a dashboard card. */
export interface TeamDashboardTeammate {
	readonly completedTaskCount: number;
	readonly currentTask: string | null;
	readonly lastTool: string | null;
	readonly liveInputTokens: number;
	readonly liveOutputTokens: number;
	readonly model: string;
	readonly name: string;
	readonly output: string;
	readonly role: string;
	readonly status: "idle" | "working" | "shutdown" | "error";
	readonly totalInputTokens: number;
	readonly totalOutputTokens: number;
	readonly unreadInboxCount: number;
	readonly updatedAt?: number;
}

/** Compact feed event shown in the sidebar feed section. */
export interface TeamDashboardFeedItem {
	readonly content: string;
	readonly from: string;
	readonly timestamp: number;
	readonly to: string;
}

/** Team payload rendered in the dashboard. */
export interface TeamDashboardTeam {
	readonly feed: readonly TeamDashboardFeedItem[];
	readonly isComplete: boolean;
	readonly name: string;
	readonly recentMessageLinks: readonly string[];
	readonly teammates: readonly TeamDashboardTeammate[];
}

/** Snapshot consumed by the dashboard editor renderer. */
export interface TeamDashboardSnapshot {
	readonly teams: readonly TeamDashboardTeam[];
}

/** Options for constructing the dashboard editor component. */
export interface TeamDashboardEditorOptions {
	readonly getSnapshot: () => TeamDashboardSnapshot;
	readonly onEscape?: () => void;
	readonly onExit: () => void;
	readonly theme: Theme;
}

/** Per-teammate activity for tool + output previews. */
export interface DashboardActivityEntry {
	readonly lastTool: string | null;
	readonly liveInputTokens: number;
	readonly liveOutputTokens: number;
	readonly output: string;
	readonly totalInputTokens: number;
	readonly totalOutputTokens: number;
	readonly updatedAt?: number;
}

/** Tree node rendered in the left pane. */
interface DashboardTreeNode {
	readonly kind: "team" | "teammate";
	readonly teamIndex: number;
	readonly teammateIndex?: number;
}

/** Parsed SGR mouse wheel direction from terminal input. */
export type DashboardMouseWheelDirection = "up" | "down";

/** Display-only teammate status including derived "finished" state. */
type TeamDashboardDisplayStatus = TeamDashboardTeammate["status"] | "finished";

/**
 * Compute the left/right pane split for the dashboard workspace.
 * @param width - Total available width
 * @returns Split widths for both panes and separator
 */
export function calculateDashboardSplit(width: number): DashboardSplit {
	const safeWidth = Math.max(0, Math.floor(width));
	const desiredLeft = Math.max(
		DASHBOARD_LEFT_MIN_WIDTH,
		Math.floor(safeWidth * DASHBOARD_LEFT_RATIO)
	);
	const maxLeft = Math.max(0, safeWidth - DASHBOARD_SEPARATOR_WIDTH);
	const leftWidth = Math.min(desiredLeft, maxLeft);
	const rightWidth = Math.max(0, safeWidth - leftWidth - DASHBOARD_SEPARATOR_WIDTH);
	return { leftWidth, rightWidth, separatorWidth: DASHBOARD_SEPARATOR_WIDTH };
}

/**
 * Resolve the teammate card grid columns for the right pane.
 * @param rightPaneWidth - Width available for the card area
 * @returns 2 when both columns fit, otherwise 1
 */
export function calculateDashboardGridColumns(rightPaneWidth: number): 1 | 2 {
	const minTwoColWidth = DASHBOARD_CARD_MIN_WIDTH * 2 + DASHBOARD_CARD_GAP;
	return rightPaneWidth >= minTwoColWidth ? 2 : 1;
}

/**
 * Clamp a selection index to a valid range.
 * @param index - Requested index
 * @param total - Number of selectable items
 * @returns Safe clamped index
 */
export function clampSelectionIndex(index: number, total: number): number {
	if (total <= 0) return 0;
	return Math.max(0, Math.min(total - 1, index));
}

/**
 * Cycle an index with wrap-around behavior.
 * @param index - Current index
 * @param total - Number of items in the cycle
 * @param delta - Movement delta (positive or negative)
 * @returns Wrapped index
 */
export function cycleSelectionIndex(index: number, total: number, delta: number): number {
	if (total <= 0) return 0;
	const next = (index + delta) % total;
	return next < 0 ? next + total : next;
}

/**
 * Clamp a scroll offset to valid bounds.
 * @param offset - Requested offset
 * @param maxOffset - Maximum allowed offset
 * @returns Clamped offset
 */
export function clampScrollOffset(offset: number, maxOffset: number): number {
	const safeMax = Math.max(0, Math.floor(maxOffset));
	return Math.max(0, Math.min(safeMax, Math.floor(offset)));
}

/**
 * Move scroll offset by delta while keeping bounds intact.
 * @param offset - Current offset
 * @param delta - Scroll delta
 * @param maxOffset - Maximum allowed offset
 * @returns Next clamped offset
 */
export function moveScrollOffset(offset: number, delta: number, maxOffset: number): number {
	return clampScrollOffset(offset + delta, maxOffset);
}

/**
 * Append new output into a bounded rolling buffer, retaining newest content.
 * @param buffer - Current buffer text
 * @param incoming - Newly appended output
 * @param maxChars - Maximum buffer size in characters
 * @returns Truncated buffer that keeps the newest data
 */
export function appendRollingOutput(buffer: string, incoming: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	const combined = `${buffer}${incoming}`;
	if (combined.length <= maxChars) return combined;
	return combined.slice(combined.length - maxChars);
}

/**
 * Parse `/team-dashboard` args into an explicit toggle resolution.
 * @param currentEnabled - Current dashboard enabled state
 * @param args - Raw command args
 * @returns Parsed command behavior
 */
export function resolveDashboardCommand(
	currentEnabled: boolean,
	args: string
): DashboardCommandResolution {
	const command = args.trim().toLowerCase();
	if (command.length === 0) {
		const nextEnabled = !currentEnabled;
		return {
			action: "toggle",
			changed: true,
			isError: false,
			message: nextEnabled ? "Team dashboard enabled." : "Team dashboard disabled.",
			nextEnabled,
		};
	}

	if (command === "on") {
		return {
			action: "on",
			changed: !currentEnabled,
			isError: false,
			message: currentEnabled ? "Team dashboard is already enabled." : "Team dashboard enabled.",
			nextEnabled: true,
		};
	}

	if (command === "off") {
		return {
			action: "off",
			changed: currentEnabled,
			isError: false,
			message: currentEnabled ? "Team dashboard disabled." : "Team dashboard is already disabled.",
			nextEnabled: false,
		};
	}

	if (command === "status") {
		return {
			action: "status",
			changed: false,
			isError: false,
			message: currentEnabled ? "Team dashboard is enabled." : "Team dashboard is disabled.",
			nextEnabled: currentEnabled,
		};
	}

	return {
		action: "invalid",
		changed: false,
		isError: true,
		message: "Usage: /team-dashboard [on|off|status]",
		nextEnabled: currentEnabled,
	};
}

/**
 * Parse SGR mouse input for dashboard wheel scrolling.
 * @param data - Raw input data from terminal
 * @returns Wheel direction when sequence is a mouse wheel event
 */
export function parseDashboardMouseWheel(data: string): DashboardMouseWheelDirection | undefined {
	const parsed = parseDashboardMouseEvent(data);
	if (!parsed) return undefined;
	if (parsed.eventType !== "press") return undefined;
	if ((parsed.buttonCode & 64) !== 64) return undefined;
	return (parsed.buttonCode & 1) === 0 ? "up" : "down";
}

/**
 * Detect whether input is any SGR mouse event.
 * @param data - Raw input data from terminal
 * @returns True when the payload is an SGR mouse sequence
 */
function isDashboardMouseEvent(data: string): boolean {
	return parseDashboardMouseEvent(data) !== undefined;
}

/**
 * Parse an SGR mouse event into button/event metadata.
 * @param data - Raw terminal input string
 * @returns Parsed mouse event, or undefined when input is not SGR mouse data
 */
function parseDashboardMouseEvent(
	data: string
): { readonly buttonCode: number; readonly eventType: "press" | "release" } | undefined {
	if (!data.startsWith("\x1b[<") || data.length < 8) return undefined;
	const suffix = data[data.length - 1];
	if (suffix !== "M" && suffix !== "m") return undefined;
	const payload = data.slice(3, -1);
	const parts = payload.split(";");
	if (parts.length !== 3) return undefined;
	if (parts.some((part) => !/^\d+$/.test(part))) return undefined;
	const buttonCode = Number.parseInt(parts[0] ?? "", 10);
	if (!Number.isFinite(buttonCode)) return undefined;
	return {
		buttonCode,
		eventType: suffix === "M" ? "press" : "release",
	};
}

/**
 * Store bounded teammate activity used by dashboard cards.
 */
export class TeamDashboardActivityStore {
	private readonly lastToolByTeammate = new Map<string, string>();
	private readonly liveInputTokensByTeammate = new Map<string, number>();
	private readonly liveOutputTokensByTeammate = new Map<string, number>();
	private readonly outputByTeammate = new Map<string, string>();
	private readonly totalInputTokensByTeammate = new Map<string, number>();
	private readonly totalOutputTokensByTeammate = new Map<string, number>();
	private readonly updatedAtByTeammate = new Map<string, number>();
	private readonly maxOutputChars: number;

	/**
	 * @param maxOutputChars - Maximum rolling output size per teammate
	 */
	constructor(maxOutputChars = DASHBOARD_MAX_OUTPUT_CHARS) {
		this.maxOutputChars = maxOutputChars;
	}

	/**
	 * Remove all activity state.
	 * @returns void
	 */
	clear(): void {
		this.lastToolByTeammate.clear();
		this.liveInputTokensByTeammate.clear();
		this.liveOutputTokensByTeammate.clear();
		this.outputByTeammate.clear();
		this.totalInputTokensByTeammate.clear();
		this.totalOutputTokensByTeammate.clear();
		this.updatedAtByTeammate.clear();
	}

	/**
	 * Remove activity for all teammates in a team.
	 * @param teamName - Team to purge
	 * @returns void
	 */
	clearTeam(teamName: string): void {
		const prefix = `${teamName}:`;
		this.clearByPrefix(this.lastToolByTeammate, prefix);
		this.clearByPrefix(this.liveInputTokensByTeammate, prefix);
		this.clearByPrefix(this.liveOutputTokensByTeammate, prefix);
		this.clearByPrefix(this.outputByTeammate, prefix);
		this.clearByPrefix(this.totalInputTokensByTeammate, prefix);
		this.clearByPrefix(this.totalOutputTokensByTeammate, prefix);
		this.clearByPrefix(this.updatedAtByTeammate, prefix);
	}

	/**
	 * Record the last tool name for a teammate.
	 * @param teamName - Team name
	 * @param teammateName - Teammate name
	 * @param toolName - Last invoked tool
	 * @returns void
	 */
	setLastTool(teamName: string, teammateName: string, toolName: string): void {
		const key = this.makeKey(teamName, teammateName);
		this.lastToolByTeammate.set(key, toolName);
		this.updatedAtByTeammate.set(key, Date.now());
	}

	/**
	 * Append assistant output to a teammate's rolling buffer.
	 * @param teamName - Team name
	 * @param teammateName - Teammate name
	 * @param output - New output chunk
	 * @returns void
	 */
	appendOutput(teamName: string, teammateName: string, output: string): void {
		const key = this.makeKey(teamName, teammateName);
		const current = this.outputByTeammate.get(key) ?? "";
		const next = appendRollingOutput(current, output, this.maxOutputChars);
		this.outputByTeammate.set(key, next);
		this.updatedAtByTeammate.set(key, Date.now());
	}

	/**
	 * Track live per-turn token usage while a response is streaming.
	 * @param teamName - Team name
	 * @param teammateName - Teammate name
	 * @param inputTokens - Current streamed input token count
	 * @param outputTokens - Current streamed output token count
	 * @returns void
	 */
	setLiveUsage(
		teamName: string,
		teammateName: string,
		inputTokens: number,
		outputTokens: number
	): void {
		const key = this.makeKey(teamName, teammateName);
		this.liveInputTokensByTeammate.set(key, Math.max(0, Math.floor(inputTokens)));
		this.liveOutputTokensByTeammate.set(key, Math.max(0, Math.floor(outputTokens)));
		this.updatedAtByTeammate.set(key, Date.now());
	}

	/**
	 * Commit final turn token usage into cumulative totals.
	 * @param teamName - Team name
	 * @param teammateName - Teammate name
	 * @param inputTokens - Final turn input tokens
	 * @param outputTokens - Final turn output tokens
	 * @returns void
	 */
	commitUsage(
		teamName: string,
		teammateName: string,
		inputTokens: number,
		outputTokens: number
	): void {
		const key = this.makeKey(teamName, teammateName);
		const input = Math.max(0, Math.floor(inputTokens));
		const output = Math.max(0, Math.floor(outputTokens));
		this.totalInputTokensByTeammate.set(
			key,
			(this.totalInputTokensByTeammate.get(key) ?? 0) + input
		);
		this.totalOutputTokensByTeammate.set(
			key,
			(this.totalOutputTokensByTeammate.get(key) ?? 0) + output
		);
		this.clearLiveUsage(teamName, teammateName);
		this.updatedAtByTeammate.set(key, Date.now());
	}

	/**
	 * Clear live usage values for a teammate.
	 * @param teamName - Team name
	 * @param teammateName - Teammate name
	 * @returns void
	 */
	clearLiveUsage(teamName: string, teammateName: string): void {
		const key = this.makeKey(teamName, teammateName);
		this.liveInputTokensByTeammate.delete(key);
		this.liveOutputTokensByTeammate.delete(key);
	}

	/**
	 * Update a teammate's activity timestamp without mutating other fields.
	 * @param teamName - Team name
	 * @param teammateName - Teammate name
	 * @returns void
	 */
	touch(teamName: string, teammateName: string): void {
		const key = this.makeKey(teamName, teammateName);
		this.updatedAtByTeammate.set(key, Date.now());
	}

	/**
	 * Read a teammate activity snapshot for card rendering.
	 * @param teamName - Team name
	 * @param teammateName - Teammate name
	 * @returns Activity entry with output, tool, tokens, and timestamp
	 */
	get(teamName: string, teammateName: string): DashboardActivityEntry {
		const key = this.makeKey(teamName, teammateName);
		return {
			lastTool: this.lastToolByTeammate.get(key) ?? null,
			liveInputTokens: this.liveInputTokensByTeammate.get(key) ?? 0,
			liveOutputTokens: this.liveOutputTokensByTeammate.get(key) ?? 0,
			output: this.outputByTeammate.get(key) ?? "",
			totalInputTokens: this.totalInputTokensByTeammate.get(key) ?? 0,
			totalOutputTokens: this.totalOutputTokensByTeammate.get(key) ?? 0,
			updatedAt: this.updatedAtByTeammate.get(key),
		};
	}

	/**
	 * Delete all map entries whose key starts with a given prefix.
	 * @param map - Map to mutate
	 * @param prefix - Key prefix for entries to remove
	 * @returns void
	 */
	private clearByPrefix<T>(map: Map<string, T>, prefix: string): void {
		for (const key of map.keys()) {
			if (key.startsWith(prefix)) map.delete(key);
		}
	}

	/**
	 * Build a stable teammate activity key.
	 * @param teamName - Team name
	 * @param teammateName - Teammate name
	 * @returns Composite lookup key
	 */
	private makeKey(teamName: string, teammateName: string): string {
		return `${teamName}:${teammateName}`;
	}
}

/**
 * Custom editor workspace that renders the teams dashboard.
 */
export class TeamDashboardEditor extends CustomEditor {
	private readonly options: TeamDashboardEditorOptions;
	private readonly colorTheme: Theme;
	private selectedNodeIndex = 0;
	private selectedTeamIndex = 0;
	private cardScrollOffset = 0;
	private maxScrollOffset = 0;
	private cardViewportHeight = 8;
	private readonly spinnerFrames =
		getSpinner().length > 0 ? getSpinner() : DASHBOARD_FALLBACK_FRAMES;

	/**
	 * @param tui - Active TUI instance
	 * @param editorTheme - Editor theme from interactive mode
	 * @param keybindings - Keybindings manager
	 * @param options - Snapshot provider, exit callback, and full theme
	 */
	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		options: TeamDashboardEditorOptions
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.options = options;
		this.colorTheme = options.theme;
		this.disableSubmit = true;
	}

	/**
	 * Request a re-render for live dashboard updates.
	 * @returns void
	 */
	refresh(): void {
		this.tui.requestRender();
	}

	/**
	 * Handle dashboard navigation and scrolling keys.
	 * @param data - Raw key input
	 * @returns void
	 */
	override handleInput(data: string): void {
		const wheel = parseDashboardMouseWheel(data);
		if (wheel) {
			const delta = wheel === "up" ? -DASHBOARD_MOUSE_SCROLL_LINES : DASHBOARD_MOUSE_SCROLL_LINES;
			this.cardScrollOffset = moveScrollOffset(this.cardScrollOffset, delta, this.maxScrollOffset);
			this.refresh();
			return;
		}
		if (isDashboardMouseEvent(data)) {
			return;
		}

		const snapshot = this.options.getSnapshot();
		const nodes = buildTreeNodes(snapshot);
		this.syncTeamSelection(nodes);

		if (matchesKey(data, Key.escape)) {
			if (this.options.onEscape) {
				this.options.onEscape();
			} else {
				this.options.onExit();
			}
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedNodeIndex = clampSelectionIndex(this.selectedNodeIndex - 1, nodes.length);
			this.syncTeamSelection(nodes);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			this.selectedNodeIndex = clampSelectionIndex(this.selectedNodeIndex + 1, nodes.length);
			this.syncTeamSelection(nodes);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.cycleTeamSelection(snapshot, nodes, 1);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.shift("tab"))) {
			this.cycleTeamSelection(snapshot, nodes, -1);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.pageUp)) {
			this.cardScrollOffset = moveScrollOffset(
				this.cardScrollOffset,
				-this.getPageScrollStep(),
				this.maxScrollOffset
			);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.pageDown)) {
			this.cardScrollOffset = moveScrollOffset(
				this.cardScrollOffset,
				this.getPageScrollStep(),
				this.maxScrollOffset
			);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.ctrl("u"))) {
			this.cardScrollOffset = moveScrollOffset(
				this.cardScrollOffset,
				-this.getHalfPageScrollStep(),
				this.maxScrollOffset
			);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.ctrl("d"))) {
			this.cardScrollOffset = moveScrollOffset(
				this.cardScrollOffset,
				this.getHalfPageScrollStep(),
				this.maxScrollOffset
			);
			this.refresh();
			return;
		}

		if (this.onExtensionShortcut?.(data)) return;
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	/**
	 * Render the full dashboard workspace.
	 * @param width - Available terminal width
	 * @returns Rendered lines
	 */
	override render(width: number): string[] {
		const split = calculateDashboardSplit(width);
		const snapshot = this.options.getSnapshot();
		const nodes = buildTreeNodes(snapshot);
		this.syncTeamSelection(nodes);

		const totalHeight = Math.max(10, this.tui.terminal.rows - 4);
		const bodyHeight = Math.max(8, totalHeight - 1);

		const selectedNode = nodes[this.selectedNodeIndex];
		const selectedTeammateName =
			selectedNode?.kind === "teammate"
				? snapshot.teams[selectedNode.teamIndex]?.teammates[selectedNode.teammateIndex ?? 0]?.name
				: undefined;

		const leftLines = this.renderLeftPane(snapshot, nodes, split.leftWidth, bodyHeight);
		const rightLines = this.renderRightPane(
			snapshot,
			split.rightWidth,
			bodyHeight,
			selectedTeammateName
		);
		const merged = mergeColumns(
			leftLines,
			rightLines,
			split.leftWidth,
			split.rightWidth,
			bodyHeight,
			this.colorTheme
		);

		const footer = this.renderFooter(width);
		return [...merged, footer];
	}

	/**
	 * Keep selected team in sync with the selected tree node.
	 * @param nodes - Current flattened tree nodes
	 * @returns void
	 */
	private syncTeamSelection(nodes: readonly DashboardTreeNode[]): void {
		if (nodes.length === 0) {
			this.selectedNodeIndex = 0;
			this.selectedTeamIndex = 0;
			return;
		}
		this.selectedNodeIndex = clampSelectionIndex(this.selectedNodeIndex, nodes.length);
		const selectedNode = nodes[this.selectedNodeIndex];
		if (!selectedNode) return;
		this.selectedTeamIndex = selectedNode.teamIndex;
	}

	/**
	 * Cycle selected team with wrap-around and jump selection to that team root.
	 * @param snapshot - Current dashboard snapshot
	 * @param nodes - Flattened tree nodes
	 * @param delta - Team cycle direction
	 * @returns void
	 */
	private cycleTeamSelection(
		snapshot: TeamDashboardSnapshot,
		nodes: readonly DashboardTreeNode[],
		delta: number
	): void {
		if (snapshot.teams.length === 0) return;
		this.selectedTeamIndex = cycleSelectionIndex(
			this.selectedTeamIndex,
			snapshot.teams.length,
			delta
		);
		const teamNodeIndex = nodes.findIndex(
			(node) => node.kind === "team" && node.teamIndex === this.selectedTeamIndex
		);
		if (teamNodeIndex >= 0) this.selectedNodeIndex = teamNodeIndex;
		this.cardScrollOffset = 0;
	}

	/**
	 * Render the left tree and sidebar feed pane.
	 * @param snapshot - Dashboard data snapshot
	 * @param nodes - Flattened tree nodes
	 * @param width - Available pane width
	 * @param height - Available pane height
	 * @returns Left pane lines
	 */
	private renderLeftPane(
		snapshot: TeamDashboardSnapshot,
		nodes: readonly DashboardTreeNode[],
		width: number,
		height: number
	): string[] {
		const t = this.colorTheme;
		const treeLines: string[] = [formatDashboardRole(t, "title", "Teams")];
		const selectedNode = nodes[this.selectedNodeIndex];
		let selectedTreeLine = 0;

		for (let teamIndex = 0; teamIndex < snapshot.teams.length; teamIndex++) {
			const team = snapshot.teams[teamIndex];
			if (!team) continue;
			const teamSelected = selectedNode?.kind === "team" && selectedNode.teamIndex === teamIndex;
			const teamLine = `${team.name} ${formatDashboardRole(t, "meta", `(${team.teammates.length})`)}`;
			treeLines.push(colorByTeam(teamLine, team.name, teamSelected));
			if (teamSelected) selectedTreeLine = treeLines.length - 1;

			for (let teammateIndex = 0; teammateIndex < team.teammates.length; teammateIndex++) {
				const teammate = team.teammates[teammateIndex];
				if (!teammate) continue;
				const teammateSelected =
					selectedNode?.kind === "teammate" &&
					selectedNode.teamIndex === teamIndex &&
					selectedNode.teammateIndex === teammateIndex;
				const inbox =
					teammate.unreadInboxCount > 0
						? ` ${formatDashboardRole(t, "status_warning", `✉${teammate.unreadInboxCount}`)}`
						: "";
				const referee = isRefereeRole(teammate.role)
					? ` ${formatDashboardRole(t, "hint", "⚖")}`
					: "";
				const memberName = colorMemberText(`@${teammate.name}`, teammate.name, teammateSelected);
				const activityGlyph = pickActiveGlyph(teammate.name, teammate.status, this.spinnerFrames);
				const displayStatus = getDisplayStatus(teammate, team.isComplete);
				const teammateLine =
					`  ${activityGlyph} ${memberName} ${formatStatusBadge(displayStatus, t)}` +
					`${inbox}${referee}`;
				treeLines.push(teammateLine);
				if (teammateSelected) selectedTreeLine = treeLines.length - 1;

				treeLines.push(formatDashboardRole(t, "meta", `    └─ ${shortModelId(teammate.model)}`));
			}
		}

		const minFeedHeight = 6;
		const treeMaxHeight = Math.max(1, height - minFeedHeight);
		const treeHeight = Math.min(treeLines.length, treeMaxHeight);
		const visibleTree = fitLinesAroundSelection(treeLines, selectedTreeLine, treeHeight);
		const feedHeight = Math.max(0, height - visibleTree.length);
		if (feedHeight <= 0) return visibleTree.slice(0, height);

		const selectedTeam =
			snapshot.teams[clampSelectionIndex(this.selectedTeamIndex, snapshot.teams.length)];
		const feedLines = this.renderSidebarFeed(selectedTeam, width);
		const separator = t.fg("borderMuted", "─".repeat(Math.max(3, width - 1)));
		const visibleFeed = fitFeedLines(feedLines, Math.max(0, feedHeight - 1));
		const feedBlock = padLines([separator, ...visibleFeed], feedHeight);
		return [...visibleTree, ...feedBlock].slice(0, height);
	}

	/**
	 * Render bottom-left feed lines for the selected team.
	 * @param team - Selected team payload
	 * @param width - Available left-pane width
	 * @returns Feed lines
	 */
	private renderSidebarFeed(team: TeamDashboardTeam | undefined, width: number): string[] {
		const t = this.colorTheme;
		const lines: string[] = [formatDashboardRole(t, "title", "Feed")];
		if (!team) {
			lines.push(formatDashboardRole(t, "hint", "(no active team)"));
			return lines;
		}
		if (team.feed.length === 0) {
			lines.push(formatDashboardRole(t, "hint", "(no feed events yet)"));
			return lines;
		}

		const contentIndent = "  ";
		const contentIndentWidth = visibleWidth(contentIndent);
		const safeWidth = Math.max(1, width);
		for (const entry of team.feed) {
			const timestamp = formatDashboardRole(t, "meta", formatFeedTimestamp(entry.timestamp));
			const toLabel =
				entry.to === "all"
					? formatDashboardRole(t, "action", "all")
					: colorMemberText(`@${entry.to}`, entry.to, false);
			const from = colorMemberText(`@${entry.from}`, entry.from, false);
			const heading = `${formatDashboardRole(t, "meta", "•")} ${timestamp} ${from}${formatDashboardRole(t, "meta", " → ")}${toLabel}`;
			lines.push(truncateToWidth(heading, safeWidth, ""));

			const contentWidth = Math.max(6, safeWidth - contentIndentWidth);
			const wrappedContent = wrapPlainText(entry.content, contentWidth);
			for (const line of wrappedContent) {
				lines.push(
					truncateToWidth(
						`${formatDashboardRole(t, "meta", contentIndent)}${formatDashboardRole(t, "process_output", line)}`,
						safeWidth,
						""
					)
				);
			}
		}
		return lines;
	}

	/**
	 * Render the right card pane for the currently selected team.
	 * @param snapshot - Dashboard data snapshot
	 * @param width - Available right pane width
	 * @param height - Available right pane height
	 * @param selectedTeammateName - Currently selected teammate (if any)
	 * @returns Right pane lines
	 */
	private renderRightPane(
		snapshot: TeamDashboardSnapshot,
		width: number,
		height: number,
		selectedTeammateName?: string
	): string[] {
		const t = this.colorTheme;
		const team = snapshot.teams[clampSelectionIndex(this.selectedTeamIndex, snapshot.teams.length)];
		if (!team) {
			this.maxScrollOffset = 0;
			this.cardScrollOffset = 0;
			return padLines(
				[
					formatDashboardRole(t, "title", "Team dashboard"),
					formatDashboardRole(t, "hint", "No active teams."),
					formatDashboardRole(
						t,
						"hint",
						"Create a team with team_create and spawn teammates with team_spawn."
					),
				],
				height
			);
		}

		const modelSummary = summarizeTeamModels(team);
		const heading =
			`${formatDashboardRole(t, "title", "Team:")} ${colorByTeam(team.name, team.name, true)} ` +
			`${formatDashboardRole(t, "meta", `(${team.teammates.length} teammate${team.teammates.length === 1 ? "" : "s"})`)}` +
			(modelSummary.length > 0
				? `${formatDashboardRole(t, "meta", " · ")}${formatDashboardRole(t, "hint", modelSummary)}`
				: "");
		const cardsHeight = Math.max(1, height - 1);
		this.cardViewportHeight = cardsHeight;

		const allCardLines = this.renderCardGrid(team, width, selectedTeammateName);
		this.maxScrollOffset = Math.max(0, allCardLines.length - cardsHeight);
		this.cardScrollOffset = clampScrollOffset(this.cardScrollOffset, this.maxScrollOffset);

		const visibleCardLines = allCardLines.slice(
			this.cardScrollOffset,
			this.cardScrollOffset + cardsHeight
		);
		const scrollLabel =
			this.maxScrollOffset > 0
				? formatDashboardRole(t, "meta", ` ${this.cardScrollOffset}/${this.maxScrollOffset}`)
				: "";

		const headingLine = truncateToWidth(`${heading}${scrollLabel}`, Math.max(1, width), "");
		return padLines([headingLine, ...visibleCardLines], height);
	}

	/**
	 * Render teammate cards as a responsive grid.
	 * @param team - Selected team payload
	 * @param width - Right pane width
	 * @param selectedTeammateName - Currently selected teammate (if any)
	 * @returns Card grid lines
	 */
	private renderCardGrid(
		team: TeamDashboardTeam,
		width: number,
		selectedTeammateName?: string
	): string[] {
		if (width <= 0) return [];
		if (team.teammates.length === 0) {
			const empty = new BorderedBox(["No teammates yet."], {
				borderColorFn: (str) => this.colorTheme.fg("borderMuted", str),
				title: "empty",
			});
			return empty.render(width);
		}

		const columns = calculateDashboardGridColumns(width);
		const cardWidth =
			columns === 2
				? Math.max(12, Math.floor((width - DASHBOARD_CARD_GAP) / 2))
				: Math.max(12, width);
		const cards = team.teammates.map((teammate) =>
			this.renderTeammateCard(
				teammate,
				team.isComplete,
				cardWidth,
				teammate.name === selectedTeammateName
			)
		);

		if (columns === 1) {
			return cards.flatMap((card, index) => (index === 0 ? card : ["", ...card]));
		}

		const gap = " ".repeat(DASHBOARD_CARD_GAP);
		const lines: string[] = [];
		for (let index = 0; index < cards.length; index += 2) {
			const leftCard = cards[index] ?? [];
			const rightCard = cards[index + 1] ?? [];
			const rowHeight = Math.max(leftCard.length, rightCard.length);
			for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
				const leftLine = padToWidth(leftCard[lineIndex] ?? "", cardWidth);
				const rightLine = padToWidth(rightCard[lineIndex] ?? "", cardWidth);
				lines.push(leftLine + gap + rightLine);
			}
			if (index + 2 < cards.length) lines.push("");
		}
		return lines;
	}

	/**
	 * Render a single teammate status card.
	 * @param teammate - Teammate payload
	 * @param teamIsComplete - Whether the selected team has fully completed all tasks
	 * @param width - Card width
	 * @param selected - Whether this card is selected
	 * @returns Card lines including border
	 */
	private renderTeammateCard(
		teammate: TeamDashboardTeammate,
		teamIsComplete: boolean,
		width: number,
		selected: boolean
	): string[] {
		const t = this.colorTheme;
		const outputLines = summarizeOutput(teammate.output, DASHBOARD_OUTPUT_PREVIEW_LINES);
		const inboxLabel =
			teammate.unreadInboxCount > 0
				? `${formatDashboardRole(t, "status_warning", "✉")} ${formatDashboardRole(t, "action", `${teammate.unreadInboxCount} unread`)}`
				: formatDashboardRole(t, "hint", "inbox clear");
		const displayStatus = getDisplayStatus(teammate, teamIsComplete);
		const taskValue = teammate.currentTask
			? formatDashboardRole(t, "action", teammate.currentTask)
			: formatDashboardRole(t, "meta", "—");
		const toolValue = teammate.lastTool
			? formatDashboardRole(t, "action", teammate.lastTool)
			: formatDashboardRole(t, "meta", "—");
		const body = [
			formatLabeledValue("status", formatStatusLabel(displayStatus, t), t),
			formatLabeledValue("role", formatDashboardRole(t, "meta", teammate.role), t),
			formatLabeledValue("model", formatDashboardRole(t, "meta", teammate.model), t),
			formatLabeledValue("task", taskValue, t),
			formatLabeledValue("tool", toolValue, t),
			formatLabeledValue("inbox", inboxLabel, t),
			formatLabeledValue("tokens", formatTokenMeters(teammate, t), t),
			formatLabeledValue(
				"updated",
				formatDashboardRole(t, "hint", formatRelativeTimestamp(teammate.updatedAt)),
				t
			),
			"",
			formatDashboardRole(t, "meta", "output"),
			...outputLines.map((line) => `  ${formatDashboardRole(t, "process_output", line)}`),
		];

		const box = new BorderedBox(body, {
			borderColorFn: selected
				? (str) => colorMemberText(str, teammate.name, true)
				: (str) => t.fg("borderMuted", str),
			title: `@${teammate.name}`,
			titleColorFn: (str) => colorMemberText(str, teammate.name, selected),
		});
		return box.render(width);
	}

	/**
	 * Render the dashboard key hint footer line.
	 * @param width - Terminal width
	 * @returns Footer line
	 */
	private renderFooter(width: number): string {
		const hints =
			"Esc cancel/close · ↑/↓ j/k select · Tab/Shift+Tab team · PgUp/PgDn Ctrl+U/Ctrl+D scroll · mouse wheel scroll";
		return padToWidth(
			truncateToWidth(formatDashboardRole(this.colorTheme, "hint", hints), Math.max(1, width), ""),
			Math.max(1, width)
		);
	}

	/**
	 * Get page-scroll distance for PgUp/PgDn.
	 * @returns Number of lines to scroll
	 */
	private getPageScrollStep(): number {
		return Math.max(1, this.cardViewportHeight - 2);
	}

	/**
	 * Get half-page scroll distance for Ctrl+U/Ctrl+D.
	 * @returns Number of lines to scroll
	 */
	private getHalfPageScrollStep(): number {
		return Math.max(1, Math.floor(this.cardViewportHeight / 2));
	}
}

/**
 * Apply shared semantic role styling for dashboard text fragments.
 * @param theme - Active UI theme
 * @param role - Semantic presentation role
 * @param text - Raw text fragment
 * @returns Styled text fragment
 */
function formatDashboardRole(theme: Theme, role: PresentationRole, text: string): string {
	return formatPresentationText(theme, role, text);
}

/**
 * Apply deterministic identity styling for teammate names and identity tokens.
 * @param text - Raw token text (for example, "@alice")
 * @param memberName - Identity seed used for deterministic color selection
 * @param highlighted - Whether to apply bold emphasis
 * @returns ANSI-styled identity token
 */
function formatDashboardIdentity(text: string, memberName: string, highlighted: boolean): string {
	return formatIdentityText(text, memberName, highlighted);
}

/**
 * Build a flattened team/member tree list for left-pane navigation.
 * @param snapshot - Dashboard snapshot
 * @returns Flat node list preserving render order
 */
function buildTreeNodes(snapshot: TeamDashboardSnapshot): DashboardTreeNode[] {
	const nodes: DashboardTreeNode[] = [];
	for (let teamIndex = 0; teamIndex < snapshot.teams.length; teamIndex++) {
		const team = snapshot.teams[teamIndex];
		if (!team) continue;
		nodes.push({ kind: "team", teamIndex });
		for (let teammateIndex = 0; teammateIndex < team.teammates.length; teammateIndex++) {
			nodes.push({ kind: "teammate", teamIndex, teammateIndex });
		}
	}
	return nodes;
}

/**
 * Resolve the display-only status used by dashboard badges and labels.
 * @param teammate - Teammate payload
 * @param teamIsComplete - Whether the teammate's team has fully completed all tasks
 * @returns Derived display status with finished-state detection
 */
function getDisplayStatus(
	teammate: TeamDashboardTeammate,
	teamIsComplete: boolean
): TeamDashboardDisplayStatus {
	if (
		teamIsComplete &&
		teammate.status === "idle" &&
		teammate.currentTask === null &&
		teammate.completedTaskCount > 0
	) {
		return "finished";
	}
	return teammate.status;
}

/**
 * Format a teammate status label with color.
 * @param status - Teammate lifecycle status
 * @param theme - Active theme for color tokens
 * @returns Styled status label
 */
function formatStatusLabel(status: TeamDashboardDisplayStatus, theme: Theme): string {
	switch (status) {
		case "working":
			return formatDashboardRole(theme, "status_warning", "working");
		case "idle":
			return formatDashboardRole(theme, "status_success", "idle");
		case "finished":
			return formatDashboardRole(theme, "status_success", `${getIcon("success")} finished`);
		case "error":
			return formatDashboardRole(theme, "status_error", "error");
		case "shutdown":
			return formatDashboardRole(theme, "hint", "shutdown");
	}
}

/**
 * Format a compact status badge for the left tree pane.
 * @param status - Teammate lifecycle status
 * @param theme - Active theme for color tokens
 * @returns Styled compact badge
 */
function formatStatusBadge(status: TeamDashboardDisplayStatus, theme: Theme): string {
	switch (status) {
		case "working":
			return formatDashboardRole(theme, "status_warning", "●");
		case "idle":
			return formatDashboardRole(theme, "status_success", "○");
		case "finished":
			return formatDashboardRole(theme, "status_success", getIcon("success"));
		case "error":
			return formatDashboardRole(theme, "status_error", "×");
		case "shutdown":
			return formatDashboardRole(theme, "hint", "■");
	}
}

/**
 * Build a compact models summary for a team.
 * @param team - Team payload
 * @returns Distinct model list string
 */
function summarizeTeamModels(team: TeamDashboardTeam): string {
	const models = [...new Set(team.teammates.map((teammate) => shortModelId(teammate.model)))];
	return models.join(", ");
}

/**
 * Truncate long model identifiers for compact display.
 * @param model - Full model ID
 * @returns Short model label
 */
function shortModelId(model: string): string {
	if (model.length <= 24) return model;
	return `${model.slice(0, 21)}...`;
}

/**
 * Check whether a teammate role implies judge/referee responsibilities.
 * @param role - Role description
 * @returns True when role indicates referee/judge behavior
 */
function isRefereeRole(role: string): boolean {
	return /\b(judge|referee|arbiter)\b/i.test(role);
}

/**
 * Pick an animated glyph for active teammates only.
 * @param teammateName - Teammate name
 * @param status - Teammate status
 * @param frames - Spinner frames
 * @returns Spinner frame for working teammates, otherwise a blank placeholder
 */
function pickActiveGlyph(
	teammateName: string,
	status: TeamDashboardTeammate["status"],
	frames: readonly string[]
): string {
	if (status !== "working") return " ";
	const source = frames.length > 0 ? frames : DASHBOARD_FALLBACK_FRAMES;
	const offset = hashString(teammateName);
	const index = Math.abs(Math.floor(Date.now() / 220) + offset) % source.length;
	const glyph = source[index] ?? "•";
	const color = getIdentityAnsiColor(teammateName);
	return `\x1b[38;5;${color}m${glyph}\x1b[39m`;
}

/**
 * Apply deterministic team color styling.
 * @param text - Text to style
 * @param teamName - Team name for color hashing
 * @param highlighted - Whether to apply stronger emphasis
 * @returns Styled text
 */
function colorByTeam(text: string, teamName: string, highlighted = false): string {
	const color =
		DASHBOARD_TEAM_COLORS[Math.abs(hashString(teamName)) % DASHBOARD_TEAM_COLORS.length];
	const prefix = highlighted ? `\x1b[1;38;5;${color}m` : `\x1b[38;5;${color}m`;
	const suffix = highlighted ? "\x1b[22;39m" : "\x1b[39m";
	return `${prefix}${text}${suffix}`;
}

/**
 * Render a label/value line with subdued label styling.
 * @param label - Left-side label text
 * @param value - Right-side value text
 * @param theme - Active theme for color tokens
 * @returns Styled label/value line
 */
function formatLabeledValue(label: string, value: string, theme: Theme): string {
	return `${formatDashboardRole(theme, "meta", `${label}:`)} ${value}`;
}

/**
 * Render cumulative and live token meters with up/down arrows.
 * @param teammate - Teammate payload with token fields
 * @param theme - Active theme for color tokens
 * @returns Styled token meter string
 */
function formatTokenMeters(teammate: TeamDashboardTeammate, theme: Theme): string {
	const inputTotal = formatCompactTokens(teammate.totalInputTokens);
	const outputTotal = formatCompactTokens(teammate.totalOutputTokens);
	const inputLive =
		teammate.liveInputTokens > 0
			? formatDashboardRole(theme, "hint", ` (+${formatCompactTokens(teammate.liveInputTokens)})`)
			: "";
	const outputLive =
		teammate.liveOutputTokens > 0
			? formatDashboardRole(theme, "hint", ` (+${formatCompactTokens(teammate.liveOutputTokens)})`)
			: "";
	return `${formatDashboardRole(theme, "action", "↑")}${inputTotal}${inputLive} ${formatDashboardRole(theme, "meta", "↓")}${outputTotal}${outputLive}`;
}

/**
 * Format token counts for compact display.
 * @param tokens - Raw token count
 * @returns Human-friendly compact token string
 */
function formatCompactTokens(tokens: number): string {
	const value = Math.max(0, Math.floor(tokens));
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

/**
 * Hash a string to an integer for deterministic styling.
 * @param input - Source text
 * @returns Signed integer hash
 */
function hashString(input: string): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = Math.imul(31, hash) + input.charCodeAt(i);
	}
	return hash;
}

/**
 * Apply deterministic teammate coloring for names and badges.
 * @param text - Text to style
 * @param memberName - Teammate name used for color hashing
 * @param highlighted - Whether to apply bold emphasis
 * @returns Styled text
 */
function colorMemberText(text: string, memberName: string, highlighted: boolean): string {
	return formatDashboardIdentity(text, memberName, highlighted);
}

/**
 * Format a timestamp as a short relative age string.
 * @param timestamp - Unix epoch milliseconds
 * @returns Relative age string
 */
function formatRelativeTimestamp(timestamp?: number): string {
	if (!timestamp) return "—";
	const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
	const minutes = Math.floor(deltaSeconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/**
 * Format a feed event timestamp as HH:MM:SS.
 * @param timestamp - Unix epoch milliseconds
 * @returns Fixed-width local clock timestamp
 */
function formatFeedTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	return `${hours}:${minutes}:${seconds}`;
}

/**
 * Keep a line array at exact target height by clipping/padding.
 * @param lines - Candidate lines
 * @param height - Target line count
 * @returns Height-normalized line array
 */
function padLines(lines: readonly string[], height: number): string[] {
	if (height <= 0) return [];
	const next = lines.slice(0, height);
	while (next.length < height) next.push("");
	return [...next];
}

/**
 * Keep the feed header pinned while tailing newest entries into viewport.
 * @param lines - Full feed line list with header at index 0
 * @param height - Available viewport height
 * @returns Feed lines clipped to the newest entries with header preserved
 */
function fitFeedLines(lines: readonly string[], height: number): string[] {
	if (height <= 0) return [];
	if (lines.length <= height) return padLines(lines, height);
	const [header, ...body] = lines;
	if (!header) return padLines(lines.slice(lines.length - height), height);
	if (height === 1) return [header];
	const tail = body.slice(-(height - 1));
	return padLines([header, ...tail], height);
}

/**
 * Keep selected tree row visible while clipping to pane height.
 * @param lines - Full line list
 * @param selectedIndex - Selected line index
 * @param height - Available height
 * @returns Clipped + padded lines centered around selection when possible
 */
function fitLinesAroundSelection(
	lines: readonly string[],
	selectedIndex: number,
	height: number
): string[] {
	if (height <= 0) return [];
	if (lines.length <= height) return padLines(lines, height);
	const maxStart = Math.max(0, lines.length - height);
	const idealStart = Math.max(0, selectedIndex - Math.floor(height / 2));
	const start = Math.min(maxStart, idealStart);
	return padLines(lines.slice(start, start + height), height);
}

/**
 * Merge left and right pane lines into one side-by-side dashboard body.
 * @param leftLines - Left pane lines
 * @param rightLines - Right pane lines
 * @param leftWidth - Left pane width
 * @param rightWidth - Right pane width
 * @param height - Output body height
 * @param theme - Active theme for border colors
 * @returns Combined row lines
 */
function mergeColumns(
	leftLines: readonly string[],
	rightLines: readonly string[],
	leftWidth: number,
	rightWidth: number,
	height: number,
	theme: Theme
): string[] {
	const rows = Math.max(0, height);
	const result: string[] = [];
	for (let row = 0; row < rows; row++) {
		const left = padToWidth(leftLines[row] ?? "", leftWidth);
		const right = padToWidth(rightLines[row] ?? "", rightWidth);
		const separator = rightWidth > 0 ? theme.fg("borderMuted", "│") : "";
		result.push(left + separator + right);
	}
	return result;
}

/**
 * Pad or truncate a line to a target visual width.
 * @param line - Source line
 * @param width - Desired visible width
 * @returns Width-constrained line
 */
function padToWidth(line: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(line) > width) return truncateToWidth(line, width, "");
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

/**
 * Wrap plain text to a target width using word boundaries.
 * @param text - Input text to wrap
 * @param maxWidth - Maximum characters per line
 * @returns Wrapped lines preserving full content
 */
function wrapPlainText(text: string, maxWidth: number): string[] {
	const width = Math.max(1, Math.floor(maxWidth));
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return [""];

	const words = normalized.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (visibleWidth(word) > width) {
			if (current.length > 0) {
				lines.push(current);
				current = "";
			}
			let remaining = word;
			while (visibleWidth(remaining) > width) {
				const chunk = truncateToWidth(remaining, width, "");
				lines.push(chunk);
				remaining = remaining.slice(chunk.length);
			}
			current = remaining;
			continue;
		}

		if (current.length === 0) {
			current = word;
			continue;
		}

		const candidate = `${current} ${word}`;
		if (visibleWidth(candidate) <= width) {
			current = candidate;
			continue;
		}

		lines.push(current);
		current = word;
	}

	if (current.length > 0) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

/**
 * Build a short, tail-focused live output preview.
 * @param output - Full rolling output buffer
 * @param maxLines - Maximum preview lines
 * @returns Preview lines with newest output retained
 */
function summarizeOutput(output: string, maxLines: number): string[] {
	if (!output.trim()) return ["(no live output yet)"];
	const normalized = output
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	if (normalized.length === 0) return ["(no live output yet)"];
	const tail = normalized.slice(-Math.max(1, maxLines));
	if (normalized.length > tail.length) {
		const first = tail[0];
		if (first) tail[0] = `… ${first}`;
	}
	return tail;
}
