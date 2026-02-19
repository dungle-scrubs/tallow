/**
 * Context Fork Extension
 *
 * Intercepts command/skill invocations that have `context: fork` in their
 * frontmatter, spawns an isolated pi subprocess (optionally configured
 * with a named agent and model), and feeds the result back into the main
 * conversation.
 *
 * Supports these frontmatter fields:
 * - `context: fork | inline` — fork runs in subprocess, inline is default
 * - `agent: <name>` — agent config for the subprocess (tools, skills, system prompt)
 * - `model: <value>` — model alias or full ID for the subprocess
 * - `allowed-tools` — parsed but ignored (tallow has no permission system)
 *
 * Extension load order matters: this hooks `input` and returns `handled`
 * before command-prompt or minimal-skill-display can process fork commands.
 * Alphabetically, `context-fork` comes before both, which is correct.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stripFrontmatter } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { isShellInterpolationEnabled } from "../_shared/shell-policy.js";
import { expandShellCommands } from "../shell-interpolation/index.js";
import type { FrontmatterIndex } from "./frontmatter-index.js";
import { buildFrontmatterIndex } from "./frontmatter-index.js";
import { resolveModel, routeForkedModel } from "./model-resolver.js";
import { spawnForkSubprocess } from "./spawn.js";

// ---------------------------------------------------------------------------
// Agent loading (duplicated from agent-commands-tool — minimal version)
// ---------------------------------------------------------------------------

/** Agent configuration loaded from .md files. */
interface AgentConfig {
	name: string;
	description: string;
	filePath: string;
	tools?: string[];
	skills?: string[];
	model?: string;
	systemPrompt: string;
}

/**
 * Parses frontmatter and body from an agent markdown file.
 *
 * @param content - Raw markdown with optional YAML frontmatter
 * @returns Parsed frontmatter key-values and body text
 */
function parseAgentFile(content: string): {
	frontmatter: Record<string, string | boolean>;
	body: string;
} {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const frontmatter: Record<string, string | boolean> = {};
	for (const line of match[1].split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).trim();
		let value: string | boolean = line.slice(colonIndex + 1).trim();
		if (value === "true") value = true;
		else if (value === "false") value = false;
		frontmatter[key] = value;
	}

	return { frontmatter, body: match[2] ?? "" };
}

/**
 * Loads agent definitions from a directory of markdown files.
 *
 * @param dir - Directory containing agent .md files
 * @returns Array of parsed agent configs
 */
function loadAgentsFromDir(dir: string): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseAgentFile(content);
		if (!(frontmatter.name && frontmatter.description)) continue;

		const tools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
				: undefined;

		const skills =
			typeof frontmatter.skills === "string"
				? frontmatter.skills
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;

		agents.push({
			name: String(frontmatter.name),
			description: String(frontmatter.description),
			filePath,
			tools,
			skills,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body.trim(),
		});
	}

	return agents;
}

/**
 * Resolves a path that may start with ~ to an absolute path.
 *
 * @param p - Path to resolve
 * @returns Absolute path
 */
function resolveHomePath(p: string): string {
	const trimmed = p.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	return path.resolve(trimmed);
}

/**
 * Gets agent directories from settings.json packages.
 *
 * @param settingsPath - Path to settings.json
 * @returns Array of resolved agent directory paths
 */
function getPackageAgentDirs(settingsPath: string): string[] {
	const dirs: string[] = [];
	if (!fs.existsSync(settingsPath)) return dirs;

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { packages?: Array<string | { source: string }> };
		if (!Array.isArray(settings.packages)) return dirs;

		const settingsDir = path.dirname(settingsPath);

		for (const pkg of settings.packages) {
			const source =
				typeof pkg === "string"
					? pkg
					: typeof pkg === "object" && pkg !== null && "source" in pkg
						? pkg.source
						: null;
			if (!source || typeof source !== "string") continue;
			if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("https://"))
				continue;

			const resolved = resolveHomePath(
				source.startsWith("./") || source.startsWith("../")
					? path.resolve(settingsDir, source)
					: source
			);
			const agentsDir = path.join(resolved, "agents");
			if (fs.existsSync(agentsDir)) dirs.push(agentsDir);
		}
	} catch {
		/* ignore parse errors */
	}

	return dirs;
}

/**
 * Loads all agents from bundled, package, user, project, and .claude/ directories.
 * Priority: bundled → packages → .claude/user → .tallow/user → .claude/project → .tallow/project
 * Last wins per name, so .tallow/ takes precedence over .claude/.
 *
 * @returns Map of agent name → config
 */
