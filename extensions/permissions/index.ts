/**
 * Permissions Extension — Claude Code-compatible permission rules.
 *
 * Enforces `Tool(specifier)` permission rules from settings.json files via
 * the `tool_call` event. Provides the `/permissions` command for inspection,
 * testing, and reloading.
 *
 * Rule format: flat `allow` / `deny` / `ask` arrays in the `permissions` key
 * of any settings.json file. Supports Claude Code's exact syntax plus tallow's
 * `{cwd}`, `{home}`, `{project}` variable expansion.
 *
 * Resolution order: deny → ask → allow → default.
 * Hardcoded safety denylists (fork bombs, rm -rf /) are NOT overridable.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type ExpansionVars,
	evaluate,
	extractAllAgentNames,
	formatPermissionReason,
	normalizeToolName,
	type PermissionVerdict,
	redactSensitiveReasonText,
} from "../_shared/permissions.js";
import { getPermissions, recordAudit, reloadPermissions } from "../_shared/shell-policy.js";

// ── Helper: build expansion vars ─────────────────────────────────────────────

/**
 * Build expansion variables from the current session context.
 *
 * @param cwd - Current working directory
 * @returns Expansion variables for permission rule resolution
 */
function buildVars(cwd: string): ExpansionVars {
	const home = homedir();
	let project = cwd;
	try {
		const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf-8",
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (result.status === 0 && result.stdout?.trim()) {
			project = result.stdout.trim();
		}
	} catch {
		// Not in a git repo
	}
	return { cwd, home, project };
}

// ── Tool-specific input extraction for permission checks ─────────────────────

// ── Main Extension ───────────────────────────────────────────────────────────

/**
 * Registers the permissions extension: `tool_call` enforcement and `/permissions` command.
 *
 * @param pi - Extension API
 */
export default function (pi: ExtensionAPI): void {
	let currentCwd = "";

	pi.on("session_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;

		// Eagerly load permissions to surface any config warnings at startup
		const permissions = getPermissions(currentCwd);
		const totalRules =
			permissions.merged.allow.length +
			permissions.merged.deny.length +
			permissions.merged.ask.length;

		if (totalRules > 0 && permissions.sources.length > 0) {
			const sourceFiles = permissions.sources.map((s) => s.path).join(", ");
			ctx.ui?.notify(
				`🔒 Loaded ${totalRules} permission rule${totalRules === 1 ? "" : "s"} from ${sourceFiles}`,
				"info"
			);
		}
	});

	// ── Tool-call enforcement ────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const toolName = normalizeToolName(event.toolName);
		const input = (event.input ?? {}) as Record<string, unknown>;
		const cwd = ctx.cwd || currentCwd;

		const permissions = getPermissions(cwd);
		const merged = permissions.merged;

		// Skip if no rules configured
		if (merged.allow.length === 0 && merged.deny.length === 0 && merged.ask.length === 0) {
			return;
		}

		// Bash commands are handled by shell-policy integration — skip here
		// to avoid double-checking. bg_bash also goes through shell-policy.
		if (toolName === "bash" || toolName === "bg_bash") {
			return;
		}

		const vars = buildVars(cwd);
		const settingsDir = `${cwd}/.tallow`;

		// ── Subagent: check all agent names ──
		if (toolName === "subagent") {
			const agents = extractAllAgentNames(input);
			for (const agent of agents) {
				const verdict = evaluate("subagent", { agent }, merged, vars, settingsDir);
				if (verdict.action === "deny") {
					recordPermissionAudit(event.toolName, cwd, "blocked", verdict);
					return { block: true, reason: buildBlockReason(verdict) };
				}
				if (verdict.action === "ask") {
					const confirmed = await confirmPermission(ctx, event.toolName, agent, verdict);
					if (!confirmed) {
						recordPermissionAudit(event.toolName, cwd, "blocked", verdict);
						return {
							block: true,
							reason: `Permission request denied: ${buildBlockReason(verdict)}`,
						};
					}
					recordPermissionAudit(event.toolName, cwd, "confirmed", verdict);
				}
			}
			return;
		}

		// ── Standard tool evaluation ──
		const verdict = evaluate(toolName, input, merged, vars, settingsDir);

		if (verdict.action === "deny") {
			recordPermissionAudit(event.toolName, cwd, "blocked", verdict);
			return { block: true, reason: buildBlockReason(verdict) };
		}

		if (verdict.action === "ask") {
			const specifier = getSpecifierDisplay(toolName, input, cwd);
			const confirmed = await confirmPermission(ctx, event.toolName, specifier, verdict);
			if (!confirmed) {
				recordPermissionAudit(event.toolName, cwd, "blocked", verdict);
				return {
					block: true,
					reason: `Permission request denied: ${buildBlockReason(verdict)}`,
				};
			}
			recordPermissionAudit(event.toolName, cwd, "confirmed", verdict);
		}

		if (verdict.action === "allow") {
			recordPermissionAudit(event.toolName, cwd, "allowed", verdict);
		}
	});

	// ── /permissions command ──────────────────────────────────────────────

	pi.registerCommand("permissions", {
		description: "View, test, or reload permission rules",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd || currentCwd;
			const trimmed = (args ?? "").trim();

			// /permissions reload
			if (trimmed === "reload") {
				const warnings = reloadPermissions(cwd);
				const permissions = getPermissions(cwd);
				const totalRules =
					permissions.merged.allow.length +
					permissions.merged.deny.length +
					permissions.merged.ask.length;

				let msg = `✅ Reloaded ${totalRules} permission rule${totalRules === 1 ? "" : "s"}`;
				if (warnings.length > 0) {
					msg += `\n⚠️ Warnings:\n${warnings.map((w) => `  • ${w}`).join("\n")}`;
				}
				ctx.ui?.notify(msg, warnings.length > 0 ? "warning" : "info");
				return;
			}

			// /permissions test Tool(specifier)
			if (trimmed.startsWith("test ")) {
				const ruleText = trimmed.slice(5).trim();
				return handleTest(ruleText, cwd, ctx);
			}

			// /permissions (no args) — show active rules
			return showRules(cwd, ctx);
		},
	});
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a concise deny reason for tool_call block responses.
 *
 * @param verdict - Permission verdict
 * @returns Safe block reason for user/model consumption
 */
