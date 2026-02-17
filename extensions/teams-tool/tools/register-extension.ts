/**
 * Teams-tool runtime registration and lifecycle wiring.
 *
 * This module contains the extension runtime implementation so `index.ts`
 * can remain a thin composition root and compatibility export surface.
 */

/**
 * Teams Extension — Multi-agent coordination with shared state
 *
 * Spawns persistent teammate sessions (via SDK createAgentSession) that share
 * an in-memory task board and can message each other directly — no hub-and-spoke
 * bottleneck. Teammates auto-wake on incoming messages.
 *
 * Main-agent tools: team_create, team_add_tasks, team_spawn, team_send, team_status, team_shutdown, team_resume
 * Teammate tools (injected): team_tasks, team_message, team_inbox
 *
 * Pure logic (store, tasks, messages) lives in store.ts for testability.
 * Domain modules: state/, dispatch/, sessions/, dashboard/, tools/
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, Loader, Text, type TUI } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { INTEROP_EVENT_NAMES, onInteropEvent } from "../../_shared/interop-events.js";
import {
	appendDashboardFeedEvent,
	bindDashboardSessionTracking,
	buildDashboardSnapshot,
	getDashboardActivity,
	notifyDashboardChanged,
	notifyTeamViewChanged,
	publishDashboardState,
	publishTeamSnapshots,
	refreshTeamView,
	removeTeamView,
	setDashboardActiveState,
	setDashboardRenderCallback,
	setInteropEvents,
} from "../dashboard/state.js";
import { resolveDashboardCommand, TeamDashboardEditor } from "../dashboard.js";
import { wakeTeammate } from "../dispatch/auto-dispatch.js";
import { spawnTeammateSession } from "../sessions/spawn.js";
import { getLastOutput, getRuntimeTeam } from "../state/team-view.js";
import type { Teammate } from "../state/types.js";
import {
	addTaskToBoard,
	addTeamMessage,
	archiveTeam,
	createTeamStore,
	formatArchivedTeamStatus,
	formatTeamStatus,
	getArchivedTeams,
	getTeams,
	restoreArchivedTeam,
	type Team,
	type TeamTask,
} from "../store.js";

/**
 * Register the teams-tool runtime: commands, tools, dashboard UI, and lifecycle hooks.
 *
 * @param pi - Extension API used to register tools, commands, and event handlers
 * @returns void
 */
