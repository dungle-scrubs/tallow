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

interface AgentFrontmatter {
	name?: string;
	description?: string;
	tools?: string;
	skills?: string;
	model?: string;
	"argument-hint"?: string;
	[key: string]: unknown;
}

interface Agent {
	name: string;
	description: string;
	filePath: string;
	tools?: string[];
	skills?: string[];
	model?: string;
	systemPrompt: string;
}

/**
 * Parses frontmatter and body from agent markdown content.
 * @param content - Raw markdown content with optional YAML frontmatter
 * @returns Object containing parsed frontmatter and body text
 */
function parseAgent(content: string): { frontmatter: AgentFrontmatter; body: string } {
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
function loadAgentsFromDir(dir: string): Agent[] {
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

		const skills =
			typeof frontmatter.skills === "string"
				? frontmatter.skills
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
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
 * @param p - Path that may contain ~ prefix
 * @returns Resolved absolute path
 */
function resolvePath(p: string): string {
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
function getPackageAgentDirs(settingsPath: string): string[] {
	const dirs: string[] = [];
	if (!fs.existsSync(settingsPath)) return dirs;

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { packages?: Array<string | { source: string }> };
		if (!Array.isArray(settings.packages)) return dirs;

		const settingsDir = path.dirname(settingsPath);

		for (const pkg of settings.packages) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
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
 * Loads agents from user, project, and package directories.
 * Priority: project > user > packages (last wins per name).
 * @returns Merged array of unique agents
 */
function loadAgents(): Agent[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".tallow");
	const userDir = path.join(agentDir, "agents");
	const projectDir = path.join(process.cwd(), ".tallow", "agents");

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
		...getPackageAgentDirs(globalSettingsPath),
		...getPackageAgentDirs(projectSettingsPath),
	];

	// Load in priority order: bundled (lowest) → packages → user → project (highest)
	const agentMap = new Map<string, Agent>();
	for (const agent of loadAgentsFromDir(bundledDir)) agentMap.set(agent.name, agent);
	for (const dir of packageDirs) {
		for (const agent of loadAgentsFromDir(dir)) agentMap.set(agent.name, agent);
	}
	for (const agent of loadAgentsFromDir(userDir)) agentMap.set(agent.name, agent);
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
				if (agent.tools && agent.tools.length > 0) {
					piArgs.push("--tools", agent.tools.join(","));
				}
				if (agent.skills && agent.skills.length > 0) {
					for (const skill of agent.skills) {
						piArgs.push("--skill", skill);
					}
				}

				// Add system prompt if present
				let tmpPromptPath: string | null = null;
				if (agent.systemPrompt) {
					tmpPromptPath = writeTempPrompt(agent.name, agent.systemPrompt);
					piArgs.push("--append-system-prompt", tmpPromptPath);
				}

				// Add the task
				piArgs.push(`Task: ${args}`);

				// Spawn pi process
				const proc = spawn("pi", piArgs, {
					cwd: ctx.cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, PI_IS_SUBAGENT: "1" },
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
