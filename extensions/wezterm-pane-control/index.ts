/**
 * WezTerm Pane Control Extension
 *
 * Adds a single `wezterm_pane` tool for prompt-driven pane management in
 * WezTerm. Registration is gated behind `WEZTERM_PANE` so non-WezTerm terminals
 * get zero overhead.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export type WeztermAction =
	| "list"
	| "split"
	| "close"
	| "focus"
	| "zoom"
	| "resize"
	| "send_text"
	| "read_text"
	| "spawn_tab"
	| "move_to_tab";

export type WeztermDirection =
	| "left"
	| "right"
	| "top"
	| "bottom"
	| "up"
	| "down"
	| "next"
	| "prev";

export type WeztermZoomState = "zoom" | "unzoom" | "toggle";

export interface WeztermPaneParams {
	action: WeztermAction;
	paneId?: number;
	direction?: WeztermDirection;
	percent?: number;
	command?: readonly string[];
	cwd?: string;
	text?: string;
	state?: WeztermZoomState;
	amount?: number;
	startLine?: number;
	endLine?: number;
	escapes?: boolean;
}

export interface WeztermPaneInfo {
	readonly pane_id: number;
	readonly tab_id: number;
	readonly title: string;
	readonly cwd: string;
	readonly is_active: boolean;
	readonly is_zoomed: boolean;
	readonly size: {
		readonly rows: number;
		readonly cols: number;
	};
}

export interface WeztermCliResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type WeztermCliRunner = (args: readonly string[]) => WeztermCliResult;

interface ExecuteDeps {
	readonly currentPaneId: number;
	readonly runCli: WeztermCliRunner;
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

const ACTIONS: readonly WeztermAction[] = [
	"list",
	"split",
	"close",
	"focus",
	"zoom",
	"resize",
	"send_text",
	"read_text",
	"spawn_tab",
	"move_to_tab",
] as const;

const DIRECTIONS: readonly WeztermDirection[] = [
	"left",
	"right",
	"top",
	"bottom",
	"up",
	"down",
	"next",
	"prev",
] as const;

const ZOOM_STATES: readonly WeztermZoomState[] = ["zoom", "unzoom", "toggle"] as const;

/**
 * Parse WEZTERM_PANE to a valid pane ID.
 *
 * @param value - Raw environment value
 * @returns Parsed pane ID, or null when missing/invalid
 */
export function parsePaneId(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) return null;
	return parsed;
}

/**
 * Resolve the wezterm executable path.
 *
 * Honors WEZTERM_EXECUTABLE_DIR when available, otherwise falls back to
 * `wezterm` on PATH.
 *
 * @param env - Environment variables
 * @returns Executable path or binary name
 */
export function resolveWeztermExecutable(env: NodeJS.ProcessEnv): string {
	const executableDir = env.WEZTERM_EXECUTABLE_DIR;
	if (typeof executableDir === "string" && executableDir.length > 0) {
		const candidate = join(executableDir, "wezterm");
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return "wezterm";
}

/**
 * Check whether wezterm CLI is available.
 *
 * @param executable - wezterm executable path/name
 * @returns True when wezterm CLI is invokable
 */
export function isWeztermAvailable(executable: string): boolean {
	const probe = spawnSync(executable, ["cli", "--help"], {
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "ignore"],
	});
	if (probe.error) return false;
	return probe.status === 0;
}

/**
 * Create a runner for `wezterm cli` commands.
 *
 * @param executable - wezterm executable path/name
 * @returns Runner function returning status/stdout/stderr
 */
