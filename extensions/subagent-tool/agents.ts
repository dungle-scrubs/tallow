/**
 * Agent Discovery and Resolution
 *
 * Discovers agent configurations from ~/.tallow/agents, ~/.claude/agents,
 * and project-local .tallow/agents / .claude/agents directories.
 * Resolves agent names to runnable configurations via exact match,
 * fuzzy matching, or ephemeral agent fallback.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { getTallowPath } from "../_shared/tallow-paths.js";
import type { IsolationMode } from "./schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Scope for agent discovery */
export type AgentScope = "user" | "project" | "both";

/** Configuration for a discovered agent */
export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	disallowedTools?: string[];
	skills?: string[];
	/** Agent types this agent is allowed to spawn (from Task(type) in tools frontmatter) */
	allowedAgentTypes?: string[];
	mcpServers?: string[];
	maxTurns?: number;
	model?: string;
	isolation?: IsolationMode;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

/**
 * Configurable defaults for subagent execution.
 *
 * Loaded from `_defaults.md` files in agent directories.
 * Applied when neither the per-call params nor agent frontmatter
 * specify a value.
 */
export interface AgentDefaults {
	tools?: string[];
	disallowedTools?: string[];
	maxTurns?: number;
	mcpServers?: string[];
	isolation?: IsolationMode;
	/** How to handle missing agent names. Default: "match-or-ephemeral" */
	missingAgentBehavior?: "match-or-ephemeral" | "error";
	/** Agent name to use as fallback when no match found */
	fallbackAgent?: string;
}

/** Result of agent discovery */
export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	defaults: AgentDefaults;
}

/** Result of agent resolution — always produces an agent config. */
export interface ResolvedAgent {
	agent: AgentConfig;
	/** How the agent was resolved */
	resolution: "exact" | "match" | "ephemeral";
	/** Original requested name (for transparency in output) */
	requestedName: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;

/** Built-in tools available in a default pi subprocess. */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Minimum score threshold for best-match to be accepted over ephemeral. */
const MATCH_THRESHOLD = 40;

/**
 * Parse and validate isolation frontmatter/default values.
 *
 * @param value - Raw frontmatter/default value
 * @param sourcePath - File path used in deterministic error messages
 * @param fieldName - Field name used in deterministic error messages
 * @returns Parsed isolation mode when present
 * @throws {Error} When value is invalid
 */
function parseIsolationValue(
	value: unknown,
	sourcePath: string,
	fieldName: "isolation"
): IsolationMode | undefined {
	if (value == null || value === "") return undefined;
	if (typeof value !== "string") {
		throw new Error(`Invalid ${fieldName} in ${sourcePath}: expected string "worktree".`);
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "worktree") return "worktree";
	throw new Error(`Invalid ${fieldName} in ${sourcePath}: received "${value}". Allowed: worktree.`);
}

// ── Functions ────────────────────────────────────────────────────────────────

/**
 * Resolve the project root directory using git, falling back to cwd.
 *
 * Uses `git rev-parse --show-toplevel` to find the repository root.
 * If git is unavailable or the directory isn't in a repo, returns cwd.
 *
 * @param cwd - Current working directory
 * @returns Absolute path to the project root
 */
export function resolveProjectRoot(cwd: string): string {
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return root || cwd;
	} catch {
		return cwd;
	}
}