function buildBlockReason(verdict: PermissionVerdict): string {
	return formatPermissionReason(verdict, { includeHints: true, maxHints: 2 });
}

/**
 * Record a permission decision in the shell audit trail.
 *
 * @param toolName - Tool that was checked
 * @param cwd - Working directory
 * @param outcome - Decision outcome
 * @param verdict - Permission verdict details
 */
function recordPermissionAudit(
	toolName: string,
	cwd: string,
	outcome: "allowed" | "blocked" | "confirmed",
	verdict: PermissionVerdict
): void {
	recordAudit({
		timestamp: Date.now(),
		command: `[permission] ${toolName}: ${verdict.matchedRule ?? "no match"}`,
		source: "bash", // Reuse existing audit type
		trustLevel: "explicit",
		cwd,
		outcome,
		reason: verdict.reason,
	});
}

/**
 * Get a display string for the tool invocation being checked.
 *
 * @param toolName - Canonical tool name
 * @param input - Tool input
 * @param cwd - Working directory
 * @returns Human-readable specifier string
 */
function getSpecifierDisplay(
	toolName: string,
	input: Record<string, unknown>,
	_cwd: string
): string {
	if (typeof input.path === "string") {
		return redactSensitiveReasonText(input.path);
	}
	if (typeof input.url === "string") {
		return redactSensitiveReasonText(input.url);
	}
	if (typeof input.command === "string") {
		const redactedCommand = redactSensitiveReasonText(input.command);
		return redactedCommand.length > 60 ? `${redactedCommand.slice(0, 57)}...` : redactedCommand;
	}
	return toolName;
}

/**
 * Prompt the user for confirmation on an ask-tier permission check.
 *
 * @param ctx - Extension context
 * @param toolName - Tool being checked
 * @param specifier - What's being checked (path, command, etc.)
 * @param verdict - Permission verdict
 * @returns True if user confirmed, false otherwise
 */
