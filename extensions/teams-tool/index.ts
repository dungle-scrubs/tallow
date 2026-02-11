/**
 * Teams Extension — Multi-agent coordination with shared state
 *
 * Spawns persistent teammate sessions (via SDK createAgentSession) that share
 * an in-memory task board and can message each other directly — no hub-and-spoke
 * bottleneck. Teammates auto-wake on incoming messages.
 *
 * Main-agent tools: team_create, team_add_tasks, team_spawn, team_send, team_status, team_shutdown
 * Teammate tools (injected): team_tasks, team_message, team_inbox
 *
 * Pure logic (store, tasks, messages) lives in store.ts for testability.
 */

import * as os from "node:os";
import * as path from "node:path";
import { getModels, getProviders, StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ResourceLoader, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	createBashTool,
	createCodingTools,
	createEditTool,
	createExtensionRuntime,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { getIcon } from "../_icons/index.js";
import {
	addTaskToBoard,
	addTeamMessage,
	createTeamStore,
	formatTeamStatus,
	getReadyTasks,
	getTeam,
	getTeammatesByStatus,
	getTeams,
	getUnread,
	isTaskReady,
	markRead,
	type Team,
	type TeamTask,
} from "./store.js";

// Re-export store types and functions so existing imports still work
export {
	addTaskToBoard,
	addTeamMessage,
	createTeamStore,
	formatTeamStatus,
	getReadyTasks,
	getTeam,
	getTeammatesByStatus,
	getTeams,
	getUnread,
	isTaskReady,
	markRead,
	type Team,
	type TeamMessage,
	type TeamTask,
} from "./store.js";

// ════════════════════════════════════════════════════════════════
// Types (extension-layer, depends on AgentSession)
// ════════════════════════════════════════════════════════════════

export interface Teammate {
	name: string;
	role: string;
	model: string;
	session: AgentSession;
	status: "idle" | "working" | "shutdown" | "error";
	error?: string;
	lastActivity?: string;
	unsubscribe?: () => void;
}

// ════════════════════════════════════════════════════════════════
// Global team view (read by tasks extension for widget rendering)
// ════════════════════════════════════════════════════════════════

/** Serializable view of a team for cross-extension widget rendering. */
export interface TeamView {
	name: string;
	tasks: Array<{
		id: string;
		title: string;
		status: string;
		assignee: string | null;
		blockedBy: string[];
	}>;
	teammates: Array<{
		name: string;
		role: string;
		model: string;
		status: string;
		currentTask?: string;
	}>;
}

/**
 * Build a serializable snapshot of a team for widget rendering.
 * @param team - Runtime team with full Teammate objects
 * @returns Lightweight view safe for cross-extension consumption
 */
export function buildTeamView(team: Team<Teammate>): TeamView {
	return {
		name: team.name,
		tasks: team.tasks.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			assignee: t.assignee,
			blockedBy: t.blockedBy,
		})),
		teammates: Array.from(team.teammates.values()).map((m) => ({
			name: m.name,
			role: m.role,
			model: m.model,
			status: m.status,
			currentTask: team.tasks.find((t) => t.assignee === m.name && t.status === "claimed")?.title,
		})),
	};
}

/** Global map of active team views, read by tasks extension. */
const activeTeamViews = new Map<string, TeamView>();
(globalThis as Record<string, unknown>).__piActiveTeams = activeTeamViews;

/**
 * Refresh the global team view snapshot for a given team.
 * Called after any state mutation (task claimed/completed, teammate status change).
 * @param team - Runtime team to snapshot
 */
function refreshTeamView(team: Team<Teammate>): void {
	const hasActive =
		team.tasks.some((t) => t.status !== "completed" && t.status !== "failed") ||
		Array.from(team.teammates.values()).some((m) => m.status === "working");
	if (hasActive) {
		activeTeamViews.set(team.name, buildTeamView(team));
	} else {
		// All done — keep a final snapshot for a brief display, then remove
		activeTeamViews.set(team.name, buildTeamView(team));
	}
}

/**
 * Remove a team from the global view (on shutdown).
 * @param teamName - Team name to remove
 */