/**
 * Loads agent configurations from a directory.
 * @param dir - Directory path to search for agent .md files
 * @param source - Whether this is a user or project directory
 * @returns Array of agent configurations found
 */
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
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
		if (entry.name.startsWith("_")) continue;
		if (!(entry.isFile() || entry.isSymbolicLink())) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const description =
			typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		if (!name || !description) continue;

		const rawTools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools
						.split(",")
						.map((t: string) => t.trim())
						.filter(Boolean)
				: undefined;

		// Separate Task(agent_type) entries from regular tool names
		const TASK_PATTERN = /^Task\((.+)\)$/;
		const tools: string[] = [];
		const allowedAgentTypes: string[] = [];
		if (rawTools) {
			for (const t of rawTools) {
				const match = TASK_PATTERN.exec(t);
				if (match?.[1]) {
					allowedAgentTypes.push(match[1]);
				} else {
					tools.push(t);
				}
			}
		}

		let skills: string[] | undefined;
		if (frontmatter.skills) {
			if (Array.isArray(frontmatter.skills)) {
				skills = frontmatter.skills.map((s: string) => s.trim()).filter(Boolean);
			} else if (typeof frontmatter.skills === "string") {
				skills = frontmatter.skills
					.split(",")
					.map((s: string) => s.trim())
					.filter(Boolean);
			}
		}

		const disallowedTools =
			typeof frontmatter.disallowedTools === "string"
				? frontmatter.disallowedTools
						.split(",")
						.map((t: string) => t.trim())
						.filter(Boolean)
				: undefined;

		const parsedMaxTurns = frontmatter.maxTurns
			? Number.parseInt(String(frontmatter.maxTurns), 10)
			: undefined;
		const maxTurns = parsedMaxTurns && parsedMaxTurns > 0 ? parsedMaxTurns : undefined;

		let mcpServers: string[] | undefined;
		if (frontmatter.mcpServers) {
			if (Array.isArray(frontmatter.mcpServers)) {
				mcpServers = frontmatter.mcpServers
					.filter((entry: unknown) => {
						if (typeof entry === "string") return true;
						if (typeof entry === "object" && entry !== null) {
							console.warn(
								`MCP: Inline server definitions not supported in agent "${name}". ` +
									`Use a string reference to a configured server name.`
							);
							return false;
						}
						return false;
					})
					.map((s: string) => s.trim())
					.filter(Boolean);
			} else if (typeof frontmatter.mcpServers === "string") {
				mcpServers = frontmatter.mcpServers
					.split(",")
					.map((s: string) => s.trim())
					.filter(Boolean);
			}
		}

		const isolation = parseIsolationValue(frontmatter.isolation, filePath, "isolation");

		agents.push({
			name,
			description,
			tools: tools.length > 0 ? tools : undefined,
			disallowedTools: disallowedTools && disallowedTools.length > 0 ? disallowedTools : undefined,
			skills: skills && skills.length > 0 ? skills : undefined,
			allowedAgentTypes: allowedAgentTypes.length > 0 ? allowedAgentTypes : undefined,
			mcpServers: mcpServers && mcpServers.length > 0 ? mcpServers : undefined,
			maxTurns,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			isolation,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

/**
 * Checks if a path is a directory.
 * @param p - Path to check
 * @returns true if the path exists and is a directory
 */
function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Finds project agent directories at the project root.
 *
 * Anchored to the git root (or cwd fallback) — no ancestor walk.
 * Checks both .tallow/agents and .claude/agents.
 * Returns 0-2 paths; .claude/ first so .tallow/ wins via last-wins in the map.
 *
 * @param cwd - Current working directory (used to resolve project root)
 * @returns Array of project agent directory paths at the project root
 */
function findProjectAgentsDirs(cwd: string): string[] {
	const root = resolveProjectRoot(cwd);
	const tallowDir = path.join(root, ".tallow", "agents");
	const claudeDir = path.join(root, ".claude", "agents");
	const hasTallow = isDirectory(tallowDir);
	const hasClaude = isDirectory(claudeDir);
	if (!hasTallow && !hasClaude) return [];
	const dirs: string[] = [];
	if (hasClaude) dirs.push(claudeDir);
	if (hasTallow) dirs.push(tallowDir);
	return dirs;
}

/**
 * Load defaults from a `_defaults.md` file in an agent directory.
 *
 * Only parses YAML frontmatter — the body is ignored.
 * Returns undefined if the file doesn't exist or can't be parsed.
 *
 * @param dir - Agent directory path
 * @returns Parsed defaults, or undefined
 */
function loadDefaultsFromDir(dir: string): AgentDefaults | undefined {
	const filePath = path.join(dir, "_defaults.md");
	if (!fs.existsSync(filePath)) return undefined;

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
	if (!frontmatter || Object.keys(frontmatter).length === 0) return undefined;

	const defaults: AgentDefaults = {};

	if (typeof frontmatter.tools === "string") {
		defaults.tools = (frontmatter.tools as string)
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}
	if (typeof frontmatter.disallowedTools === "string") {
		defaults.disallowedTools = (frontmatter.disallowedTools as string)
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}
	if (frontmatter.maxTurns != null) {
		const n = Number(frontmatter.maxTurns);
		if (n > 0) defaults.maxTurns = n;
	}
	if (typeof frontmatter.mcpServers === "string") {
		defaults.mcpServers = (frontmatter.mcpServers as string)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	const isolation = parseIsolationValue(frontmatter.isolation, filePath, "isolation");
	if (isolation) {
		defaults.isolation = isolation;
	}
	if (frontmatter.missingAgentBehavior === "error") {
		defaults.missingAgentBehavior = "error";
	}
	if (typeof frontmatter.fallbackAgent === "string" && frontmatter.fallbackAgent.trim()) {
		defaults.fallbackAgent = frontmatter.fallbackAgent.trim();
	}

	return Object.keys(defaults).length > 0 ? defaults : undefined;
}

/**
 * Merge multiple defaults sources according to precedence.
 *
 * Later sources override earlier ones for scalar values.
 * Array values (tools, mcpServers) use the last non-undefined source.
 *
 * @param sources - Defaults sources in precedence order (last wins)
 * @returns Merged defaults
 */
function mergeDefaults(...sources: (AgentDefaults | undefined)[]): AgentDefaults {
	const merged: AgentDefaults = {};
	for (const src of sources) {
		if (!src) continue;
		if (src.tools) merged.tools = src.tools;
		if (src.disallowedTools) merged.disallowedTools = src.disallowedTools;
		if (src.maxTurns != null) merged.maxTurns = src.maxTurns;
		if (src.mcpServers) merged.mcpServers = src.mcpServers;
		if (src.isolation) merged.isolation = src.isolation;
		if (src.missingAgentBehavior) merged.missingAgentBehavior = src.missingAgentBehavior;
		if (src.fallbackAgent) merged.fallbackAgent = src.fallbackAgent;
	}
	return merged;
}

/**
 * Discovers available agents based on the specified scope.
 * Scans both .tallow/ and .claude/ directories for Claude Code compatibility.
 * Priority: .claude/ loaded first, .tallow/ overwrites on name collision (last wins).
 *
 * @param cwd - Current working directory for project agent discovery
 * @param scope - Which agent sources to include (user, project, or both)
 * @returns Discovery result with agents and project directory path
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userTallowDir = getTallowPath("agents");
	const userClaudeDir = path.join(os.homedir(), ".claude", "agents");
	const projectDirs = findProjectAgentsDirs(cwd);
	const projectAgentsDir = projectDirs.at(-1) ?? null;

	// Load in priority order: .claude/ first so .tallow/ wins via last-wins
	const userAgents: AgentConfig[] = [];
	if (scope !== "project") {
		for (const a of loadAgentsFromDir(userClaudeDir, "user")) userAgents.push(a);
		for (const a of loadAgentsFromDir(userTallowDir, "user")) userAgents.push(a);
	}

	const projectAgents: AgentConfig[] = [];
	if (scope !== "user") {
		for (const dir of projectDirs) {
			for (const a of loadAgentsFromDir(dir, "project")) projectAgents.push(a);
		}
	}

	const agentMap = new Map<string, AgentConfig>();
	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	// Load defaults: user _defaults.md < project _defaults.md (last wins)
	const userDefaults =
		scope !== "project"
			? mergeDefaults(loadDefaultsFromDir(userClaudeDir), loadDefaultsFromDir(userTallowDir))
			: undefined;
	const projectDefaults =
		scope !== "user" ? mergeDefaults(...projectDirs.map(loadDefaultsFromDir)) : undefined;
	const defaults = mergeDefaults(userDefaults, projectDefaults);

	return { agents: Array.from(agentMap.values()), projectAgentsDir, defaults };
}

/**
 * Resolve effective isolation by precedence: call param > agent > defaults.
 *
 * @param callIsolation - Isolation passed in the current tool invocation
 * @param agentIsolation - Isolation from resolved agent frontmatter
 * @param defaultIsolation - Isolation from `_defaults.md`
 * @returns Effective isolation mode when configured
 */
export function resolveEffectiveIsolation(
	callIsolation: IsolationMode | undefined,
	agentIsolation: IsolationMode | undefined,
	defaultIsolation: IsolationMode | undefined
): IsolationMode | undefined {
	return callIsolation ?? agentIsolation ?? defaultIsolation;
}

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
 * Score how well an agent name matches a requested name.
 *
 * Uses a simple heuristic: exact match = Infinity, prefix/suffix/contains
 * get decreasing scores. Returns 0 for no meaningful match.
 *
 * @param agentName - Discovered agent's name
 * @param requestedName - Name the caller asked for
 * @returns Match score (higher = better, 0 = no match)
 */
export function scoreAgentMatch(agentName: string, requestedName: string): number {
	const a = agentName.toLowerCase();
	const r = requestedName.toLowerCase();
	if (a === r) return Infinity;
	// Prefix match (e.g. "work" → "worker")
	if (a.startsWith(r)) return 100 + r.length;
	if (r.startsWith(a)) return 90 + a.length;
	// Contains match
	if (a.includes(r)) return 50 + r.length;
	if (r.includes(a)) return 40 + a.length;
	return 0;
}

/**
 * Resolve an agent name to a runnable configuration.
 *
 * Precedence:
 * 1. Exact name match among discovered agents
 * 2. Best fuzzy match above confidence threshold
 * 3. Ephemeral agent with built-in defaults
 *
 * @param agentName - Requested agent name
 * @param agents - Discovered agent configurations
 * @param defaults - Optional defaults to apply to ephemeral agents
 * @returns Resolved agent configuration with resolution metadata
 */
export function resolveAgentForExecution(
	agentName: string,
	agents: AgentConfig[],
	defaults?: AgentDefaults
): ResolvedAgent {
	// 1. Exact match
	const exact = agents.find((a) => a.name === agentName);
	if (exact) return { agent: exact, resolution: "exact", requestedName: agentName };

	// 2. Best fuzzy match
	let bestScore = 0;
	let bestAgent: AgentConfig | undefined;
	for (const a of agents) {
		const score = scoreAgentMatch(a.name, agentName);
		if (score > bestScore) {
			bestScore = score;
			bestAgent = a;
		}
	}
	if (bestAgent && bestScore >= MATCH_THRESHOLD) {
		return { agent: bestAgent, resolution: "match", requestedName: agentName };
	}

	// 3. Ephemeral agent with sane defaults
	const ephemeral: AgentConfig = {
		name: agentName,
		description: `Ephemeral agent for task delegation`,
		tools: defaults?.tools,
		disallowedTools: defaults?.disallowedTools,
		maxTurns: defaults?.maxTurns,
		mcpServers: defaults?.mcpServers,
		isolation: defaults?.isolation,
		systemPrompt:
			`You are ${agentName}, a specialized subagent. ` +
			"Complete the delegated task thoroughly and return your results.",
		source: "user",
		filePath: "",
	};
	return { agent: ephemeral, resolution: "ephemeral", requestedName: agentName };
}

/**
 * Coerce a value that should be an array but may arrive as a JSON string.
 *
 * LLMs sometimes pass complex nested parameters as a serialized JSON string
 * instead of a proper array. When that happens, `.length` returns the character
 * count of the string (e.g. 8975) rather than the element count. This helper
 * detects that case, parses the string, and returns the array — or `undefined`
 * if the value is neither an array nor a parseable JSON-array string.
 *
 * @param value - The raw parameter value (array, string, or undefined)
 * @returns The coerced array, or undefined if coercion fails
 */
export function coerceArray<T>(value: T[] | string | undefined | null): T[] | undefined {
	if (value == null) return undefined;
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed as T[];
		} catch {
			/* not valid JSON */
		}
	}
	return undefined;
}
