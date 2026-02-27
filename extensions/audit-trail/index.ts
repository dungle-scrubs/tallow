/**
 * Audit Trail Extension — pharma-grade, immutable event logging.
 *
 * Subscribes to all Pi lifecycle events and EventBus events, recording
 * each into an append-only, hash-chained JSONL file. Provides /audit
 * commands for inspection and an audit_inspect tool for agent queries.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { setPermissionAuditCallback } from "../_shared/permissions.js";
import { setShellAuditCallback } from "../_shared/shell-policy.js";
import { getTallowSettingsPath } from "../_shared/tallow-paths.js";
import { type AuditTrailLogger, getOrCreateAuditLogger } from "./logger.js";
import { exportAuditTrail, listAuditFiles, queryAuditTrail, verifyIntegrity } from "./query.js";
import type { AuditCategory, AuditQueryOptions, AuditTrailConfig } from "./types.js";

/**
 * Read audit trail config from settings.json files.
 *
 * Supports both short and expanded forms:
 *   { "auditTrail": false }
 *   { "auditTrail": { "enabled": true, "redactSensitive": false, "directory": "/custom/path", "excludeCategories": ["turn"] } }
 *
 * Checks project `.tallow/settings.json` first (if it exists), then global `~/.tallow/settings.json`.
 * The first file with an `auditTrail` key wins.
 *
 * @param cwd - Current working directory
 * @returns Partial config from settings, or empty object if not configured
 */
function readAuditTrailSettings(cwd: string): Partial<AuditTrailConfig> {
	const paths = [join(cwd, ".tallow", "settings.json"), getTallowSettingsPath()];

	for (const settingsPath of paths) {
		if (!existsSync(settingsPath)) continue;
		try {
			const raw = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(raw) as {
				auditTrail?: boolean | Partial<AuditTrailConfig>;
			};

			if (settings.auditTrail === undefined) continue;

			if (typeof settings.auditTrail === "boolean") {
				return { enabled: settings.auditTrail };
			}

			if (typeof settings.auditTrail === "object" && settings.auditTrail !== null) {
				return settings.auditTrail;
			}
		} catch {
			// skip malformed settings files
		}
	}

	return {};
}

