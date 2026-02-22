/**
 * Agent Commands Extension
 *
 * Registers agents as `/agent-name` commands (like Claude Code).
 * Directly spawns the agent as a subprocess.
 *
 * Example: `/planner implement user authentication`
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getTallowHomeDir } from "../_shared/tallow-paths.js";

export interface AgentFrontmatter {
	name?: string;
	description?: string;
	tools?: string;
	disallowedTools?: string;
	skills?: string;
	mcpServers?: string;
	maxTurns?: string;
	model?: string;
	"argument-hint"?: string;
	[key: string]: unknown;
}

export interface Agent {
	name: string;
	description: string;
	filePath: string;
	tools?: string[];
	disallowedTools?: string[];
	skills?: string[];
	mcpServers?: string[];
	maxTurns?: number;
	model?: string;
	systemPrompt: string;
}

/** Built-in tools available in a default pi subprocess. */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Computes the effective tool list from allowlist and denylist.
 *
 * @param tools - Explicit allowlist from frontmatter (undefined = inherit all)
 * @param disallowedTools - Denylist from frontmatter (undefined = no exclusions)
 * @returns Tool list for --tools flag, or undefined if no filtering needed
 */
export function computeEffectiveTools(
	tools: string[] | undefined,
	disallowedTools: string[] | undefined
): string[] | undefined {
	if (!tools && !disallowedTools) return undefined;
	if (tools && !disallowedTools) return tools;

	const base = tools ?? PI_BUILTIN_TOOLS;
	const deny = new Set(disallowedTools);
	return base.filter((t) => !deny.has(t));
}

/**
 * Parses frontmatter and body from agent markdown content.
 * @param content - Raw markdown content with optional YAML frontmatter
 * @returns Object containing parsed frontmatter and body text
 */
export function parseAgent(content: string): { frontmatter: AgentFrontmatter; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const frontmatter: AgentFrontmatter = {};
	const lines = match[1].split("\n");

	for (const line of lines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;

		const key = line.slice(0, colonIndex).trim();
		let value: string | boolean = line.slice(colonIndex + 1).trim();

		if (value === "true") value = true;
		else if (value === "false") value = false;

		frontmatter[key] = value;
	}

	return { frontmatter, body: match[2] || "" };
}

/**
 * Loads agent definitions from a directory of markdown files.
 * @param dir - Directory path to scan for .md files
 * @returns Array of parsed agent configurations
 */
export function loadAgentsFromDir(dir: string): Agent[] {
	const agents: Agent[] = [];

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

		const { frontmatter, body } = parseAgent(content);
		if (!(frontmatter.name && frontmatter.description)) continue;

		const tools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
				: undefined;

		const disallowedTools =
			typeof frontmatter.disallowedTools === "string"
				? frontmatter.disallowedTools
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

		const mcpServers =
			typeof frontmatter.mcpServers === "string"
				? frontmatter.mcpServers
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;

		const parsedMaxTurns =
			typeof frontmatter.maxTurns === "string"
				? Number.parseInt(frontmatter.maxTurns, 10)
				: typeof frontmatter.maxTurns === "number"
					? frontmatter.maxTurns
					: undefined;
		const maxTurns = parsedMaxTurns && parsedMaxTurns > 0 ? parsedMaxTurns : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			filePath,
			tools,
			disallowedTools: disallowedTools && disallowedTools.length > 0 ? disallowedTools : undefined,
			skills,
			mcpServers: mcpServers && mcpServers.length > 0 ? mcpServers : undefined,
			maxTurns,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body.trim(),
		});
	}

	return agents;
}

/**
 * Resolves a path that may start with ~ to an absolute path.
 * @param p - Path that may contain ~ prefix
 * @returns Resolved absolute path
 */
export function resolvePath(p: string): string {
	const trimmed = p.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	return path.resolve(trimmed);
}

/**
 * Reads settings.json and returns agent directories from installed packages.
 * Scans each local package path for an agents/ subdirectory.
 * @param settingsPath - Path to settings.json
 * @returns Array of resolved agent directory paths found in packages
 */
export function getPackageAgentDirs(settingsPath: string): string[] {
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
			// Only handle local paths (not npm: or git:)
			if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("https://"))
				continue;

			const resolved = resolvePath(
				source.startsWith("./") || source.startsWith("../")
					? path.resolve(settingsDir, source)
					: source
			);

			const agentsDir = path.join(resolved, "agents");
			if (fs.existsSync(agentsDir)) {
				dirs.push(agentsDir);
			}
		}
	} catch {
		// Ignore parse errors
	}

	return dirs;
}

/**
 * Read plugin agent directories from the SDK-injected env var.
 *
 * SDK populates `TALLOW_PLUGIN_AGENTS_DIRS` with absolute `agents/` paths
 * for resolved Claude-style plugins.
 *
 * @param envValue - Optional env value override for tests
 * @returns Existing agent directories from the env var (deduplicated)
 */
export function getPluginAgentDirsFromEnv(envValue?: string): string[] {
	const raw = (envValue ?? process.env.TALLOW_PLUGIN_AGENTS_DIRS ?? "").trim();
	if (!raw) return [];

	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const dir of raw
		.split(path.delimiter)
		.map((v) => v.trim())
		.filter(Boolean)) {
		const normalized = path.resolve(dir);
		if (!fs.existsSync(normalized) || seen.has(normalized)) continue;
		seen.add(normalized);
		dirs.push(normalized);
	}

	return dirs;
}

/**
 * Loads agents from user, project, package/plugin, and .claude/ directories.
 * Priority: bundled → packages/plugins → .claude/user → .tallow/user → .claude/project → .tallow/project
 * Last wins per name, so .tallow/ takes precedence over .claude/.
 *
 * @returns Merged array of unique agents
 */