async function confirmPermission(
	ctx: ExtensionContext,
	toolName: string,
	specifier: string,
	verdict: PermissionVerdict
): Promise<boolean> {
	if (!ctx.hasUI) {
		// Non-interactive — can't prompt, block with explanation
		return false;
	}

	const reason = formatPermissionReason(verdict, { includeHints: true, maxHints: 1 });
	const lines = [`Reason: ${reason}`, "", `Tool: ${toolName}`, `Input: ${specifier}`];
	if (verdict.matchedRule) {
		lines.push(`Rule: ${verdict.matchedRule}`);
	}
	lines.push("", "Allow this action?");

	try {
		const confirmed = await ctx.ui.confirm("Permission Required", lines.join("\n"));
		return confirmed === true;
	} catch {
		return false;
	}
}

/**
 * Handle `/permissions test Tool(specifier)` command.
 *
 * @param ruleText - The rule/input to test (e.g. "Bash(docker compose up)")
 * @param cwd - Working directory
 * @param ctx - Extension context
 */
function handleTest(ruleText: string, cwd: string, ctx: ExtensionContext): void {
	// Parse the test input as a Tool(specifier) format
	const parenOpen = ruleText.indexOf("(");
	const parenClose = ruleText.lastIndexOf(")");

	let toolName: string;
	let specifier: string;

	if (parenOpen !== -1 && parenClose > parenOpen) {
		toolName = normalizeToolName(ruleText.slice(0, parenOpen));
		specifier = ruleText.slice(parenOpen + 1, parenClose);
	} else {
		toolName = normalizeToolName(ruleText);
		specifier = "";
	}

	// Build mock input based on tool type
	const input: Record<string, unknown> = {};
	switch (toolName) {
		case "bash":
		case "bg_bash":
			input.command = specifier;
			break;
		case "read":
		case "write":
		case "edit":
		case "cd":
		case "ls":
		case "find":
		case "grep":
			input.path = specifier;
			break;
		case "web_fetch":
			input.url = specifier;
			break;
		case "subagent":
			input.agent = specifier;
			break;
		default:
			if (toolName.startsWith("mcp__")) {
				// MCP tool — tool name IS the specifier
			}
			break;
	}

	const permissions = getPermissions(cwd);
	const vars = buildVars(cwd);
	const settingsDir = `${cwd}/.tallow`;

	const verdict = evaluate(toolName, input, permissions.merged, vars, settingsDir);

	const icon =
		verdict.action === "deny"
			? "🚫"
			: verdict.action === "ask"
				? "❓"
				: verdict.action === "allow"
					? "✅"
					: "⚪";

	const formattedReason = formatPermissionReason(verdict, { includeHints: true, maxHints: 2 });
	ctx.ui?.notify(
		`${icon} ${ruleText}\n  Action: ${verdict.action}\n  Reason: ${formattedReason}${verdict.matchedRule ? `\n  Matched: ${verdict.matchedRule}` : ""}`,
		verdict.action === "deny" ? "error" : "info"
	);
}

/**
 * Display all active permission rules grouped by source.
 *
 * @param cwd - Working directory
 * @param ctx - Extension context
 */
function showRules(cwd: string, ctx: ExtensionContext): void {
	const permissions = getPermissions(cwd);

	if (permissions.sources.length === 0) {
		ctx.ui?.notify("No permission rules configured.", "info");
		return;
	}

	const lines: string[] = ["🔒 Active Permission Rules\n"];

	for (const source of permissions.sources) {
		lines.push(`📄 ${source.path} (${source.tier})`);

		if (source.config.deny.length > 0) {
			lines.push("  Deny:");
			for (const rule of source.config.deny) {
				lines.push(`    🚫 ${rule.raw}`);
			}
		}
		if (source.config.ask.length > 0) {
			lines.push("  Ask:");
			for (const rule of source.config.ask) {
				lines.push(`    ❓ ${rule.raw}`);
			}
		}
		if (source.config.allow.length > 0) {
			lines.push("  Allow:");
			for (const rule of source.config.allow) {
				lines.push(`    ✅ ${rule.raw}`);
			}
		}
		lines.push("");
	}

	const total =
		permissions.merged.allow.length +
		permissions.merged.deny.length +
		permissions.merged.ask.length;
	lines.push(
		`Total: ${total} rule${total === 1 ? "" : "s"} from ${permissions.sources.length} source${permissions.sources.length === 1 ? "" : "s"}`
	);

	ctx.ui?.notify(lines.join("\n"), "info");
}