export function createWeztermRunner(executable: string): WeztermCliRunner {
	return (args) => {
		const result = spawnSync(executable, ["cli", ...args], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (result.error) {
			return {
				status: 1,
				stdout: "",
				stderr: result.error.message,
			};
		}

		return {
			status: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	};
}

/**
 * Convert tool direction values to WezTerm's direction tokens.
 *
 * @param direction - User/tool direction string
 * @returns WezTerm direction token, or null when invalid
 */
export function toPaneDirectionToken(
	direction: string
): "Left" | "Right" | "Up" | "Down" | "Next" | "Prev" | null {
	switch (direction.toLowerCase()) {
		case "left":
			return "Left";
		case "right":
			return "Right";
		case "top":
		case "up":
			return "Up";
		case "bottom":
		case "down":
			return "Down";
		case "next":
			return "Next";
		case "prev":
			return "Prev";
		default:
			return null;
	}
}

/**
 * Convert split direction to one of WezTerm split flags.
 *
 * @param direction - Optional split direction
 * @returns Split direction for CLI flags, or null when invalid
 */
export function toSplitDirection(direction?: string): "left" | "right" | "top" | "bottom" | null {
	if (!direction) return "bottom";
	switch (direction.toLowerCase()) {
		case "left":
		case "right":
		case "top":
		case "bottom":
			return direction.toLowerCase() as "left" | "right" | "top" | "bottom";
		case "up":
			return "top";
		case "down":
			return "bottom";
		default:
			return null;
	}
}

/**
 * Build split-pane CLI args.
 *
 * @param params - Split action parameters
 * @param currentPaneId - Active pane ID
 * @returns CLI args for `wezterm cli split-pane`
 * @throws Error when direction/percent are invalid
 */
export function buildSplitCommandArgs(
	params: Pick<WeztermPaneParams, "paneId" | "direction" | "percent" | "command" | "cwd">,
	currentPaneId: number
): string[] {
	const splitDirection = toSplitDirection(params.direction);
	if (!splitDirection) {
		throw new Error("split requires direction: left/right/top/bottom (up/down aliases supported)");
	}

	if (
		params.percent !== undefined &&
		(!Number.isFinite(params.percent) || params.percent < 1 || params.percent > 99)
	) {
		throw new Error("split percent must be between 1 and 99");
	}

	const args = [
		"split-pane",
		"--pane-id",
		String(params.paneId ?? currentPaneId),
		`--${splitDirection}`,
	];

	if (params.percent !== undefined) {
		args.push("--percent", String(params.percent));
	}
	if (params.cwd) {
		args.push("--cwd", params.cwd);
	}
	if (params.command && params.command.length > 0) {
		args.push("--", ...params.command);
	}

	return args;
}

/**
 * Filter pane list to the current tab.
 *
 * @param panes - Full pane list from wezterm
 * @param currentPaneId - Current pane ID
 * @returns Filtered panes and resolved tab ID
 */
export function filterPanesToCurrentTab(
	panes: readonly WeztermPaneInfo[],
	currentPaneId: number
): { readonly tabId: number | null; readonly panes: readonly WeztermPaneInfo[] } {
	const currentPane = panes.find((pane) => pane.pane_id === currentPaneId);
	if (!currentPane) {
		return { tabId: null, panes };
	}
	return {
		tabId: currentPane.tab_id,
		panes: panes.filter((pane) => pane.tab_id === currentPane.tab_id),
	};
}

/**
 * Format pane records for readable tool output.
 *
 * @param panes - Pane list to format
 * @param currentPaneId - Current pane ID
 * @param tabId - Current tab ID (if known)
 * @returns Human-readable pane summary
 */
export function formatPaneList(
	panes: readonly WeztermPaneInfo[],
	currentPaneId: number,
	tabId: number | null
): string {
	if (panes.length === 0) {
		return tabId === null ? "No panes found." : `No panes found in tab ${tabId}.`;
	}

	const header = tabId === null ? "Panes (current tab unknown):" : `Panes in tab ${tabId}:`;
	const lines = panes.map((pane) => {
		const tags = [
			pane.pane_id === currentPaneId ? "this pane" : "",
			pane.is_active ? "active" : "",
			pane.is_zoomed ? "zoomed" : "",
		].filter(Boolean);
		const tagSuffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
		const cwd = pane.cwd.replace(/^file:\/\//, "") || "(unknown cwd)";
		const title = pane.title || "(no title)";
		return [
			`- pane ${pane.pane_id}${tagSuffix}`,
			`  title: ${title}`,
			`  cwd: ${cwd}`,
			`  size: ${pane.size.cols}x${pane.size.rows}`,
		].join("\n");
	});

	return `${header}\n${lines.join("\n")}`;
}

/**
 * Build a successful tool result.
 *
 * @param text - Primary output text
 * @param details - Optional structured details
 * @returns Tool result object
 */
function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/**
 * Build an error tool result.
 *
 * @param text - Error message
 * @param details - Optional structured details
 * @returns Error tool result object
 */
function fail(text: string, details: Record<string, unknown> = {}): ToolResult {
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}

/**
 * Run wezterm CLI and throw on failure.
 *
 * @param runCli - wezterm CLI runner
 * @param args - CLI args
 * @returns Trimmed stdout
 * @throws Error when command exits non-zero
 */
function runOrThrow(runCli: WeztermCliRunner, args: readonly string[]): string {
	const result = runCli(args);
	if (result.status !== 0) {
		const message =
			result.stderr.trim() || `wezterm cli ${args[0]} failed with exit code ${result.status}`;
		throw new Error(message);
	}
	return result.stdout.trim();
}

/**
 * Execute one wezterm pane action.
 *
 * @param params - Tool parameters
 * @param deps - Execution dependencies
 * @returns Tool result for the action
 */
export function executeWeztermAction(params: WeztermPaneParams, deps: ExecuteDeps): ToolResult {
	try {
		switch (params.action) {
			case "list": {
				const raw = runOrThrow(deps.runCli, ["list", "--format", "json"]);
				const parsed = JSON.parse(raw) as WeztermPaneInfo[];
				const { tabId, panes } = filterPanesToCurrentTab(parsed, deps.currentPaneId);
				return ok(formatPaneList(panes, deps.currentPaneId, tabId), {
					tabId,
					panes,
				});
			}

			case "split": {
				const args = buildSplitCommandArgs(params, deps.currentPaneId);
				const newPaneId = runOrThrow(deps.runCli, args);
				const direction = toSplitDirection(params.direction) ?? "bottom";
				const percentLabel = params.percent === undefined ? "default size" : `${params.percent}%`;
				return ok(
					`✓ Split pane (${direction}, ${percentLabel})${newPaneId ? ` → new pane ${newPaneId}` : ""}`,
					{
						newPaneId: newPaneId || null,
						direction,
						percent: params.percent ?? null,
					}
				);
			}

			case "close": {
				const targetPaneId = params.paneId ?? deps.currentPaneId;
				const warning =
					targetPaneId === deps.currentPaneId
						? `Closing current pane (pane ${targetPaneId}). This will terminate this session.`
						: null;
				runOrThrow(deps.runCli, ["kill-pane", "--pane-id", String(targetPaneId)]);
				return ok(
					warning ? `${warning}\n✓ Closed pane ${targetPaneId}` : `✓ Closed pane ${targetPaneId}`,
					{
						paneId: targetPaneId,
						isSelfClose: targetPaneId === deps.currentPaneId,
					}
				);
			}

			case "focus": {
				if (params.paneId !== undefined) {
					runOrThrow(deps.runCli, ["activate-pane", "--pane-id", String(params.paneId)]);
					return ok(`✓ Focused pane ${params.paneId}`, { paneId: params.paneId });
				}
				if (!params.direction) {
					return fail("focus requires either paneId or direction");
				}
				const direction = toPaneDirectionToken(params.direction);
				if (!direction) {
					return fail("focus direction must be one of: left/right/top/bottom/up/down/next/prev");
				}
				runOrThrow(deps.runCli, [
					"activate-pane-direction",
					"--pane-id",
					String(deps.currentPaneId),
					direction,
				]);
				return ok(`✓ Focused pane ${direction.toLowerCase()}`, { direction });
			}

			case "zoom": {
				const state = params.state ?? "toggle";
				const targetPaneId = params.paneId ?? deps.currentPaneId;
				runOrThrow(deps.runCli, ["zoom-pane", "--pane-id", String(targetPaneId), `--${state}`]);
				return ok(`✓ Applied zoom state '${state}' on pane ${targetPaneId}`, {
					paneId: targetPaneId,
					state,
				});
			}

			case "resize": {
				if (!params.direction) {
					return fail("resize requires direction");
				}
				const direction = toPaneDirectionToken(params.direction);
				if (!direction) {
					return fail("resize direction must be one of: left/right/top/bottom/up/down/next/prev");
				}
				const amount = params.amount ?? 5;
				if (!Number.isFinite(amount) || amount <= 0) {
					return fail("resize amount must be a positive number");
				}
				const targetPaneId = params.paneId ?? deps.currentPaneId;
				runOrThrow(deps.runCli, [
					"adjust-pane-size",
					"--pane-id",
					String(targetPaneId),
					"--amount",
					String(amount),
					direction,
				]);
				return ok(`✓ Resized pane ${targetPaneId} ${direction.toLowerCase()} by ${amount} cells`, {
					paneId: targetPaneId,
					direction,
					amount,
				});
			}

			case "send_text": {
				if (params.text === undefined || params.text.length === 0) {
					return fail("send_text requires non-empty text");
				}
				const targetPaneId = params.paneId ?? deps.currentPaneId;
				runOrThrow(deps.runCli, ["send-text", "--pane-id", String(targetPaneId), params.text]);
				return ok(`✓ Sent text to pane ${targetPaneId}`, { paneId: targetPaneId });
			}

			case "read_text": {
				const targetPaneId = params.paneId ?? deps.currentPaneId;
				const args = ["get-text", "--pane-id", String(targetPaneId)];
				if (params.startLine !== undefined) {
					args.push("--start-line", String(params.startLine));
				}
				if (params.endLine !== undefined) {
					args.push("--end-line", String(params.endLine));
				}
				if (params.escapes === true) {
					args.push("--escapes");
				}
				const text = runOrThrow(deps.runCli, args);
				return ok(text.length > 0 ? text : "(empty pane text)", {
					paneId: targetPaneId,
				});
			}

			case "spawn_tab": {
				const args = ["spawn", "--pane-id", String(deps.currentPaneId)];
				if (params.cwd) {
					args.push("--cwd", params.cwd);
				}
				if (params.command && params.command.length > 0) {
					args.push("--", ...params.command);
				}
				const newPaneId = runOrThrow(deps.runCli, args);
				return ok(`✓ Spawned new tab${newPaneId ? ` → pane ${newPaneId}` : ""}`, {
					newPaneId: newPaneId || null,
				});
			}

			case "move_to_tab": {
				const targetPaneId = params.paneId ?? deps.currentPaneId;
				runOrThrow(deps.runCli, ["move-pane-to-new-tab", "--pane-id", String(targetPaneId)]);
				return ok(`✓ Moved pane ${targetPaneId} to a new tab`, { paneId: targetPaneId });
			}

			default: {
				return fail(`Unsupported action: ${(params as { action: string }).action}`);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return fail(`✗ Failed: ${message}`);
	}
}

/**
 * Register the wezterm pane control tool when running inside WezTerm.
 *
 * @param pi - Extension API instance
 * @returns Nothing
 */
export default function weztermPaneControl(pi: ExtensionAPI): void {
	const currentPaneId = parsePaneId(process.env.WEZTERM_PANE);
	if (currentPaneId === null) {
		return;
	}

	const weztermExecutable = resolveWeztermExecutable(process.env);
	if (!isWeztermAvailable(weztermExecutable)) {
		return;
	}

	const runCli = createWeztermRunner(weztermExecutable);

	pi.registerTool({
		name: "wezterm_pane",
		label: "wezterm_pane",
		description: [
			"Manage WezTerm panes and tabs from prompts.",
			"Use action='list' to inspect panes in the current tab, then split/focus/close/zoom/resize/send_text/read_text/spawn_tab/move_to_tab.",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(ACTIONS, { description: "Pane control action" }),
			paneId: Type.Optional(
				Type.Number({ description: "Target pane ID. Defaults to current pane." })
			),
			direction: Type.Optional(
				StringEnum(DIRECTIONS, {
					description: "Direction for split/focus/resize",
				})
			),
			percent: Type.Optional(
				Type.Number({ description: "Split percentage (1-99) for action='split'" })
			),
			command: Type.Optional(
				Type.Array(Type.String(), {
					description: "Command and args for split/spawn_tab, e.g. ['tallow', '--model', '...']",
				})
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for split/spawn_tab" })),
			text: Type.Optional(Type.String({ description: "Text payload for action='send_text'" })),
			state: Type.Optional(
				StringEnum(ZOOM_STATES, {
					description: "Zoom state for action='zoom' (default: toggle)",
				})
			),
			amount: Type.Optional(Type.Number({ description: "Resize amount in cells (default: 5)" })),
			startLine: Type.Optional(Type.Number({ description: "Start line for action='read_text'" })),
			endLine: Type.Optional(Type.Number({ description: "End line for action='read_text'" })),
			escapes: Type.Optional(
				Type.Boolean({ description: "Include escape sequences for action='read_text'" })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			return executeWeztermAction(params as WeztermPaneParams, { currentPaneId, runCli });
		},
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt:
				`${event.systemPrompt}\n\n# WezTerm Pane Control\n\n` +
				`You are running in WezTerm pane ${currentPaneId}. ` +
				"Use the wezterm_pane tool to manage panes: split, close, focus, zoom, resize, " +
				'send/read text, or spawn new tabs. Use action "list" to see panes in the current tab.',
		};
	});
}
