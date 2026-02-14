/**
 * Teammate tool definitions — coordination tools injected into each teammate session.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../../_icons/index.js";
import { appendDashboardFeedEvent, refreshTeamView } from "../dashboard/state.js";
import { autoDispatch, wakeTeammate } from "../dispatch/auto-dispatch.js";
import type { Teammate } from "../state/types.js";
import { addTeamMessage, getUnread, isTaskReady, markRead, type Team } from "../store.js";

/**
 * Create the team coordination tools for a specific teammate.
 * These close over the shared Team object.
 * @param team - The team this teammate belongs to
 * @param myName - This teammate's name
 * @param piEvents - Event emitter for lifecycle events
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
				appendDashboardFeedEvent(team.name, myName, "all", `Claimed #${task.id}: ${task.title}`);
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
				appendDashboardFeedEvent(team.name, myName, "all", `Completed #${task.id}: ${task.title}`);

				return {
					content: [{ type: "text" as const, text: `Completed #${task.id}: ${task.title}` }],
					details: {},
				};
			}

			if (params.action === "fail") {
				task.status = "failed";
				task.result = params.result || "(failed)";
				refreshTeamView(team as Team<Teammate>);
				appendDashboardFeedEvent(team.name, myName, "all", `Failed #${task.id}: ${task.title}`);
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
			appendDashboardFeedEvent(team.name, myName, params.to, params.content);

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
					refreshTeamView(team as Team<Teammate>);
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

			refreshTeamView(team as Team<Teammate>);
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