function removeTeamView(teamName: string): void {
	activeTeamViews.delete(teamName);
}

// ════════════════════════════════════════════════════════════════
// Model resolution
// ════════════════════════════════════════════════════════════════

/**
 * Resolve a model name to a Model object by searching all providers.
 * @param modelName - Model ID (e.g. "claude-sonnet-4-5")
 * @returns The Model, or undefined if not found
 */
export function findModel(modelName: string) {
	for (const provider of getProviders()) {
		const models = getModels(provider);
		const match = models.find((m) => m.id === modelName);
		if (match) return match;
	}
	return undefined;
}

// ════════════════════════════════════════════════════════════════
// Runtime team accessor (store returns TeammateRecord, runtime uses Teammate)
// ════════════════════════════════════════════════════════════════

/** Type-safe accessor: at runtime, teammates always have a session. */
function getRuntimeTeam(name: string): Team<Teammate> | undefined {
	return getTeam(name) as Team<Teammate> | undefined;
}

// ════════════════════════════════════════════════════════════════
// Tool factory for standard tools from name strings
// ════════════════════════════════════════════════════════════════

// biome-ignore lint/suspicious/noExplicitAny: tool factories have different return types
const TOOL_FACTORIES: Record<string, (cwd: string) => any> = {
	read: createReadTool,
	bash: createBashTool,
	edit: createEditTool,
	write: createWriteTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
};

/**
 * Create standard tool instances from a list of tool name strings.
 * @param cwd - Working directory
 * @param toolNames - Tool names (read, bash, edit, write, grep, find, ls)
 * @returns Array of tool instances
 */
export function resolveStandardTools(cwd: string, toolNames?: string[]) {
	if (!toolNames || toolNames.length === 0) return createCodingTools(cwd);
	return toolNames.filter((n) => TOOL_FACTORIES[n]).map((n) => TOOL_FACTORIES[n](cwd));
}

// ════════════════════════════════════════════════════════════════
// Teammate tools (injected into each teammate session via customTools)
// ════════════════════════════════════════════════════════════════

/**
 * Create the team coordination tools for a specific teammate.
 * These close over the shared Team object.
 * @param team - The team this teammate belongs to
 * @param myName - This teammate's name
 * @returns Array of ToolDefinition objects
 */