function loadAgents(): Agent[] {
	const agentDir = getTallowHomeDir();
	const userDir = path.join(agentDir, "agents");
	const userClaudeDir = path.join(os.homedir(), ".claude", "agents");
	const projectDir = path.join(process.cwd(), ".tallow", "agents");
	const projectClaudeDir = path.join(process.cwd(), ".claude", "agents");

	// Bundled agents shipped with the package.
	// Walk up from this extension's directory to the package root.
	// jiti sets import.meta.url to the source file path.
	const extensionFile = import.meta.url.startsWith("file:")
		? new URL(import.meta.url).pathname
		: import.meta.url;
	const bundledDir = path.resolve(path.dirname(extensionFile), "..", "..", "agents");

	// Collect agent dirs from packages in both global and project settings
	const globalSettingsPath = path.join(agentDir, "settings.json");
	const projectSettingsPath = path.join(process.cwd(), ".tallow", "settings.json");
	const packageDirs = [
		...new Set([
			...getPackageAgentDirs(globalSettingsPath),
			...getPackageAgentDirs(projectSettingsPath),
			...getPluginAgentDirsFromEnv(),
		]),
	];

	// Load in priority order: bundled → packages/plugins → .claude/user → .tallow/user → .claude/project → .tallow/project
	const agentMap = new Map<string, Agent>();
	for (const agent of loadAgentsFromDir(bundledDir)) agentMap.set(agent.name, agent);
	for (const dir of packageDirs) {
		for (const agent of loadAgentsFromDir(dir)) agentMap.set(agent.name, agent);
	}
	for (const agent of loadAgentsFromDir(userClaudeDir)) agentMap.set(agent.name, agent);
	for (const agent of loadAgentsFromDir(userDir)) agentMap.set(agent.name, agent);
	for (const agent of loadAgentsFromDir(projectClaudeDir)) agentMap.set(agent.name, agent);
	for (const agent of loadAgentsFromDir(projectDir)) agentMap.set(agent.name, agent);

	return Array.from(agentMap.values());
}

/**
 * Writes agent system prompt to a temporary file for pi subprocess.
 * @param name - Agent name (used in filename)
 * @param content - System prompt content to write
 * @returns Path to the created temp file
 */
function writeTempPrompt(name: string, content: string): string {
	const tmpDir = os.tmpdir();
	const filePath = path.join(tmpDir, `pi-agent-${name}-${Date.now()}.md`);
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

/**
 * Registers slash commands for each discovered agent.
 * @param pi - Extension API for registering commands
 */
export default function (pi: ExtensionAPI) {
	const agents = loadAgents();

	for (const agent of agents) {
		pi.registerCommand(`agent:${agent.name}`, {
			description: `[agent] ${agent.description}`,
			handler: async (args, ctx) => {
				if (!args?.trim()) {
					ctx.ui.notify(`Usage: /agent:${agent.name} <task>`, "warning");
					return;
				}

				ctx.ui.notify(`Running ${agent.name} agent...`, "info");

				// Build command args
				const piArgs: string[] = ["-p"];
				if (agent.model) piArgs.push("--model", agent.model);
				const effectiveTools = computeEffectiveTools(agent.tools, agent.disallowedTools);
				if (effectiveTools && effectiveTools.length > 0) {
					piArgs.push("--tools", effectiveTools.join(","));
				}
				if (agent.skills && agent.skills.length > 0) {
					for (const skill of agent.skills) {
						piArgs.push("--skill", skill);
					}
				}

				// Inject maxTurns budget hint into system prompt (soft enforcement only —
				// agent-commands-tool doesn't use --mode json so no event-based hard kill)
				let systemPrompt = agent.systemPrompt;
				if (agent.maxTurns) {
					const budget = `You have a maximum of ${agent.maxTurns} tool-use turns for this task. Plan your approach to complete within this budget. If you are running low, output your best result immediately.\n\n`;
					systemPrompt = budget + systemPrompt;
				}

				// Add system prompt if present
				let tmpPromptPath: string | null = null;
				if (systemPrompt) {
					tmpPromptPath = writeTempPrompt(agent.name, systemPrompt);
					piArgs.push("--append-system-prompt", tmpPromptPath);
				}

				// Add the task
				piArgs.push(`Task: ${args}`);

				// Spawn pi process
				const spawnEnv: Record<string, string> = {
					...process.env,
					PI_IS_SUBAGENT: "1",
				} as Record<string, string>;
				if (agent.mcpServers && agent.mcpServers.length > 0) {
					spawnEnv.PI_MCP_SERVERS = agent.mcpServers.join(",");
				}
				const proc = spawn("pi", piArgs, {
					cwd: ctx.cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: spawnEnv,
				});

				let stdout = "";
				let stderr = "";

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});

				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});

				proc.on("close", (code) => {
					// Cleanup temp file
					if (tmpPromptPath) {
						try {
							fs.unlinkSync(tmpPromptPath);
						} catch {
							// ignore
						}
					}

					if (code === 0) {
						// Send the agent's output as context for the main conversation.
						// Use followUp since the agent may be mid-turn when the subprocess finishes.
						const output = stdout.trim() || "(no output)";
						pi.sendUserMessage(
							`Agent "${agent.name}" completed the task.\n\n**Task:** ${args}\n\n**Result:**\n${output}`,
							{ deliverAs: "followUp" }
						);
					} else {
						ctx.ui.notify(`Agent ${agent.name} failed (exit ${code})`, "error");
						if (stderr) {
							console.error(`Agent stderr: ${stderr}`);
						}
					}
				});

				proc.on("error", (err) => {
					ctx.ui.notify(`Failed to spawn agent: ${err.message}`, "error");
				});
			},
		});
	}
}