function loadAllAgents(): Map<string, AgentConfig> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".tallow");
	const userDir = path.join(agentDir, "agents");
	const userClaudeDir = path.join(os.homedir(), ".claude", "agents");
	const projectDir = path.join(process.cwd(), ".tallow", "agents");
	const projectClaudeDir = path.join(process.cwd(), ".claude", "agents");

	// Bundled agents from the package
	const extensionFile = import.meta.url.startsWith("file:")
		? new URL(import.meta.url).pathname
		: import.meta.url;
	const bundledDir = path.resolve(path.dirname(extensionFile), "..", "..", "agents");

	const globalSettingsPath = path.join(agentDir, "settings.json");
	const projectSettingsPath = path.join(process.cwd(), ".tallow", "settings.json");
	const packageDirs = [
		...getPackageAgentDirs(globalSettingsPath),
		...getPackageAgentDirs(projectSettingsPath),
	];

	// Load in priority order: bundled → packages → .claude/user → .tallow/user → .claude/project → .tallow/project
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of loadAgentsFromDir(bundledDir)) agentMap.set(agent.name, agent);
	for (const dir of packageDirs) {
		for (const agent of loadAgentsFromDir(dir)) agentMap.set(agent.name, agent);
	}
	for (const agent of loadAgentsFromDir(userClaudeDir)) agentMap.set(agent.name, agent);
	for (const agent of loadAgentsFromDir(userDir)) agentMap.set(agent.name, agent);
	for (const agent of loadAgentsFromDir(projectClaudeDir)) agentMap.set(agent.name, agent);
	for (const agent of loadAgentsFromDir(projectDir)) agentMap.set(agent.name, agent);

	return agentMap;
}

// ---------------------------------------------------------------------------
// Argument substitution (duplicated from command-prompt — same logic)
// ---------------------------------------------------------------------------

/**
 * Substitutes $ARGUMENTS, $@, $1, $2, etc. placeholders with actual arguments.
 *
 * @param content - Prompt content with placeholders
 * @param args - Space-separated argument string
 * @returns Content with substitutions applied
 */
function substituteArguments(content: string, args: string): string {
	const argList = args.split(/\s+/).filter(Boolean);

	let result = content.replace(/\$(\d+)/g, (_, num) => {
		const index = Number.parseInt(num, 10) - 1;
		return argList[index] ?? "";
	});

	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = Number.parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) {
			const length = Number.parseInt(lengthStr, 10);
			return argList.slice(start, start + length).join(" ");
		}
		return argList.slice(start).join(" ");
	});

	result = result.replace(/\$ARGUMENTS/g, args);
	result = result.replace(/\$@/g, args);

	return result;
}

// ---------------------------------------------------------------------------
// Fork result details
// ---------------------------------------------------------------------------

/** Details attached to fork-result custom messages. */
interface ForkResultDetails {
	commandName: string;
	agent?: string;
	model?: string;
	duration: number;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	let frontmatterIndex: FrontmatterIndex = new Map();
	let agents: Map<string, AgentConfig> = new Map();

	const debug = (...args: unknown[]) => {
		if (process.env.DEBUG) {
			console.error("[context-fork]", ...args);
		}
	};

	/**
	 * Rebuilds the frontmatter index and agent map.
	 * Called on session_start and reload.
	 */
	function rebuildIndex(): void {
		frontmatterIndex = buildFrontmatterIndex(debug);
		agents = loadAllAgents();
		debug(`loaded ${agents.size} agents`);
	}

	// Build index at extension load time
	rebuildIndex();

	// Rebuild on session start and reload
	pi.on("session_start", async () => {
		rebuildIndex();
	});

	// Register custom message renderer for fork results
	pi.registerMessageRenderer<ForkResultDetails>("fork-result", (message, _options, theme) => {
		const details = message.details;
		if (!details) return undefined;

		const parts: string[] = [
			theme.fg("dim", "🔀 "),
			theme.fg("muted", "fork: "),
			theme.fg("accent", `/${details.commandName}`),
		];

		if (details.agent) {
			parts.push(theme.fg("dim", " → "), theme.fg("muted", details.agent));
		}
		if (details.model) {
			parts.push(theme.fg("dim", " · "), theme.fg("muted", details.model));
		}

		const seconds = (details.duration / 1000).toFixed(1);
		parts.push(theme.fg("dim", ` · ${seconds}s`));

		return new Text(parts.join(""), 0, 0);
	});

	// Intercept input for fork commands
	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();