export function createTeammateTools(
	team: Team<Teammate>,
	myName: string,
	piEvents?: ExtensionAPI["events"]
): ToolDefinition[] {
	const tasksTool: ToolDefinition = {
		name: "team_tasks",
		label: "Team Tasks",
		description: [
			"Manage the shared task board.",
			"Actions: list (show all), claim (assign to yourself), complete (mark done), fail (mark failed).",
			"taskId required for claim/complete/fail. result text for complete/fail.",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(["list", "claim", "complete", "fail"] as const, { description: "Action" }),
			taskId: Type.Optional(Type.String({ description: "Task ID (for claim/complete/fail)" })),
			result: Type.Optional(
				Type.String({ description: "Result or error text (for complete/fail)" })
			),
		}),
		// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition params inferred from TypeBox schema
		execute: async (_toolCallId: string, params: any) => {
			if (params.action === "list") {
				if (team.tasks.length === 0) {
					return {
						content: [{ type: "text" as const, text: "(no tasks on the board)" }],
						details: {},
					};
				}
				const lines = team.tasks.map((t) => {
					const ready = isTaskReady(team, t);
					const blocked =
						t.blockedBy.length > 0 && t.status === "pending"
							? ` [blocked by: ${t.blockedBy.join(", ")}]`
							: "";
					const assignee = t.assignee ? ` → ${t.assignee}` : "";
					const readyTag = ready ? ` ${getIcon("success")}READY` : "";
					return `#${t.id} [${t.status}] ${t.title}${assignee}${blocked}${readyTag}\n  ${t.description || "(no description)"}`;
				});
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
			}

			if (!params.taskId) {
				return {
					content: [{ type: "text" as const, text: "taskId is required for this action" }],
					details: {},
					isError: true,
				};
			}

			const task = team.tasks.find((t) => t.id === params.taskId);
			if (!task) {
				return {
					content: [{ type: "text" as const, text: `Task #${params.taskId} not found` }],
					details: {},
					isError: true,
				};
			}

			if (params.action === "claim") {
				if (!isTaskReady(team, task)) {
					const blockerStatus = task.blockedBy
						.map((id) => {
							const b = team.tasks.find((t) => t.id === id);
							return `#${id}(${b?.status ?? "??"})`;
						})
						.join(", ");
					return {
						content: [
							{
								type: "text" as const,
								text: `Task #${task.id} not ready. Status: ${task.status}. Blockers: ${blockerStatus}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				task.status = "claimed";
				task.assignee = myName;
				refreshTeamView(team as Team<Teammate>);
				return {
					content: [{ type: "text" as const, text: `Claimed #${task.id}: ${task.title}` }],
					details: {},
				};
			}

			if (params.action === "complete") {
				task.status = "completed";
				task.result = params.result || "(completed)";
				piEvents?.emit("task_completed", {
					team: team.name,
					task_id: task.id,
					task_title: task.title,
					assignee: task.assignee || myName,
					result: task.result,
				});

				// Auto-dispatch: completing a task may unblock others
				autoDispatch(team as Team<Teammate>, piEvents);

				return {
					content: [{ type: "text" as const, text: `Completed #${task.id}: ${task.title}` }],
					details: {},
				};
			}

			if (params.action === "fail") {
				task.status = "failed";
				task.result = params.result || "(failed)";
				refreshTeamView(team as Team<Teammate>);
				return {
					content: [{ type: "text" as const, text: `Failed #${task.id}: ${task.title}` }],
					details: {},
				};
			}

			return {
				content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
				details: {},
				isError: true,
			};
		},
	};

	const messageTool: ToolDefinition = {
		name: "team_message",
		label: "Team Message",
		description:
			"Send a message to another teammate (or 'all' to broadcast). If recipient is idle, they wake up automatically.",
		parameters: Type.Object({
			to: Type.String({ description: "Recipient teammate name, or 'all'" }),
			content: Type.String({ description: "Message content" }),
		}),
		// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition params inferred from TypeBox schema
		execute: async (_toolCallId: string, params: any) => {
			addTeamMessage(team, myName, params.to, params.content);

			// Auto-wake idle recipients
			if (params.to === "all") {
				for (const [name, mate] of team.teammates) {
					if (name !== myName && mate.status === "idle") {
						wakeTeammate(mate, `Broadcast from ${myName}: ${params.content}`, team.name, piEvents);
					}
				}
			} else {
				const recipient = team.teammates.get(params.to);
				if (!recipient) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Teammate "${params.to}" not found. Message stored anyway.`,
							},
						],
						details: {},
					};
				}
				if (recipient.status === "idle") {
					wakeTeammate(recipient, `Message from ${myName}: ${params.content}`, team.name, piEvents);
				}
			}

			return {
				content: [{ type: "text" as const, text: `Message sent to ${params.to}` }],
				details: {},
			};
		},
	};

	const inboxTool: ToolDefinition = {
		name: "team_inbox",
		label: "Team Inbox",
		description: "Check your inbox for unread messages from teammates or the orchestrator.",
		parameters: Type.Object({}),
		execute: async () => {
			const unread = getUnread(team, myName);
			markRead(team, myName);

			if (unread.length === 0) {
				return { content: [{ type: "text" as const, text: "No unread messages." }], details: {} };
			}

			const lines = unread.map((m) => `[${m.from}] ${m.content}`);
			return {
				content: [
					{ type: "text" as const, text: `${unread.length} message(s):\n${lines.join("\n")}` },
				],
				details: {},
			};
		},
	};

	return [tasksTool, messageTool, inboxTool];
}

// ════════════════════════════════════════════════════════════════
// Auto-dispatch: assign ready tasks to idle teammates
// ════════════════════════════════════════════════════════════════

/**
 * Check for ready (unblocked, unclaimed) tasks and idle teammates,
 * then auto-assign and wake them. Called when a task completes
 * (new tasks may unblock) or a teammate goes idle (capacity freed).
 * @param team - Team to dispatch within
 * @param piEvents - Event emitter for lifecycle events
 * @returns Number of tasks dispatched
 */
export function autoDispatch(team: Team<Teammate>, piEvents?: ExtensionAPI["events"]): number {
	const ready = getReadyTasks(team);
	const idle = getTeammatesByStatus(team, "idle");
	let dispatched = 0;

	for (const task of ready) {
		if (idle.length === 0) break;
		const mate = idle.shift();
		if (!mate) break;

		task.status = "claimed";
		task.assignee = mate.name;
		dispatched++;

		const prompt = [
			`Auto-assigned task #${task.id}: ${task.title}`,
			task.description ? `\nDescription: ${task.description}` : "",
			"\nClaim it with team_tasks, do the work, then complete it with a result.",
		].join("");

		wakeTeammate(mate, prompt, team.name, piEvents);
	}

	refreshTeamView(team);
	return dispatched;
}

// ════════════════════════════════════════════════════════════════
// Teammate session lifecycle
// ════════════════════════════════════════════════════════════════

/**
 * Wake an idle teammate by sending them a prompt. If already streaming,
 * queues as a follow-up.
 * @param mate - Teammate to wake
 * @param message - Prompt text
 * @param teamName - Team name for event emission
 * @param piEvents - Event emitter for lifecycle events
 */
export function wakeTeammate(
	mate: Teammate,
	message: string,
	teamName?: string,
	piEvents?: ExtensionAPI["events"]
): void {
	if (mate.status === "shutdown" || mate.status === "error") return;

	if (mate.session.isStreaming) {
		mate.session.followUp(message).catch(() => {});
	} else {
		mate.status = "working";
		mate.session
			.prompt(message)
			.then(() => {
				if (mate.status === "working") {
					mate.status = "idle";
					piEvents?.emit("teammate_idle", {
						team: teamName || "",
						teammate: mate.name,
						role: mate.role,
					});

					// Auto-dispatch: teammate just went idle, check for ready tasks
					const team = getRuntimeTeam(teamName || "");
					if (team) {
						refreshTeamView(team);
						autoDispatch(team, piEvents);
					}
				}
			})
			.catch((err) => {
				mate.status = "error";
				mate.error = String(err);
				const team = getRuntimeTeam(teamName || "");
				if (team) refreshTeamView(team);
			});
	}
}

/**
 * Spawn a teammate as an in-process AgentSession with shared team tools.
 * @param cwd - Working directory
 * @param team - Team to add the teammate to
 * @param name - Teammate name
 * @param role - Role description (becomes system prompt context)
 * @param modelName - Model to use
 * @param toolNames - Standard tool names (defaults to all coding tools)
 * @returns The created Teammate
 * @throws If model not found or session creation fails
 */
export async function spawnTeammateSession(
	cwd: string,
	team: Team<Teammate>,
	name: string,
	role: string,
	modelName: string,
	toolNames?: string[],
	piEvents?: ExtensionAPI["events"]
): Promise<Teammate> {
	const model = findModel(modelName);
	if (!model)
		throw new Error(`Model not found: ${modelName}. Tried providers: ${getProviders().join(", ")}`);

	const authStorage = new AuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);

	const otherNames = Array.from(team.teammates.keys()).filter((n) => n !== name);
	const systemPrompt = [
		`You are "${name}", a teammate in team "${team.name}".`,
		`Your role: ${role}`,
		"",
		"You have team coordination tools in addition to your standard tools:",
		"- team_tasks: List, claim, and complete tasks on the shared board",
		"- team_message: Send messages to other teammates (they auto-wake if idle)",
		"- team_inbox: Check for unread messages from teammates",
		"",
		otherNames.length > 0
			? `Other teammates: ${otherNames.join(", ")}`
			: "You are the first teammate.",
		"",
		"Work autonomously:",
		"1. Check team_tasks to see the board",
		"2. Claim a ready task",
		"3. Do the work using your standard tools",
		"4. Complete the task with a result summary",
		"5. Check inbox or claim the next ready task",
		"",
		"Communicate with teammates via team_message when you need their input.",
	].join("\n");

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const teammateCustomTools = createTeammateTools(team, name, piEvents);

	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(os.tmpdir(), `pi-team-${team.name}-${name}`),
		model,
		thinkingLevel: "off",
		authStorage,
		modelRegistry,
		resourceLoader,
		tools: resolveStandardTools(cwd, toolNames),
		customTools: teammateCustomTools,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 2 },
		}),
	});

	const mate: Teammate = { name, role, model: modelName, session, status: "idle" };
	team.teammates.set(name, mate);
	return mate;
}