export function registerTeamsToolExtension(pi: ExtensionAPI): void {
	setInteropEvents(pi.events);
	let cwd = process.cwd();
	let dashboardCancelInFlight = false;
	let dashboardEnabled = false;
	let dashboardTicker: ReturnType<typeof setInterval> | undefined;
	let dashboardTui: TUI | undefined;
	let interopStateRequestCleanup: (() => void) | undefined;

	interopStateRequestCleanup?.();
	interopStateRequestCleanup = onInteropEvent(pi.events, INTEROP_EVENT_NAMES.stateRequest, () => {
		publishTeamSnapshots();
		publishDashboardState();
	});

	/**
	 * Publish dashboard-active state for cross-extension UI coordination.
	 * @param enabled - Whether dashboard workspace is currently active
	 * @returns void
	 */
	function setDashboardFlag(enabled: boolean): void {
		setDashboardActiveState(enabled);
		publishDashboardState();
		notifyTeamViewChanged();
	}

	/**
	 * Enter alternate-screen viewport for dashboard mode.
	 * @param tui - Active TUI instance
	 * @returns void
	 */
	function enterDashboardViewport(tui: TUI): void {
		dashboardTui = tui;
		const terminal = dashboardTui.terminal as {
			enterAlternateScreen?: () => void;
			write: (data: string) => void;
		};
		if (typeof terminal.enterAlternateScreen === "function") {
			terminal.enterAlternateScreen();
		} else {
			terminal.write("\x1b[?1049h");
		}
		// Enable xterm mouse tracking + SGR extended mouse coordinates.
		terminal.write("\x1b[?1000h\x1b[?1006h");
		dashboardTui.requestRender(true);
	}

	/**
	 * Leave alternate-screen viewport and restore normal editor rendering.
	 * @returns void
	 */
	function leaveDashboardViewport(): void {
		if (!dashboardTui) return;
		const terminal = dashboardTui.terminal as {
			leaveAlternateScreen?: () => void;
			write: (data: string) => void;
		};
		// Disable mouse tracking before restoring normal viewport.
		terminal.write("\x1b[?1000l\x1b[?1006l");
		if (typeof terminal.leaveAlternateScreen === "function") {
			terminal.leaveAlternateScreen();
		} else {
			terminal.write("\x1b[?1049l");
		}
		dashboardTui.requestRender(true);
		dashboardTui = undefined;
	}

	/**
	 * Start periodic dashboard refresh ticks for animated glyphs and live telemetry.
	 * @returns void
	 */
	function startDashboardTicker(): void {
		if (dashboardTicker) return;
		dashboardTicker = setInterval(() => {
			if (!dashboardEnabled) return;
			notifyDashboardChanged();
		}, 250);
	}

	/**
	 * Stop periodic dashboard refresh ticks.
	 * @returns void
	 */
	function stopDashboardTicker(): void {
		if (!dashboardTicker) return;
		clearInterval(dashboardTicker);
		dashboardTicker = undefined;
	}

	/**
	 * Abort all teammates that are currently streaming work.
	 * @returns Number of teammates that received an abort request
	 */
	async function abortRunningTeammates(): Promise<number> {
		const running: Array<{ teammate: Teammate; team: Team<Teammate> }> = [];
		for (const [, team] of getTeams() as Map<string, Team<Teammate>>) {
			for (const [, teammate] of team.teammates) {
				if (teammate.status !== "working" && !teammate.session.isStreaming) continue;
				running.push({ teammate, team });
			}
		}
		if (running.length === 0) return 0;

		await Promise.all(
			running.map(async ({ teammate }) => {
				try {
					await teammate.session.abort();
				} catch {
					// Best-effort abort.
				}
			})
		);

		const touchedTeams = new Set<Team<Teammate>>();
		const dashboardActivity = getDashboardActivity();
		for (const { teammate, team } of running) {
			if (teammate.status === "working") teammate.status = "idle";
			dashboardActivity.touch(team.name, teammate.name);
			appendDashboardFeedEvent(team.name, "orchestrator", teammate.name, "Cancelled run.");
			touchedTeams.add(team);
		}
		for (const team of touchedTeams) refreshTeamView(team);
		notifyDashboardChanged();
		return running.length;
	}

	/**
	 * Handle Esc inside dashboard: cancel active work first, then close dashboard.
	 * @param ctx - Extension context
	 * @returns void
	 */
	function handleDashboardEscape(ctx: ExtensionContext): void {
		if (dashboardCancelInFlight) return;
		void (async () => {
			dashboardCancelInFlight = true;
			try {
				const cancelled = await abortRunningTeammates();
				if (cancelled > 0) {
					ctx.ui.notify(
						`Cancelled ${cancelled} running teammate${cancelled === 1 ? "" : "s"}. Press Esc again to close dashboard.`,
						"warning"
					);
					return;
				}
				if (!dashboardEnabled) return;
				disableDashboard(ctx, false);
				ctx.ui.notify("Team dashboard disabled.", "info");
			} finally {
				dashboardCancelInFlight = false;
			}
		})();
	}

	/**
	 * Enable dashboard mode by swapping in the dashboard editor component.
	 * @param ctx - Extension context
	 * @returns void
	 */
	function enableDashboard(ctx: ExtensionContext): void {
		dashboardEnabled = true;
		setDashboardFlag(true);
		startDashboardTicker();
		ctx.ui.setWorkingMessage(Loader.HIDE);
		ctx.ui.setStatus("team-dashboard", "Team dashboard active");
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			enterDashboardViewport(tui);
			const editor = new TeamDashboardEditor(tui, editorTheme, keybindings, {
				getSnapshot: buildDashboardSnapshot,
				theme: ctx.ui.theme,
				onEscape: () => {
					if (!dashboardEnabled) return;
					handleDashboardEscape(ctx);
				},
				onExit: () => {
					if (!dashboardEnabled) return;
					disableDashboard(ctx, false);
					ctx.ui.notify("Team dashboard disabled.", "info");
				},
			});
			setDashboardRenderCallback(() => editor.refresh());
			return editor;
		});
		notifyDashboardChanged();
	}

	/**
	 * Disable dashboard mode and restore the default editor component.
	 * @param ctx - Extension context
	 * @param notify - Whether to notify the user about the state transition
	 * @returns void
	 */
	function disableDashboard(ctx: ExtensionContext, notify = true): void {
		dashboardCancelInFlight = false;
		dashboardEnabled = false;
		stopDashboardTicker();
		setDashboardRenderCallback(undefined);
		setDashboardFlag(false);
		leaveDashboardViewport();
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setWorkingMessage();
		ctx.ui.setStatus("team-dashboard", undefined);
		if (notify) ctx.ui.notify("Team dashboard disabled.", "info");
	}

	/**
	 * Transition dashboard mode to the requested enabled state.
	 * @param ctx - Extension context
	 * @param enabled - Requested dashboard enabled state
	 * @param notify - Whether to notify the user
	 * @returns void
	 */
	function setDashboardEnabledState(ctx: ExtensionContext, enabled: boolean, notify = true): void {
		if (!ctx.hasUI) return;
		if (enabled) {
			if (!dashboardEnabled) enableDashboard(ctx);
			if (notify) ctx.ui.notify("Team dashboard enabled.", "info");
			return;
		}
		if (dashboardEnabled) disableDashboard(ctx, notify);
	}

	// ─── Event handlers ─────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		publishTeamSnapshots();
		publishDashboardState();
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!dashboardEnabled || !ctx.hasUI) return;
		ctx.ui.setWorkingMessage(Loader.HIDE);
	});

	// Archive all teams on session shutdown (preserves tasks for future recovery)
	pi.on("session_shutdown", async () => {
		for (const [name, team] of getTeams() as Map<string, Team<Teammate>>) {
			for (const [, mate] of team.teammates) {
				try {
					if (mate.session.isStreaming) await mate.session.abort();
					mate.unsubscribe?.();
					mate.session.dispose();
				} catch (err) {
					console.error(`Failed to clean up teammate ${mate.name}: ${err}`);
				}
				mate.status = "shutdown";
			}
			removeTeamView(name);
			archiveTeam(name);
		}
		dashboardCancelInFlight = false;
		dashboardEnabled = false;
		stopDashboardTicker();
		setDashboardRenderCallback(undefined);
		setDashboardFlag(false);
		leaveDashboardViewport();
		publishTeamSnapshots();
		interopStateRequestCleanup?.();
		interopStateRequestCleanup = undefined;
	});

	// Clean up finished teams on agent turn end.
	// Teams with active background work survive across turns — they keep
	// running while the user reads the response or types a new message.
	// Only teams where all teammates have finished are archived.
	// Full cleanup (including active teams) happens on session_shutdown.
	pi.on("agent_end", async () => {
		for (const [name, team] of getTeams() as Map<string, Team<Teammate>>) {
			const hasActiveWork = [...team.teammates.values()].some((m) => m.status === "working");
			if (hasActiveWork) continue;

			// All teammates finished — clean up and archive
			for (const [, mate] of team.teammates) {
				if (mate.status === "idle") {
					try {
						mate.unsubscribe?.();
						mate.session.dispose();
					} catch {
						// Best-effort cleanup
					}
					mate.status = "shutdown";
				}
			}
			removeTeamView(name);
			archiveTeam(name);
		}
	});

	// ─── Commands and shortcuts ─────────────────────────────────

	pi.registerCommand("team-dashboard", {
		description: "Toggle the Team Dashboard workspace (/team-dashboard [on|off|status])",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const resolution = resolveDashboardCommand(dashboardEnabled, args);
			if (resolution.isError) {
				ctx.ui.notify(resolution.message, "error");
				return;
			}
			if (resolution.action !== "status") {
				setDashboardEnabledState(ctx, resolution.nextEnabled, false);
			}
			ctx.ui.notify(resolution.message, "info");
		},
	});

	pi.registerShortcut(Key.ctrl("x"), {
		description: "Toggle Team Dashboard workspace",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			setDashboardEnabledState(ctx, !dashboardEnabled);
		},
	});

	// ─── team_create ────────────────────────────────────────────

	pi.registerTool({
		name: "team_create",
		label: "team_create",
		description: "Create a new agent team with a shared task board and inter-agent messaging.",
		parameters: Type.Object({
			name: Type.String({ description: "Team name (unique)" }),
		}),
		async execute(_toolCallId, params) {
			if (getTeams().has(params.name)) {
				return {
					content: [{ type: "text", text: `Team "${params.name}" already exists.` }],
					details: {},
					isError: true,
				};
			}
			createTeamStore(params.name);
			appendDashboardFeedEvent(params.name, "orchestrator", "all", `Team "${params.name}" created`);
			notifyDashboardChanged();
			return {
				content: [
					{
						type: "text",
						text: `Team "${params.name}" created. Add tasks with team_add_tasks, then spawn teammates with team_spawn.`,
					},
				],
				details: {},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_create ")) + theme.fg("accent", args.name || "..."),
				0,
				0
			);
		},
		renderResult(result, _opts, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const isErr = text.includes("already exists");
			return new Text(theme.fg(isErr ? "error" : "success", text), 0, 0);
		},
	});

	// ─── team_add_tasks ─────────────────────────────────────────

	pi.registerTool({
		name: "team_add_tasks",
		label: "team_add_tasks",
		description:
			"Add tasks to a team's shared board. Tasks can depend on other tasks (blockedBy). Blocked tasks become ready when all blockers complete.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
			tasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "Task title" }),
					description: Type.Optional(Type.String({ description: "Detailed description" })),
					blockedBy: Type.Optional(
						Type.Array(Type.String(), { description: "Task IDs that must complete first" })
					),
				})
			),
		}),
		async execute(_toolCallId, params) {
			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}

			const added: TeamTask[] = [];
			for (const t of params.tasks) {
				added.push(addTaskToBoard(team, t.title, t.description || "", t.blockedBy || []));
			}

			const lines = added.map(
				(t) =>
					`#${t.id}: ${t.title}${t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : ""}`
			);
			refreshTeamView(team);
			appendDashboardFeedEvent(
				team.name,
				"orchestrator",
				"all",
				`Added ${added.length} task${added.length === 1 ? "" : "s"}`
			);
			return {
				content: [{ type: "text", text: `Added ${added.length} task(s):\n${lines.join("\n")}` }],
				details: {},
			};
		},
		renderCall(args, theme) {
			const count = args.tasks?.length || 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("team_add_tasks ")) +
					theme.fg("accent", args.team || "...") +
					theme.fg("dim", ` (${count} task${count !== 1 ? "s" : ""})`),
				0,
				0
			);
		},
	});

	// ─── team_spawn ─────────────────────────────────────────────

	pi.registerTool({
		name: "team_spawn",
		label: "team_spawn",
		description: [
			"Spawn a teammate with their own agent session, shared task board access, and inter-agent messaging.",
			"They get standard coding tools plus team coordination tools.",
			"After spawning, use team_send to give them initial instructions.",
		].join(" "),
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
			name: Type.String({ description: "Teammate name (unique within team)" }),
			role: Type.String({ description: "Role/description (guides their behavior)" }),
			model: Type.Optional(
				Type.String({
					description:
						"Explicit model ID (fuzzy matched). When omitted, auto-routes based on role complexity.",
				})
			),
			modelScope: Type.Optional(
				Type.String({
					description:
						'Constrain auto-routing to a model family (e.g. "codex", "gemini"). Ignored when explicit model is set.',
				})
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Standard tool names: read, bash, edit, write, grep, find, ls. Default: all coding tools.",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}
			if (team.teammates.has(params.name)) {
				return {
					content: [
						{
							type: "text",
							text: `Teammate "${params.name}" already exists in team "${params.team}".`,
						},
					],
					details: {},
					isError: true,
				};
			}

			try {
				const mate = await spawnTeammateSession(
					cwd,
					team,
					params.name,
					params.role,
					params.model,
					params.tools,
					pi.events,
					params.modelScope ? { modelScope: params.modelScope } : undefined,
					ctx?.model?.id
				);
				mate.unsubscribe = bindDashboardSessionTracking(team.name, mate.name, mate.session);
				const dashboardActivity = getDashboardActivity();
				dashboardActivity.touch(team.name, mate.name);
				notifyDashboardChanged();
				refreshTeamView(team);
				appendDashboardFeedEvent(
					team.name,
					"orchestrator",
					"all",
					`Spawned @${params.name} (${mate.model})`
				);
				return {
					content: [
						{
							type: "text",
							text: `Spawned "${params.name}" (${mate.model}). Status: idle. Use team_send to give instructions.`,
						},
					],
					details: {},
				};
				// biome-ignore lint/suspicious/noExplicitAny: catch clause
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to spawn "${params.name}": ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_spawn ")) +
					theme.fg("accent", args.name || "...") +
					theme.fg("dim", ` → ${args.team || "..."}`) +
					(args.model ? theme.fg("muted", ` (${args.model})`) : ""),
				0,
				0
			);
		},
	});

	// ─── team_send ──────────────────────────────────────────────

	pi.registerTool({
		name: "team_send",
		label: "team_send",
		description: [
			"Send a message to a teammate. If idle, wakes them up.",
			"Set wait=true to block until the teammate finishes processing.",
			"Without wait, returns immediately (teammate works in background).",
		].join(" "),
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
			to: Type.String({ description: "Teammate name" }),
			message: Type.String({ description: "Message / instruction" }),
			wait: Type.Optional(
				Type.Boolean({ description: "Block until teammate finishes responding (default: false)" })
			),
		}),
		async execute(_toolCallId, params, signal) {
			// Fast-path: already aborted before we start
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "team_send was cancelled before execution." }],
					details: {},
					isError: true,
				};
			}

			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}

			const mate = team.teammates.get(params.to);
			if (!mate) {
				return {
					content: [
						{ type: "text", text: `Teammate "${params.to}" not found in team "${params.team}".` },
					],
					details: {},
					isError: true,
				};
			}

			if (mate.status === "shutdown" || mate.status === "error") {
				return {
					content: [
						{
							type: "text",
							text: `Teammate "${params.to}" is ${mate.status}${mate.error ? `: ${mate.error}` : ""}.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			addTeamMessage(team, "orchestrator", params.to, params.message);
			appendDashboardFeedEvent(team.name, "orchestrator", params.to, params.message);

			const prompt = `Message from orchestrator: ${params.message}`;

			if (params.wait) {
				const dashboardActivity = getDashboardActivity();
				// Propagate abort signal to teammate
				const abortHandler = () => {
					mate.session.abort().catch(() => {});
				};
				signal?.addEventListener("abort", abortHandler, { once: true });

				try {
					// Build an abort promise that rejects when the signal fires.
					// This lets Promise.race unblock immediately on cancellation,
					// even if mate.session.prompt() swallows the abort internally.
					const abortPromise = new Promise<never>((_, reject) => {
						if (signal?.aborted) {
							reject(new DOMException("team_send aborted", "AbortError"));
							return;
						}
						signal?.addEventListener(
							"abort",
							() => reject(new DOMException("team_send aborted", "AbortError")),
							{ once: true }
						);
					});

					if (mate.session.isStreaming) {
						// Already working — queue as followUp, then wait for idle
						dashboardActivity.touch(team.name, mate.name);
						notifyDashboardChanged();
						await mate.session.followUp(prompt);
						await Promise.race([mate.session.agent.waitForIdle(), abortPromise]);
					} else {
						mate.status = "working";
						dashboardActivity.touch(team.name, mate.name);
						refreshTeamView(team);
						await Promise.race([mate.session.prompt(prompt), abortPromise]);
					}
					mate.status = "idle";
					dashboardActivity.touch(team.name, mate.name);
					refreshTeamView(team);

					const output = getLastOutput(mate.session);
					return {
						content: [{ type: "text", text: `@${params.to} responded:\n\n${output}` }],
						details: {},
					};
					// biome-ignore lint/suspicious/noExplicitAny: catch clause
				} catch (err: any) {
					if (signal?.aborted) {
						// Abort path: return error result so the orchestrator's agent
						// loop can proceed to its normal abort/end flow. Don't mark
						// the teammate as error — agent_end cleanup will handle it.
						return {
							content: [{ type: "text", text: `team_send to "${params.to}" was cancelled.` }],
							details: {},
							isError: true,
						};
					}
					mate.status = "error";
					mate.error = String(err);
					dashboardActivity.touch(team.name, mate.name);
					refreshTeamView(team);
					return {
						content: [{ type: "text", text: `Teammate "${params.to}" errored: ${err.message}` }],
						details: {},
						isError: true,
					};
				} finally {
					signal?.removeEventListener("abort", abortHandler);
				}
			}

			// Fire-and-forget
			wakeTeammate(mate, prompt, team.name, pi.events);
			refreshTeamView(team);
			return {
				content: [{ type: "text", text: `Message sent to ${params.to} (status: ${mate.status}).` }],
				details: {},
			};
		},
		renderCall(args, theme) {
			const preview =
				args.message?.length > 60 ? `${args.message.slice(0, 60)}...` : args.message || "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("team_send ")) +
					theme.fg("accent", `→ ${args.to || "..."}`) +
					(args.wait ? theme.fg("warning", " (wait)") : "") +
					"\n  " +
					theme.fg("dim", preview),
				0,
				0
			);
		},
	});

	// ─── team_status ────────────────────────────────────────────

	pi.registerTool({
		name: "team_status",
		label: "team_status",
		description: "Get team overview: task board, teammate states, and recent messages.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
		}),
		async execute(_toolCallId, params) {
			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}

			return { content: [{ type: "text", text: formatTeamStatus(team) }], details: {} };
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_status ")) + theme.fg("accent", args.team || "..."),
				0,
				0
			);
		},
	});

	// ─── team_shutdown ──────────────────────────────────────────

	pi.registerTool({
		name: "team_shutdown",
		label: "team_shutdown",
		description: "Shutdown a team. Aborts all running teammates and cleans up sessions.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
		}),
		async execute(_toolCallId, params) {
			const team = getRuntimeTeam(params.team);
			if (!team) {
				return {
					content: [{ type: "text", text: `Team "${params.team}" not found.` }],
					details: {},
					isError: true,
				};
			}

			let count = 0;
			for (const [, mate] of team.teammates) {
				try {
					if (mate.session.isStreaming) await mate.session.abort();
					mate.unsubscribe?.();
					mate.session.dispose();
					mate.status = "shutdown";
					count++;
				} catch (err) {
					console.error(`Failed to clean up teammate ${mate.name}: ${err}`);
					mate.status = "shutdown";
					count++;
				}
			}

			removeTeamView(params.team);
			archiveTeam(params.team);
			return {
				content: [
					{
						type: "text",
						text: `Team "${params.team}" shutdown. ${count} teammate${count !== 1 ? "s" : ""} terminated, task list archived. Use team_resume to restore.`,
					},
				],
				details: {},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_shutdown ")) + theme.fg("error", args.team || "..."),
				0,
				0
			);
		},
		renderResult(result, _opts, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg("warning", text), 0, 0);
		},
	});

	// ─── team_resume ────────────────────────────────────────────

	pi.registerTool({
		name: "team_resume",
		label: "team_resume",
		description:
			"Restore an archived team and its task board. Lists archived teams when called without a name. " +
			"The restored team has no teammates — spawn new ones to continue work on remaining tasks.",
		parameters: Type.Object({
			team: Type.Optional(
				Type.String({
					description: "Archived team name to restore. Omit to list available archives.",
				})
			),
		}),
		async execute(_toolCallId, params) {
			// List mode — show all archived teams
			if (!params.team) {
				const archives = getArchivedTeams();
				if (archives.size === 0) {
					return {
						content: [{ type: "text", text: "No archived teams available." }],
						details: {} as Record<string, unknown>,
					};
				}
				const lines = ["# Archived Teams\n"];
				for (const [, arch] of archives) {
					lines.push(formatArchivedTeamStatus(arch));
					lines.push("");
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { count: archives.size } as Record<string, unknown>,
				};
			}

			// Restore mode
			if (getTeams().has(params.team)) {
				return {
					content: [
						{
							type: "text",
							text: `Team "${params.team}" is already active. Use team_status to inspect it.`,
						},
					],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			const restored = restoreArchivedTeam(params.team);
			if (!restored) {
				const available = Array.from(getArchivedTeams().keys());
				const hint =
					available.length > 0
						? ` Available: ${available.join(", ")}`
						: " No archived teams available.";
				return {
					content: [{ type: "text", text: `No archived team "${params.team}" found.${hint}` }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			const completed = restored.tasks.filter((t) => t.status === "completed").length;
			const remaining = restored.tasks.length - completed;
			const failed = restored.tasks.filter((t) => t.status === "failed").length;

			// Reset claimed tasks back to pending (their agents are gone)
			for (const task of restored.tasks) {
				if (task.status === "claimed") {
					task.status = "pending";
					task.assignee = null;
				}
			}

			notifyDashboardChanged();
			return {
				content: [
					{
						type: "text",
						text:
							`Team "${params.team}" restored. ${restored.tasks.length} tasks: ${completed} completed` +
							(failed > 0 ? `, ${failed} failed` : "") +
							`, ${remaining} remaining.\n` +
							"Spawn teammates with team_spawn to continue work.",
					},
				],
				details: { tasks: restored.tasks.length, completed, remaining, failed } as Record<
					string,
					unknown
				>,
			};
		},
		renderCall(args, theme) {
			const label = args.team || "(list)";
			return new Text(
				theme.fg("toolTitle", theme.bold("team_resume ")) + theme.fg("accent", label),
				0,
				0
			);
		},
		renderResult(result, _opts, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const isErr = "isError" in result && result.isError;
			return new Text(theme.fg(isErr ? "error" : "success", text), 0, 0);
		},
	});
}