		// Only process slash commands
		if (!text.startsWith("/")) {
			return { action: "continue" as const };
		}

		// Extract command name and args from "/name:space args"
		const withoutSlash = text.slice(1);
		const spaceIndex = withoutSlash.indexOf(" ");
		const commandName = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex);
		const args = spaceIndex === -1 ? "" : withoutSlash.slice(spaceIndex + 1).trim();

		// Also check for skill: prefix
		const lookupName = commandName.startsWith("skill:") ? commandName.slice(6) : commandName;

		// Check frontmatter index
		const fm = frontmatterIndex.get(lookupName) ?? frontmatterIndex.get(commandName);
		if (!fm) {
			return { action: "continue" as const };
		}

		// Warn if agent/model set on inline context
		if (fm.context !== "fork") {
			if (fm.agent || fm.model) {
				debug(`agent/model on "${commandName}" ignored — only supported with context: fork`);
			}
			return { action: "continue" as const };
		}

		// --- Context: fork ---

		// Read and prepare the command content
		let content: string;
		try {
			const raw = fs.readFileSync(fm.filePath, "utf-8");
			content = stripFrontmatter(raw).trim();
		} catch {
			ctx.ui.notify(`Failed to read command: ${commandName}`, "error");
			return { action: "handled" as const };
		}

		// Substitute arguments
		if (args) {
			content = substituteArguments(content, args);
		}

		// Expand shell commands at the template boundary only when explicitly enabled.
		// Commands still run through implicit policy checks (allowlist/denylist + audit).
		if (isShellInterpolationEnabled(ctx.cwd)) {
			content = expandShellCommands(content, ctx.cwd, {
				source: "context-fork",
				enforcePolicy: true,
			});
		}

		// Resolve agent config
		let agentConfig: AgentConfig | undefined;
		if (fm.agent) {
			agentConfig = agents.get(fm.agent);
			if (!agentConfig) {
				ctx.ui.notify(
					`Agent "${fm.agent}" not found for /${commandName}. Available: ${[...agents.keys()].join(", ") || "(none)"}`,
					"error"
				);
				return { action: "handled" as const };
			}
		}

		// Resolve model: explicit model → fuzzy pick, otherwise → auto-route
		const explicitModel = fm.model ?? agentConfig?.model;
		const resolvedModel = explicitModel
			? resolveModel(explicitModel)
			: await routeForkedModel(content, undefined, ctx.model?.id, undefined, ctx.cwd);

		// Show working indicator
		const workingParts = [`🔀 forking: /${commandName}`];
		if (agentConfig) workingParts.push(`→ ${agentConfig.name}`);
		if (resolvedModel) workingParts.push(`(${resolvedModel})`);
		ctx.ui.setWorkingMessage(workingParts.join(" "));

		// Send compact display message immediately
		pi.sendMessage({
			content: `🔀 /${commandName}${args ? ` ${args}` : ""}`,
			customType: "fork-result",
			details: {
				commandName,
				agent: agentConfig?.name,
				model: resolvedModel,
				duration: 0,
			} satisfies ForkResultDetails,
			display: true,
		});

		// Mark as handled — prevent command-prompt/minimal-skill-display from processing
		// We continue the fork asynchronously via the promise below
		const forkPromise = spawnForkSubprocess({
			content,
			cwd: ctx.cwd,
			tools: agentConfig?.tools,
			skills: agentConfig?.skills,
			model: resolvedModel,
			systemPrompt: agentConfig?.systemPrompt,
		});

		forkPromise
			.then((result) => {
				ctx.ui.setWorkingMessage();

				if (result.exitCode !== 0 && !result.output) {
					pi.sendMessage({
						content: `Fork /${commandName} failed (exit ${result.exitCode})`,
						customType: "fork-result",
						details: {
							commandName,
							agent: agentConfig?.name,
							model: result.model ?? resolvedModel,
							duration: result.duration,
						} satisfies ForkResultDetails,
						display: true,
					});
					return;
				}

				const output = result.output || "(no output)";
				pi.sendMessage(
					{
						content: output,
						customType: "fork-result",
						details: {
							commandName,
							agent: agentConfig?.name,
							model: result.model ?? resolvedModel,
							duration: result.duration,
						} satisfies ForkResultDetails,
						display: true,
					},
					{ triggerTurn: true }
				);
			})
			.catch((err: unknown) => {
				ctx.ui.setWorkingMessage();
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Fork /${commandName} error: ${message}`, "error");
			});

		return { action: "handled" as const };
	});
}