/**
 * Extract the last assistant text from a session's messages.
 * @param session - Agent session
 * @returns Last assistant text, or "(no output)"
 */
export function getLastOutput(session: AgentSession): string {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "(no output)";
}

// ════════════════════════════════════════════════════════════════
// Extension entry point
// ════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
	});

	// Cleanup all teams on shutdown
	pi.on("session_shutdown", async () => {
		for (const [name, team] of getTeams() as Map<string, Team<Teammate>>) {
			for (const [, mate] of team.teammates) {
				try {
					if (mate.session.isStreaming) await mate.session.abort();
					mate.session.dispose();
				} catch (err) {
					console.error(`Failed to clean up teammate ${mate.name}: ${err}`);
				}
				mate.status = "shutdown";
			}
			removeTeamView(name);
		}
		getTeams().clear();
	});

	// Kill all team agents on Esc interrupt. Teams are cognitive work
	// tied to the conversation — when the user interrupts, all agent
	// work should stop. This mirrors the subagent-tool behavior.
	pi.on("agent_end", async () => {
		for (const [name, team] of getTeams() as Map<string, Team<Teammate>>) {
			for (const [, mate] of team.teammates) {
				if (mate.status === "working" || mate.status === "idle") {
					try {
						if (mate.session.isStreaming) await mate.session.abort();
						mate.session.dispose();
					} catch {
						// Best-effort cleanup
					}
					mate.status = "shutdown";
				}
			}
			removeTeamView(name);
		}
	});

	// ─── team_create ────────────────────────────────────────────

	pi.registerTool({
		name: "team_create",
		label: "Team Create",
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
		label: "Team Add Tasks",
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
		label: "Team Spawn",
		description: [
			"Spawn a teammate with their own agent session, shared task board access, and inter-agent messaging.",
			"They get standard coding tools plus team coordination tools.",
			"After spawning, use team_send to give them initial instructions.",
		].join(" "),
		parameters: Type.Object({
			team: Type.String({ description: "Team name" }),
			name: Type.String({ description: "Teammate name (unique within team)" }),
			role: Type.String({ description: "Role/description (guides their behavior)" }),
			model: Type.Optional(Type.String({ description: 'Model ID (default: "claude-sonnet-4-5")' })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Standard tool names: read, bash, edit, write, grep, find, ls. Default: all coding tools.",
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
					params.model || "claude-sonnet-4-5",
					params.tools,
					pi.events
				);
				refreshTeamView(team);
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
		label: "Team Send",
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

			const prompt = `Message from orchestrator: ${params.message}`;

			if (params.wait) {
				// Propagate abort signal to teammate
				const abortHandler = () => {
					mate.session.abort().catch(() => {});
				};
				signal?.addEventListener("abort", abortHandler, { once: true });

				try {
					if (mate.session.isStreaming) {
						// Already working — queue as followUp, then wait for idle
						await mate.session.followUp(prompt);
						await mate.session.agent.waitForIdle();
					} else {
						mate.status = "working";
						await mate.session.prompt(prompt);
					}
					mate.status = "idle";

					const output = getLastOutput(mate.session);
					return {
						content: [{ type: "text", text: `@${params.to} responded:\n\n${output}` }],
						details: {},
					};
					// biome-ignore lint/suspicious/noExplicitAny: catch clause
				} catch (err: any) {
					mate.status = "error";
					mate.error = String(err);
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
		label: "Team Status",
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
		label: "Team Shutdown",
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
			getTeams().delete(params.team);
			return {
				content: [
					{
						type: "text",
						text: `Team "${params.team}" shutdown. ${count} teammate${count !== 1 ? "s" : ""} terminated, task list deleted.`,
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
}