export default function (pi: ExtensionAPI): void {
	let logger: AuditTrailLogger | null = null;

	// ── Session lifecycle — initialize logger ────────────────────

	pi.on("session_start", async (_event, context) => {
		const sessionId = context.sessionManager.getSessionId();

		// Load config from settings.json (project-local then global)
		const settingsConfig = readAuditTrailSettings(context.cwd);
		const config: Partial<AuditTrailConfig> = {
			enabled: settingsConfig.enabled ?? true,
			redactSensitive: settingsConfig.redactSensitive ?? true,
			directory: settingsConfig.directory,
			excludeCategories: settingsConfig.excludeCategories,
		};

		logger = getOrCreateAuditLogger(sessionId, config);

		// If disabled via settings, skip all event wiring
		if (!config.enabled) return;

		logger.record({
			category: "session",
			event: "session_start",
			actor: "system",
			data: { cwd: context.cwd, sessionId },
		});

		// Wire up shell audit callback
		setShellAuditCallback((entry) => {
			logger?.record({
				category: "shell_policy",
				event: entry.outcome === "blocked" ? "policy_blocked" : "shell_command",
				actor: entry.trustLevel === "explicit" ? "user" : "system",
				data: {
					command: entry.command,
					source: entry.source,
					trustLevel: entry.trustLevel,
					cwd: entry.cwd,
					exitCode: entry.exitCode,
					durationMs: entry.durationMs,
				},
				outcome: entry.outcome,
				reason: entry.reason,
			});
		});

		// Wire up permission audit callback
		setPermissionAuditCallback((toolName, input, verdict) => {
			logger?.record({
				category: "permission",
				event: "permission_evaluated",
				actor: "system",
				data: {
					toolName,
					input,
					action: verdict.action,
					reasonCode: verdict.reasonCode,
					matchedRule: verdict.matchedRule,
				},
				outcome: verdict.allowed ? "allowed" : "blocked",
				reason: verdict.reason,
			});
		});

		// Clean up previous EventBus listeners on reload
		const G = globalThis as Record<string, unknown>;
		if (G.__auditTrailEventCleanup) {
			(G.__auditTrailEventCleanup as () => void)();
		}

		// Register EventBus listeners
		const unsubs: Array<() => void> = [];

		const busEvents: Array<{ name: string; category: AuditCategory; actor: string }> = [
			{ name: "subagent_start", category: "agent", actor: "system" },
			{ name: "subagent_stop", category: "agent", actor: "system" },
			{ name: "teammate_idle", category: "agent", actor: "subagent" },
			{ name: "task_completed", category: "agent", actor: "subagent" },
			{ name: "worktree_create", category: "session", actor: "system" },
			{ name: "worktree_remove", category: "session", actor: "system" },
			{ name: "notification", category: "session", actor: "system" },
			{ name: "hooks:merge", category: "hook", actor: "system" },
			{ name: "audit:hook_execution", category: "hook", actor: "hook" },
		];

		for (const { name, category, actor } of busEvents) {
			const unsub = pi.events.on(name, (payload: unknown) => {
				logger?.record({
					category,
					event: name,
					actor: actor as "user" | "agent" | "hook" | "system" | "subagent",
					data: (payload && typeof payload === "object" ? payload : { payload }) as Record<
						string,
						unknown
					>,
				});
			});
			unsubs.push(unsub);
		}

		G.__auditTrailEventCleanup = () => {
			for (const unsub of unsubs) unsub();
		};
	});

	pi.on("session_shutdown", async () => {
		logger?.record({
			category: "session",
			event: "session_shutdown",
			actor: "system",
			data: { seq: logger.getSeq() },
		});

		// Disconnect callbacks
		setShellAuditCallback(null);
		setPermissionAuditCallback(null);
	});

	// ── Session management events ────────────────────────────────

	const sessionManagementHandler = (eventName: string) => async (event: unknown) => {
		logger?.record({
			category: "session",
			event: eventName,
			actor: "system",
			data: (event && typeof event === "object" ? event : {}) as Record<string, unknown>,
		});
	};

	pi.on("session_compact", sessionManagementHandler("session_compact"));
	pi.on("session_before_compact", sessionManagementHandler("session_before_compact"));
	pi.on("session_switch", sessionManagementHandler("session_switch"));
	pi.on("session_before_switch", sessionManagementHandler("session_before_switch"));
	pi.on("session_fork", sessionManagementHandler("session_fork"));
	pi.on("session_before_fork", sessionManagementHandler("session_before_fork"));
	pi.on("session_tree", sessionManagementHandler("session_tree"));
	pi.on("session_before_tree", sessionManagementHandler("session_before_tree"));

	// ── Tool events ──────────────────────────────────────────────

	pi.on("tool_call", async (event) => {
		logger?.record({
			category: "tool",
			event: "tool_call",
			actor: "agent",
			data: {
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				input: event.input,
			},
		});
	});

	pi.on("tool_result", async (event) => {
		logger?.record({
			category: "tool",
			event: "tool_result",
			actor: "agent",
			data: {
				toolName: event.toolName,
				toolCallId: event.toolCallId,
			},
		});
	});

	pi.on("user_bash", async (event) => {
		logger?.record({
			category: "tool",
			event: "user_bash",
			actor: "user",
			data: (event && typeof event === "object" ? event : {}) as Record<string, unknown>,
		});
	});

	// ── Turn events ──────────────────────────────────────────────

	pi.on("turn_start", async () => {
		logger?.record({
			category: "turn",
			event: "turn_start",
			actor: "system",
			data: {},
		});
	});

	pi.on("turn_end", async () => {
		logger?.record({
			category: "turn",
			event: "turn_end",
			actor: "system",
			data: {},
		});
	});

	// ── Agent events ─────────────────────────────────────────────

	pi.on("agent_start", async (event) => {
		logger?.record({
			category: "agent",
			event: "agent_start",
			actor: "system",
			data: (event && typeof event === "object" ? event : {}) as Record<string, unknown>,
		});
	});

	pi.on("agent_end", async (event) => {
		logger?.record({
			category: "agent",
			event: "agent_end",
			actor: "system",
			data: (event && typeof event === "object" ? event : {}) as Record<string, unknown>,
		});
	});

	pi.on("before_agent_start", async (event) => {
		logger?.record({
			category: "agent",
			event: "before_agent_start",
			actor: "system",
			data: (event && typeof event === "object" ? event : {}) as Record<string, unknown>,
		});
	});

	// ── Input/Model events ───────────────────────────────────────

	pi.on("input", async (event) => {
		logger?.record({
			category: "input",
			event: "input",
			actor: "user",
			data: (event && typeof event === "object" ? event : {}) as Record<string, unknown>,
		});
	});

	pi.on("model_select", async (event) => {
		logger?.record({
			category: "model",
			event: "model_select",
			actor: "system",
			data: (event && typeof event === "object" ? event : {}) as Record<string, unknown>,
		});
	});

	pi.on("context", async (event) => {
		logger?.record({
			category: "session",
			event: "context",
			actor: "system",
			data: (event && typeof event === "object" ? event : {}) as Record<string, unknown>,
		});
	});

	// ── /audit commands ──────────────────────────────────────────

	pi.registerCommand("audit", {
		description: "Audit trail: /audit [tail N | verify | verify-all | files | export [format]]",
		handler: async (args, ctx) => {
			if (!logger) {
				ctx.ui.notify("Audit trail not initialized (no active session)", "error");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";

			if (!subcommand) {
				// Summary
				const entries = queryAuditTrail(logger.filePath);
				const categories: Record<string, number> = {};
				for (const e of entries) {
					categories[e.category] = (categories[e.category] || 0) + 1;
				}

				const lines = [
					`**Audit Trail Summary**`,
					`Session: ${logger.sessionId}`,
					`File: ${logger.filePath}`,
					`Total entries: ${entries.length}`,
					``,
					`**Categories:**`,
					...Object.entries(categories)
						.sort(([, a], [, b]) => b - a)
						.map(([cat, count]) => `  ${cat}: ${count}`),
				];

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (subcommand === "tail") {
				const limit = parseInt(parts[1] || "20", 10);
				const entries = queryAuditTrail(logger.filePath, { limit });

				if (entries.length === 0) {
					ctx.ui.notify("No audit entries found.", "info");
					return;
				}

				const lines = entries
					.reverse()
					.map(
						(e) =>
							`[${e.ts.slice(11, 23)}] #${e.seq} ${e.category}/${e.event} (${e.actor})${e.outcome ? ` → ${e.outcome}` : ""}`
					);

				ctx.ui.notify(
					`**Last ${entries.length} entries:**\n\`\`\`\n${lines.join("\n")}\n\`\`\``,
					"info"
				);
				return;
			}

			if (subcommand === "verify") {
				const result = verifyIntegrity(logger.filePath);
				if (result.valid) {
					ctx.ui.notify(`Hash chain VALID — ${result.totalEntries} entries verified.`, "info");
				} else {
					ctx.ui.notify(
						`Hash chain BROKEN at seq=${result.firstBrokenSeq}: ${result.errorMessage}`,
						"error"
					);
				}
				return;
			}

			if (subcommand === "verify-all") {
				const auditDir = dirname(logger.filePath);
				const files = listAuditFiles(auditDir);

				if (files.length === 0) {
					ctx.ui.notify("No audit files found.", "info");
					return;
				}

				const results: string[] = [];
				let allValid = true;
				for (const file of files) {
					const result = verifyIntegrity(file.path);
					const status = result.valid ? "VALID" : "BROKEN";
					if (!result.valid) allValid = false;
					results.push(
						`  ${file.sessionId} (${file.date}): ${status} — ${result.totalEntries} entries`
					);
				}

				ctx.ui.notify(
					`**Audit Verification (${files.length} files):**\n${results.join("\n")}\n\nOverall: ${allValid ? "ALL VALID" : "INTEGRITY ISSUES DETECTED"}`,
					allValid ? "info" : "error"
				);
				return;
			}

			if (subcommand === "files") {
				const auditDir = dirname(logger.filePath);
				const files = listAuditFiles(auditDir);

				if (files.length === 0) {
					ctx.ui.notify("No audit files found.", "info");
					return;
				}

				const lines = files.map(
					(f) =>
						`  ${f.sessionId} (${f.date}) — ${f.entryCount} entries, ${(f.sizeBytes / 1024).toFixed(1)} KB`
				);

				ctx.ui.notify(`**Audit Files (${files.length}):**\n${lines.join("\n")}`, "info");
				return;
			}

			if (subcommand === "export") {
				const format = (parts[1] || "jsonl") as "jsonl" | "csv" | "json";
				if (!["jsonl", "csv", "json"].includes(format)) {
					ctx.ui.notify(`Unknown format "${format}". Use: jsonl, csv, json`, "error");
					return;
				}

				const output = exportAuditTrail(logger.filePath, format);
				const lineCount = output.trim().split("\n").length;
				ctx.ui.notify(
					`**Exported ${lineCount} lines (${format}):**\n\`\`\`\n${output.slice(0, 5000)}${output.length > 5000 ? "\n... (truncated)" : ""}\n\`\`\``,
					"info"
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /audit [tail N | verify | verify-all | files | export [jsonl|csv|json]]",
				"warning"
			);
		},
	});

	// ── audit_inspect tool ───────────────────────────────────────

	pi.registerTool({
		name: "audit_inspect",
		label: "Audit Inspect",
		description:
			"Query and verify the pharma-grade audit trail. Supports filtering by category, event, actor, outcome, and time range. Can also verify hash chain integrity.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("query"),
					Type.Literal("verify"),
					Type.Literal("summary"),
					Type.Literal("tail"),
				],
				{ description: "Action: query, verify, summary, or tail" }
			),
			category: Type.Optional(
				Type.String({ description: "Filter by category (e.g. tool, session, permission)" })
			),
			event: Type.Optional(Type.String({ description: "Filter by event name" })),
			actor: Type.Optional(
				Type.String({ description: "Filter by actor (user, agent, hook, system, subagent)" })
			),
			outcome: Type.Optional(
				Type.String({ description: "Filter by outcome (allowed, blocked, etc.)" })
			),
			since: Type.Optional(Type.String({ description: "Only entries after this ISO timestamp" })),
			until: Type.Optional(Type.String({ description: "Only entries before this ISO timestamp" })),
			search: Type.Optional(Type.String({ description: "Free-text search across entry data" })),
			limit: Type.Optional(Type.Number({ description: "Maximum entries to return (default: 50)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!logger) {
				return {
					content: [{ type: "text", text: "Audit trail not initialized." }],
					details: {},
				};
			}

			const opts: AuditQueryOptions = {
				category: params.category as AuditCategory | undefined,
				event: params.event,
				actor: params.actor as AuditQueryOptions["actor"],
				outcome: params.outcome,
				since: params.since,
				until: params.until,
				search: params.search,
				limit: params.limit || 50,
			};

			if (params.action === "verify") {
				const result = verifyIntegrity(logger.filePath);
				return {
					content: [
						{
							type: "text",
							text: result.valid
								? `Hash chain VALID — ${result.totalEntries} entries verified.`
								: `Hash chain BROKEN at seq=${result.firstBrokenSeq}: ${result.errorMessage}`,
						},
					],
					details: result,
				};
			}

			if (params.action === "summary") {
				const entries = queryAuditTrail(logger.filePath);
				const categories: Record<string, number> = {};
				const actors: Record<string, number> = {};
				const outcomes: Record<string, number> = {};
				for (const e of entries) {
					categories[e.category] = (categories[e.category] || 0) + 1;
					actors[e.actor] = (actors[e.actor] || 0) + 1;
					if (e.outcome) outcomes[e.outcome] = (outcomes[e.outcome] || 0) + 1;
				}
				const summary = {
					sessionId: logger.sessionId,
					totalEntries: entries.length,
					categories,
					actors,
					outcomes,
				};
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(summary, null, 2),
						},
					],
					details: summary,
				};
			}

			if (params.action === "tail") {
				const entries = queryAuditTrail(logger.filePath, { limit: opts.limit || 20 });
				return {
					content: [
						{
							type: "text",
							text: entries
								.reverse()
								.map(
									(e) =>
										`#${e.seq} [${e.ts}] ${e.category}/${e.event} (${e.actor})${e.outcome ? ` → ${e.outcome}` : ""}`
								)
								.join("\n"),
						},
					],
					details: { count: entries.length },
				};
			}

			// Default: query
			const entries = queryAuditTrail(logger.filePath, opts);
			return {
				content: [
					{
						type: "text",
						text:
							entries.length > 0
								? entries.map((e) => JSON.stringify(e)).join("\n")
								: "No matching entries found.",
					},
				],
				details: { count: entries.length },
			};
		},
	});
}
