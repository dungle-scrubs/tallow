/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Centipede: { centipede: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	parseFrontmatter,
	type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon, getSpinner } from "../_icons/index.js";
import { extractPreview, isInlineResultsEnabled } from "../_shared/inline-preview.js";
import {
	emitInteropEvent,
	INTEROP_EVENT_NAMES,
	type InteropSubagentView,
	onInteropEvent,
} from "../_shared/interop-events.js";
import { expandFileReferences } from "../file-reference/index.js";
import type { RoutingHints } from "./model-router.js";
import { routeModel } from "./model-router.js";

// === Agent Discovery (inlined from agents.ts) ===

/** Scope for agent discovery */
type AgentScope = "user" | "project" | "both";

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

/** Configuration for a discovered agent */
interface AgentConfig {
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
interface AgentDefaults {
	tools?: string[];
	disallowedTools?: string[];
	maxTurns?: number;
	mcpServers?: string[];
	/** How to handle missing agent names. Default: "match-or-ephemeral" */
	missingAgentBehavior?: "match-or-ephemeral" | "error";
	/** Agent name to use as fallback when no match found */
	fallbackAgent?: string;
}

/** Result of agent discovery */
interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	defaults: AgentDefaults;
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

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!(frontmatter.name && frontmatter.description)) continue;

		const rawTools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

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

		const disallowedTools = frontmatter.disallowedTools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const parsedMaxTurns = frontmatter.maxTurns
			? Number.parseInt(frontmatter.maxTurns, 10)
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
								`MCP: Inline server definitions not supported in agent "${frontmatter.name}". ` +
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

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools.length > 0 ? tools : undefined,
			disallowedTools: disallowedTools && disallowedTools.length > 0 ? disallowedTools : undefined,
			skills: skills && skills.length > 0 ? skills : undefined,
			allowedAgentTypes: allowedAgentTypes.length > 0 ? allowedAgentTypes : undefined,
			mcpServers: mcpServers && mcpServers.length > 0 ? mcpServers : undefined,
			maxTurns,
			model: frontmatter.model,
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
 * Discovers available agents based on the specified scope.
 * Scans both .tallow/ and .claude/ directories for Claude Code compatibility.
 * Priority: .claude/ loaded first, .tallow/ overwrites on name collision (last wins).
 *
 * @param cwd - Current working directory for project agent discovery
 * @param scope - Which agent sources to include (user, project, or both)
 * @returns Discovery result with agents and project directory path
 */
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
		if (src.missingAgentBehavior) merged.missingAgentBehavior = src.missingAgentBehavior;
		if (src.fallbackAgent) merged.fallbackAgent = src.fallbackAgent;
	}
	return merged;
}

function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userTallowDir = path.join(os.homedir(), ".tallow", "agents");
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

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

/** Built-in tools available in a default pi subprocess. */
const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Computes the effective tool list from allowlist and denylist.
 *
 * @param tools - Explicit allowlist from frontmatter (undefined = inherit all)
 * @param disallowedTools - Denylist from frontmatter (undefined = no exclusions)
 * @returns Tool list for --tools flag, or undefined if no filtering needed
 */
function computeEffectiveTools(
	tools: string[] | undefined,
	disallowedTools: string[] | undefined
): string[] | undefined {
	if (!tools && !disallowedTools) return undefined;
	if (tools && !disallowedTools) return tools;

	const base = tools ?? PI_BUILTIN_TOOLS;
	const deny = new Set(disallowedTools);
	return base.filter((t) => !deny.has(t));
}

/** Result of agent resolution — always produces an agent config. */
interface ResolvedAgent {
	agent: AgentConfig;
	/** How the agent was resolved */
	resolution: "exact" | "match" | "ephemeral";
	/** Original requested name (for transparency in output) */
	requestedName: string;
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
function scoreAgentMatch(agentName: string, requestedName: string): number {
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

/** Minimum score threshold for best-match to be accepted over ephemeral. */
const MATCH_THRESHOLD = 40;

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
function resolveAgentForExecution(
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
function coerceArray<T>(value: T[] | string | undefined | null): T[] | undefined {
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

// Spinner frames
const SPINNER_FRAMES = getSpinner();

/** Tracks a foreground subagent currently executing inline. */
interface RunningSubagent {
	id: string;
	agent: string;
	task: string;
	startTime: number;
}

const runningSubagents = new Map<string, RunningSubagent>();

/** Tracks a background subagent running as a detached process. */
interface BackgroundSubagent {
	id: string;
	agent: string;
	task: string;
	startTime: number;
	process: ReturnType<typeof spawn>;
	result: SingleResult;
	status: "running" | "completed" | "failed";
	tmpPromptDir?: string;
	tmpPromptPath?: string;
}

const backgroundSubagents = new Map<string, BackgroundSubagent>();
let interopStateRequestCleanup: (() => void) | undefined;

/**
 * Build the current typed subagent snapshot for cross-extension consumers.
 *
 * @returns Snapshot payload with foreground and background subagents
 */
function buildSubagentSnapshot(): {
	background: InteropSubagentView[];
	foreground: InteropSubagentView[];
} {
	const background: InteropSubagentView[] = [...backgroundSubagents.values()].map((subagent) => ({
		agent: subagent.agent,
		id: subagent.id,
		startTime: subagent.startTime,
		status: subagent.status,
		task: subagent.task,
	}));
	const foreground: InteropSubagentView[] = [...runningSubagents.values()].map((subagent) => ({
		agent: subagent.agent,
		id: subagent.id,
		startTime: subagent.startTime,
		status: "running",
		task: subagent.task,
	}));
	return { background, foreground };
}

/**
 * Publish subagent snapshot updates for typed cross-extension state sync.
 *
 * @param piEvents - Shared event bus instance
 * @returns void
 */
function publishSubagentSnapshot(piEvents?: ExtensionAPI["events"]): void {
	if (!piEvents) return;
	const snapshot = buildSubagentSnapshot();
	emitInteropEvent(piEvents, INTEROP_EVENT_NAMES.subagentsSnapshot, snapshot);
}

const _backgroundRequested = false;

// Background subagents are rendered by tasks extension via typed interop events.
/**
 * No-op placeholder - background widget is rendered by the tasks extension.
 */
function updateBackgroundWidget(): void {
	// No-op - tasks extension handles rendering
}
// widgetIntervalId is defined below in updateWidget section
const _spinnerFrame = 0;
let uiContext: ExtensionContext | null = null;

/**
 * Generates a random 8-character ID for tracking subagent invocations.
 * @returns Random alphanumeric ID string
 */
function generateId(): string {
	return Math.random().toString(36).substring(2, 10);
}

/**
 * Formats milliseconds as human-readable duration (e.g., "5s", "2m30s").
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${minutes}m${secs}s`;
}

// Fixed-width box: 60 chars wide
const _BOX_WIDTH = 60;

/**
 * Pad a string with spaces to a target length, accounting for ANSI escape codes.
 * @param str - String to pad (may contain ANSI codes)
 * @param len - Target length
 * @returns Padded string
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
const ANSI_STRIP_RE = /\x1b\[[0-9;]*m/g;

function _padRight(str: string, len: number): string {
	const stripped = str.replace(ANSI_STRIP_RE, "");
	const padding = Math.max(0, len - stripped.length);
	return str + " ".repeat(padding);
}

// Store interval on globalThis to clear across reloads
const G = globalThis;
if (G.__piSubagentWidgetInterval) {
	clearInterval(G.__piSubagentWidgetInterval);
	G.__piSubagentWidgetInterval = null;
}

/**
 * Updates the widget and stops the interval if no background tasks remain.
 */
function updateWidget(): void {
	updateBackgroundWidget();

	// Stop interval if no more running background tasks
	const bgRunning = [...backgroundSubagents.values()].filter((s) => s.status === "running");
	if (bgRunning.length === 0 && G.__piSubagentWidgetInterval) {
		clearInterval(G.__piSubagentWidgetInterval);
		G.__piSubagentWidgetInterval = null;
	}
}

/**
 * Starts periodic widget updates if not already running.
 */
function startWidgetUpdates(): void {
	if (G.__piSubagentWidgetInterval) return; // Already running
	updateWidget(); // Immediate update
	G.__piSubagentWidgetInterval = setInterval(updateWidget, 500); // Update every 500ms
}

/**
 * Clears foreground subagent tracking without affecting background subagents.
 */
function clearForegroundSubagents(piEvents?: ExtensionAPI["events"]): void {
	// Only clears the foreground subagent tracking (for parallel inline display)
	// Does NOT touch background subagents or their widget
	runningSubagents.clear();
	publishSubagentSnapshot(piEvents);
}

/**
 * Clears foreground subagents while preserving background subagent tracking.
 *
 * @param piEvents - Shared event bus for state publication
 * @returns void
 */
function clearAllSubagents(piEvents?: ExtensionAPI["events"]): void {
	runningSubagents.clear();
	publishSubagentSnapshot(piEvents);
	// Don't clear background subagents - they persist across tool calls
	// Only clear widget if NO background subagents are running
	// Background subagents rendered by tasks extension, no separate widget needed
}

/**
 * Register a foreground subagent for cross-extension activity rendering.
 *
 * @param id - Subagent tracking ID
 * @param agent - Agent name
 * @param task - Task description
 * @param startTime - Start timestamp in ms
 * @param piEvents - Shared event bus for snapshot updates
 * @returns void
 */
function registerForegroundSubagent(
	id: string,
	agent: string,
	task: string,
	startTime: number,
	piEvents?: ExtensionAPI["events"]
): void {
	runningSubagents.set(id, { id, agent, task, startTime });
	publishSubagentSnapshot(piEvents);
	startWidgetUpdates();
}

/**
 * Remove a foreground subagent and publish updated state.
 *
 * @param id - Subagent tracking ID
 * @param piEvents - Shared event bus for snapshot updates
 * @returns void
 */
function completeForegroundSubagent(id: string, piEvents?: ExtensionAPI["events"]): void {
	runningSubagents.delete(id);
	publishSubagentSnapshot(piEvents);
	updateWidget();
}

/**
 * Format a token count as a compact string (e.g., 1500 → "1.5k").
 * @param count - Token count
 * @returns Compact formatted string
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Format token usage stats into a compact one-line summary.
 * @param usage - Token usage breakdown
 * @param model - Optional model name to append
 * @returns Formatted usage string (e.g., "3 turns ↑1.2k ↓500 $0.0042")
 */
function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

/**
 * Format a tool call as a compact one-line summary for display.
 * @param toolName - Name of the tool called
 * @param args - Tool call arguments
 * @param themeFg - Theme foreground color function
 * @returns Formatted string showing tool name and key arguments
 */
function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/** Token usage statistics from a subagent execution. */
interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Result from a single subagent execution. */
interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "ephemeral" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

/** Details passed to renderResult for subagent tool execution display. */
interface SubagentDetails {
	mode: "single" | "parallel" | "centipede";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	spinnerFrame?: number; // For animated spinner during execution
	centipedeSteps?: { agent: string; task: string }[]; // All centipede steps for progress display
}

/**
 * Extract the final assistant text output from a message history.
 * @param messages - Array of conversation messages
 * @returns Last assistant text content, or empty string
 */
function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/** Union type for displayable items extracted from subagent messages. */
type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

/**
 * Extract all displayable items (text + tool calls) from assistant messages.
 * @param messages - Array of conversation messages
 * @returns Ordered array of display items
 */
function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/**
 * Map items with a concurrency limit using a worker pool pattern.
 * @param items - Items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Async function to apply to each item
 * @returns Array of results in original order
 */
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Write a subagent prompt to a temporary file for the pi subprocess.
 * @param agentName - Agent name (sanitized for filename)
 * @param prompt - System prompt content
 * @returns Object with temp directory and file path
 */
function writePromptToTempFile(
	agentName: string,
	prompt: string
): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

/**
 * Spawn a background subagent process.
 * @param defaultCwd - Default working directory
 * @param agents - Available agent configurations
 * @param agentName - Name of the agent to spawn
 * @param task - Task to delegate
 * @param cwd - Optional working directory override
 * @param piEvents - Optional event emitter for subagent lifecycle events
 * @param session - Optional session file path for persistent teammates
 * @returns Background subagent ID, error string if model unresolvable, or null if agent not found
 */
async function spawnBackgroundSubagent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	piEvents?: ExtensionAPI["events"],
	session?: string,
	modelOverride?: string,
	parentModelId?: string,
	defaults?: AgentDefaults,
	hints?: RoutingHints
): Promise<string | null> {
	const resolved = resolveAgentForExecution(agentName, agents, defaults);
	// Route model via fuzzy resolution + auto-routing
	const routing = await routeModel(
		task,
		modelOverride,
		resolved.agent.model,
		parentModelId,
		resolved.agent.description,
		hints
	);
	if (!routing.ok) return routing.error;
	const agent = { ...resolved.agent, model: routing.model.id };
	const agentSource = resolved.resolution === "ephemeral" ? ("ephemeral" as const) : agent.source;
	const effectiveCwd = cwd ?? defaultCwd;

	const args: string[] = session
		? ["--mode", "json", "-p", "--session", session]
		: ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--models", agent.model);
	const effectiveTools = computeEffectiveTools(agent.tools, agent.disallowedTools);
	if (effectiveTools && effectiveTools.length > 0) args.push("--tools", effectiveTools.join(","));
	if (agent.skills && agent.skills.length > 0) {
		for (const skill of agent.skills) args.push("--skill", skill);
	}

	let tmpPromptDir: string | undefined;
	let tmpPromptPath: string | undefined;

	// Inject maxTurns budget hint into system prompt
	let systemPrompt = agent.systemPrompt;
	if (agent.maxTurns) {
		const budget = `You have a maximum of ${agent.maxTurns} tool-use turns for this task. Plan your approach to complete within this budget. If you are running low, output your best result immediately.\n\n`;
		systemPrompt = budget + systemPrompt;
	}

	if (systemPrompt.trim()) {
		const tmp = writePromptToTempFile(agent.name, systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
	}

	const expandedTask = await expandFileReferences(task, effectiveCwd);
	args.push(`Task: ${expandedTask}`);

	const childEnv: Record<string, string> = { ...process.env, PI_IS_SUBAGENT: "1" } as Record<
		string,
		string
	>;
	if (agent.allowedAgentTypes) {
		childEnv.PI_ALLOWED_AGENT_TYPES = agent.allowedAgentTypes.join(",");
	}
	if (agent.mcpServers && agent.mcpServers.length > 0) {
		childEnv.PI_MCP_SERVERS = agent.mcpServers.join(",");
	}

	const proc = spawn("pi", args, {
		cwd: effectiveCwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: childEnv,
	});

	const id = `bg_${generateId()}`;

	// Emit subagent_start event
	piEvents?.emit("subagent_start", {
		agent_id: id,
		agent_type: agentName,
		task,
		cwd: effectiveCwd,
		background: true,
	} satisfies SubagentStartEvent);
	const result: SingleResult = {
		agent: agentName,
		agentSource,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model: agent.model,
	};

	const bgSubagent: BackgroundSubagent = {
		id,
		agent: agentName,
		task,
		startTime: Date.now(),
		process: proc,
		result,
		status: "running",
		tmpPromptDir,
		tmpPromptPath,
	};

	backgroundSubagents.set(id, bgSubagent);
	publishSubagentSnapshot(piEvents);

	// Collect output
	let buffer = "";
	let bgTurnCount = 0;
	proc.stdout.on("data", (data) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);

				// Emit subagent_tool_call when tool starts
				if (event.type === "tool_call_start") {
					bgTurnCount++;
					// Hard enforcement: kill after maxTurns tool calls
					if (agent.maxTurns && bgTurnCount >= agent.maxTurns) {
						proc.kill("SIGTERM");
					}

					piEvents?.emit("subagent_tool_call", {
						agent_id: id,
						agent_type: agentName,
						tool_name: event.toolName,
						tool_call_id: event.toolCallId,
						tool_input: event.input ?? {},
					} satisfies SubagentToolCallEvent);
				}

				if (event.type === "message_end" && event.message) {
					result.messages.push(event.message);
					if (event.message.role === "assistant") {
						result.usage.turns = (result.usage.turns || 0) + 1;
						const usage = event.message.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
						}
					}
				}
				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message);
					// Emit subagent_tool_result when tool completes
					const resultMsg = event.message;
					piEvents?.emit("subagent_tool_result", {
						agent_id: id,
						agent_type: agentName,
						tool_name: resultMsg.toolName ?? "unknown",
						tool_call_id: resultMsg.toolCallId ?? "",
						is_error: resultMsg.isError ?? false,
					} satisfies SubagentToolResultEvent);
				}
			} catch {
				/* ignore parse errors */
			}
		}
	});

	proc.stderr.on("data", (data) => {
		result.stderr += data.toString();
	});

	proc.on("close", (code) => {
		if (buffer.trim()) {
			try {
				const event = JSON.parse(buffer);
				if (event.type === "message_end" && event.message) {
					result.messages.push(event.message);
				}
			} catch {
				/* ignore */
			}
		}
		result.exitCode = code ?? 0;
		bgSubagent.status = code === 0 ? "completed" : "failed";
		publishSubagentSnapshot(piEvents);

		// Emit subagent_stop event
		piEvents?.emit("subagent_stop", {
			agent_id: id,
			agent_type: agentName,
			task,
			exit_code: code ?? 0,
			result: getFinalOutput(result.messages),
			background: true,
		} satisfies SubagentStopEvent);

		// Cleanup temp files
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}

		updateWidget();

		// Post inline result for background subagent completion
		if (piRef && isInlineResultsEnabled()) {
			const duration = formatDuration(Date.now() - bgSubagent.startTime);
			const finalOutput = getFinalOutput(result.messages);
			const preview = extractPreview(finalOutput, 3, 80);

			piRef.sendMessage({
				customType: "subagent-complete",
				content: `Agent ${agentName} ${bgSubagent.status} (${duration})`,
				display: true,
				details: {
					agentId: id,
					agentName,
					task,
					exitCode: code ?? 0,
					duration,
					preview,
					status: bgSubagent.status as "completed" | "failed",
					timestamp: Date.now(),
				} satisfies SubagentCompleteDetails,
			});
		}
	});

	// Start widget updates immediately after spawning
	if (uiContext) {
		startWidgetUpdates();
		updateBackgroundWidget(); // Force immediate update
	}

	return id;
}

/** Callback for streaming partial results during subagent execution. */
type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Run a single subagent as a pi subprocess and collect its output.
 * @param defaultCwd - Default working directory
 * @param agents - Available agent configurations
 * @param agentName - Name of the agent to run
 * @param task - Task to delegate
 * @param cwd - Optional working directory override
 * @param step - Optional step index (for centipede mode)
 * @param signal - Optional abort signal
 * @param onUpdate - Optional callback for streaming partial results
 * @param makeDetails - Factory for SubagentDetails
/** Patterns in stderr/errorMessage that indicate a model-level failure (not a task failure). */
const MODEL_ERROR_PATTERNS = [
	"usage limit",
	"rate limit",
	"quota exceeded",
	"authentication",
	"unauthorized",
	"api key",
	"billing",
	"capacity",
	"overloaded",
	"503",
	"429",
];

/**
 * Checks if a subagent failure looks like a model/API error rather than a task error.
 *
 * Model errors (quota, auth, rate limits) are retryable with a different model.
 * Task errors (bad tool call, runtime crash) are not.
 *
 * @param result - The failed subagent result
 * @returns true if the error looks model-level and retryable
 */
function isModelLevelError(result: SingleResult): boolean {
	const text = `${result.stderr} ${result.errorMessage ?? ""}`.toLowerCase();
	return MODEL_ERROR_PATTERNS.some((p) => text.includes(p));
}

/**
 * Run a single subagent. Retries with fallback models on API/quota errors.
 */
async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	piEvents?: ExtensionAPI["events"],
	session?: string,
	modelOverride?: string,
	parentModelId?: string,
	defaults?: AgentDefaults,
	hints?: RoutingHints
): Promise<SingleResult> {
	const resolved = resolveAgentForExecution(agentName, agents, defaults);
	// Route model via fuzzy resolution + auto-routing
	const routing = await routeModel(
		task,
		modelOverride,
		resolved.agent.model,
		parentModelId,
		resolved.agent.description,
		hints
	);
	if (!routing.ok) {
		// Return a failed SingleResult so the caller can surface the error
		return {
			agent: agentName,
			agentSource: resolved.resolution === "ephemeral" ? "ephemeral" : resolved.agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: routing.error,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			errorMessage: routing.error,
			step,
		};
	}
	const agent = { ...resolved.agent, model: routing.model.id };
	const agentSource = resolved.resolution === "ephemeral" ? ("ephemeral" as const) : agent.source;
	const taskId = `fg_${generateId()}`;
	const effectiveCwd = cwd ?? defaultCwd;

	registerForegroundSubagent(taskId, agentName, task, Date.now(), piEvents);

	// Emit subagent_start event
	piEvents?.emit("subagent_start", {
		agent_id: taskId,
		agent_type: agentName,
		task,
		cwd: effectiveCwd,
		background: false,
	} satisfies SubagentStartEvent);

	const args: string[] = session
		? ["--mode", "json", "-p", "--session", session]
		: ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--models", agent.model);
	const fgEffectiveTools = computeEffectiveTools(agent.tools, agent.disallowedTools);
	if (fgEffectiveTools && fgEffectiveTools.length > 0)
		args.push("--tools", fgEffectiveTools.join(","));
	if (agent.skills && agent.skills.length > 0) {
		for (const skill of agent.skills) args.push("--skill", skill);
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	/** Cleanup temp prompt files (safe to call multiple times). */
	const cleanupTempFiles = () => {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
			tmpPromptPath = null;
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
			tmpPromptDir = null;
		}
	};

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource,
		task,
		exitCode: -1, // -1 = still running, will be set to actual exit code when done
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model: agent.model,
		step,
	};

	/** Timestamp of the last emitted update, used for throttling. */
	let lastEmitTime = 0;
	const EMIT_THROTTLE_MS = 500;

	/**
	 * Emit a partial-result update to the parent tool framework.
	 * Throttled to max ~2 updates/sec to avoid TUI flicker during rapid tool calls.
	 * @param force - Bypass throttle (e.g., for first update or significant state changes)
	 */
	const emitUpdate = (force?: boolean) => {
		if (!onUpdate) return;
		const now = Date.now();
		if (!force && now - lastEmitTime < EMIT_THROTTLE_MS) return;
		lastEmitTime = now;
		onUpdate({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	try {
		// Inject maxTurns budget hint into system prompt
		let fgSystemPrompt = agent.systemPrompt;
		if (agent.maxTurns) {
			const budget = `You have a maximum of ${agent.maxTurns} tool-use turns for this task. Plan your approach to complete within this budget. If you are running low, output your best result immediately.\n\n`;
			fgSystemPrompt = budget + fgSystemPrompt;
		}

		if (fgSystemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, fgSystemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const expandedTask = await expandFileReferences(task, effectiveCwd);
		args.push(`Task: ${expandedTask}`);
		let wasAborted = false;

		const fgChildEnv: Record<string, string> = {
			...process.env,
			PI_IS_SUBAGENT: "1",
		} as Record<string, string>;
		if (agent.allowedAgentTypes) {
			fgChildEnv.PI_ALLOWED_AGENT_TYPES = agent.allowedAgentTypes.join(",");
		}
		if (agent.mcpServers && agent.mcpServers.length > 0) {
			fgChildEnv.PI_MCP_SERVERS = agent.mcpServers.join(",");
		}

		let fgTurnCount = 0;
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: fgChildEnv,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				// biome-ignore lint/suspicious/noExplicitAny: pi subagent JSON protocol has dynamic shape
				let event: Record<string, any>;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Emit subagent_tool_call when tool starts
				if (event.type === "tool_call_start") {
					fgTurnCount++;
					// Hard enforcement: kill after maxTurns tool calls
					if (agent.maxTurns && fgTurnCount >= agent.maxTurns) {
						proc.kill("SIGTERM");
					}

					piEvents?.emit("subagent_tool_call", {
						agent_id: taskId,
						agent_type: agentName,
						tool_name: event.toolName,
						tool_call_id: event.toolCallId,
						tool_input: event.input ?? {},
					} satisfies SubagentToolCallEvent);
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					// Emit subagent_tool_result when tool completes
					const resultMsg = event.message;
					piEvents?.emit("subagent_tool_result", {
						agent_id: taskId,
						agent_type: agentName,
						tool_name: resultMsg.toolName ?? "unknown",
						tool_call_id: resultMsg.toolCallId ?? "",
						is_error: resultMsg.isError ?? false,
					} satisfies SubagentToolResultEvent);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");

		// Annotate result when maxTurns killed the process
		if (agent.maxTurns && fgTurnCount >= agent.maxTurns) {
			currentResult.stderr += `\n[Terminated: reached maxTurns limit of ${agent.maxTurns}]`;
		}

		// Emit subagent_stop event
		piEvents?.emit("subagent_stop", {
			agent_id: taskId,
			agent_type: agentName,
			task,
			exit_code: exitCode,
			result: getFinalOutput(currentResult.messages),
			background: false,
		} satisfies SubagentStopEvent);

		// Retry with fallback model on API/quota errors (not task-level failures)
		if (
			currentResult.exitCode !== 0 &&
			routing.ok &&
			routing.fallbacks.length > 0 &&
			isModelLevelError(currentResult)
		) {
			completeForegroundSubagent(taskId, piEvents);
			cleanupTempFiles();
			// Retry with the next fallback model directly (no re-routing)
			const nextModel = routing.fallbacks[0];
			return runSingleAgent(
				defaultCwd,
				agents,
				agentName,
				task,
				cwd,
				step,
				signal,
				onUpdate,
				makeDetails,
				piEvents,
				session,
				nextModel.id,
				parentModelId,
				defaults
				// Clear hints — the explicit model override will be used
			);
		}

		return currentResult;
	} finally {
		completeForegroundSubagent(taskId, piEvents);
		cleanupTempFiles();
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(
		Type.String({ description: "Model ID to use for this agent (overrides agent default)" })
	),
});

const CentipedeItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(
		Type.String({ description: "Model ID to use for this step (overrides agent default)" })
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Name of the agent to invoke (for single mode)" })
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })
	),
	centipede: Type.Optional(
		Type.Array(CentipedeItem, { description: "Array of {agent, task} for sequential execution" })
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description:
				"Deprecated — project-local agents now run without confirmation. " +
				"Kept for backward compatibility; ignored at runtime.",
			default: true,
		})
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process (single mode)" })
	),
	background: Type.Optional(
		Type.Boolean({
			description: "Run in background, return immediately. Use subagent_status to check.",
			default: false,
		})
	),
	session: Type.Optional(
		Type.String({
			description:
				"Session file path for persistent teammates. Creates or continues a session. " +
				"On first call, creates the session file. On subsequent calls, resumes the conversation " +
				"with full history. Use for long-lived agents that need multiple interactions.",
		})
	),
	model: Type.Optional(
		Type.String({ description: "Model ID to use (overrides agent default). For single mode." })
	),
	costPreference: Type.Optional(
		StringEnum(["eco", "balanced", "premium"] as const, {
			description:
				'Cost preference for auto-routing. "eco" = cheapest capable model, ' +
				'"balanced" = best fit for task complexity, "premium" = most capable. ' +
				"Only used when no explicit model is specified.",
		})
	),
	taskType: Type.Optional(
		StringEnum(["code", "vision", "text"] as const, {
			description:
				"Override the auto-detected task type. " +
				'"code" for coding tasks, "vision" for image analysis, "text" for docs/planning.',
		})
	),
	complexity: Type.Optional(
		Type.Number({
			description:
				"Override the auto-detected task complexity (1-5). " +
				"1=trivial, 2=simple, 3=moderate, 4=complex, 5=expert.",
			minimum: 1,
			maximum: 5,
		})
	),
});

/**
 * Subagent lifecycle events (aligned with Claude Code hook naming, snake_case)
 *
 * Listen in other extensions:
 *   pi.events.on("subagent_start", (data) => { ... });
 *   pi.events.on("subagent_stop", (data) => { ... });
 *   pi.events.on("subagent_tool_call", (data) => { ... });  // Pi extension
 *   pi.events.on("subagent_tool_result", (data) => { ... }); // Pi extension
 */
export interface SubagentStartEvent {
	agent_id: string;
	agent_type: string;
	task: string;
	cwd: string;
	background: boolean;
}

/** Event emitted when a subagent completes, for stop hooks to inspect. */
export interface SubagentStopEvent {
	agent_id: string;
	agent_type: string;
	task: string;
	exit_code: number;
	result: string;
	background: boolean;
}

/** Pi extension - not in Claude Code hooks */
export interface SubagentToolCallEvent {
	agent_id: string;
	agent_type: string;
	tool_name: string;
	tool_call_id: string;
	tool_input: Record<string, unknown>;
}

/** Pi extension - not in Claude Code hooks */
export interface SubagentToolResultEvent {
	agent_id: string;
	agent_type: string;
	tool_name: string;
	tool_call_id: string;
	is_error: boolean;
}

/** Details for inline subagent-complete messages. */
interface SubagentCompleteDetails {
	readonly agentId: string;
	readonly agentName: string;
	readonly task: string;
	readonly exitCode: number;
	readonly duration: string;
	readonly preview: string[];
	readonly status: "completed" | "failed";
	readonly timestamp: number;
}

/** Reference to pi extension API, for sendMessage from async completion handlers. */
let piRef: ExtensionAPI | null = null;

export default function (pi: ExtensionAPI) {
	// Skip in subagent workers - they don't need to spawn subagents
	if (process.env.PI_IS_SUBAGENT === "1") {
		return;
	}

	piRef = pi;

	// Register inline result renderer for background subagent completions
	pi.registerMessageRenderer<SubagentCompleteDetails>(
		"subagent-complete",
		(message, _options, theme) => {
			const d = message.details;
			if (!d) return undefined;

			const icon =
				d.status === "completed"
					? theme.fg("success", getIcon("success"))
					: theme.fg("error", getIcon("error"));
			const label = d.status === "completed" ? "completed" : "failed";

			let text = `${icon} ${theme.fg("muted", "🤖 Agent")} ${theme.fg("accent", d.agentName)} ${theme.fg("muted", label)} ${theme.fg("dim", `(${d.duration})`)}`;

			if (d.preview.length > 0) {
				for (const line of d.preview) {
					text += `\n  ${theme.fg("dim", line)}`;
				}
			} else {
				text += `\n  ${theme.fg("dim", "(no output)")}`;
			}

			text += `\n  ${theme.fg("muted", "Expand tool result to view full conversation")}`;

			return new Text(text, 0, 0);
		}
	);

	// Clear any stale widget state on load/reload
	runningSubagents.clear();
	if (G.__piSubagentWidgetInterval) {
		clearInterval(G.__piSubagentWidgetInterval);
		G.__piSubagentWidgetInterval = null;
	}

	interopStateRequestCleanup?.();
	interopStateRequestCleanup = onInteropEvent(pi.events, INTEROP_EVENT_NAMES.stateRequest, () => {
		publishSubagentSnapshot(pi.events);
	});

	// Also clear on session start
	pi.on("session_start", async (_event, ctx) => {
		uiContext = ctx;
		clearAllSubagents(pi.events);
		publishSubagentSnapshot(pi.events);
		// Background subagents are now rendered by tasks extension
	});

	// Kill all running background subagents on interrupt (agent_end).
	// Background agents are delegated cognitive work — if the user hits Esc,
	// they want all agent work to stop. Background bash tasks (dev servers,
	// builds) are infrastructure and intentionally survive interrupts.
	pi.on("agent_end", async () => {
		let mutated = false;
		for (const [_id, bg] of backgroundSubagents) {
			if (bg.status === "running" && bg.process && !bg.process.killed) {
				bg.process.kill("SIGTERM");
				bg.status = "failed";
				bg.result.exitCode = 1;
				bg.result.stopReason = "interrupted";
				mutated = true;
				setTimeout(() => {
					if (!bg.process.killed) bg.process.kill("SIGKILL");
				}, 3000);
			}
		}
		if (mutated) publishSubagentSnapshot(pi.events);
	});

	// No custom shortcut - use subagent_status tool to check background subagents

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate tasks to specialized subagents with isolated context. Modes: single (agent + task), parallel (tasks array), centipede (sequential with {previous} placeholder). Default agent scope is "user" (from ~/.tallow/agents). To include project-local agents, set agentScope: "both". Missing agent names recover gracefully via best-match or ephemeral fallback.

MODEL SELECTION:
- model: explicit model name (fuzzy matched, e.g. "opus", "haiku", "gemini flash")
- No model specified: auto-routes based on task type and complexity
- costPreference: "eco" (cheapest capable), "balanced" (default), "premium" (best available)
- taskType: override auto-detected type ("code", "vision", "text")
- complexity: override auto-detected complexity (1=trivial to 5=expert)
- If the selected model fails (quota/auth), automatically retries with the next best candidate

WHEN TO USE PARALLEL:
- Tasks are independent (don't depend on each other)
- Can run concurrently without file conflicts
- Each task is self-contained

WHEN TO USE BACKGROUND (background: true):
- Long-running tasks user doesn't need to wait for
- Want to continue conversation while tasks run
- Multiple async tasks to monitor later

WHEN TO USE CENTIPEDE:
- Sequential steps where each depends on previous
- Use {previous} placeholder for prior output

WHEN NOT TO USE SUBAGENTS:
- Simple tasks you can do directly
- Tasks modifying same files (use sequential)
- Need real-time back-and-forth interaction`,
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			uiContext = ctx;

			// Resolve parent model once for inheritance
			const parentModelId = ctx.model?.id;

			// Build per-call routing hints from params
			const routingHints: RoutingHints | undefined =
				params.costPreference || params.taskType || params.complexity
					? {
							costPreference: params.costPreference as RoutingHints["costPreference"],
							taskType: params.taskType as RoutingHints["taskType"],
							complexity: params.complexity,
						}
					: undefined;

			// Enforce agent type restrictions from parent agent
			const allowedTypes = process.env.PI_ALLOWED_AGENT_TYPES?.split(",").filter(Boolean);
			if (allowedTypes && allowedTypes.length > 0) {
				const requestedAgents: string[] = [];
				if (params.agent) requestedAgents.push(params.agent);
				for (const t of coerceArray(params.tasks) ?? []) {
					if (t?.agent) requestedAgents.push(t.agent);
				}
				for (const c of coerceArray(params.centipede) ?? []) {
					if (c?.agent) requestedAgents.push(c.agent);
				}
				const blocked = requestedAgents.filter((a) => !allowedTypes.includes(a));
				if (blocked.length > 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Agent type restriction: cannot spawn ${blocked.join(", ")}. Allowed: ${allowedTypes.join(", ")}`,
							},
						],
						details: { mode: "single" as const, agentScope: "user", results: [] },
						isError: true,
					};
				}
			}

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const defaults = discovery.defaults;

			// Coerce tasks/centipede: LLMs sometimes pass arrays as JSON strings,
			// which causes .length to return character count instead of element count.
			const tasks = coerceArray(params.tasks);
			const centipede = coerceArray(params.centipede);

			const hasCentipede = (centipede?.length ?? 0) > 0;
			const hasTasks = (tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasCentipede) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(
					mode: "single" | "parallel" | "centipede",
					centipedeSteps?: { agent: string; task: string }[]
				) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					centipedeSteps,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (centipede && centipede.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				const centipedeSteps = centipede.map((s) => ({ agent: s.agent, task: s.task }));
				const mkCentipedeDetails = makeDetails("centipede", centipedeSteps);

				// Spinner animation for centipede progress (same pattern as parallel mode)
				let centipedeSpinnerFrame = 0;
				let latestPartialResult: SingleResult | undefined;
				let spinnerInterval: NodeJS.Timeout | null = null;

				const emitCentipedeUpdate = () => {
					if (onUpdate) {
						const allResults = latestPartialResult
							? [...results, latestPartialResult]
							: [...results];
						const details = mkCentipedeDetails(allResults);
						details.spinnerFrame = centipedeSpinnerFrame;
						onUpdate({
							content: [
								{
									type: "text",
									text: getFinalOutput(latestPartialResult?.messages ?? []) || "(running...)",
								},
							],
							details,
						});
					}
				};

				if (onUpdate) {
					spinnerInterval = setInterval(() => {
						centipedeSpinnerFrame = (centipedeSpinnerFrame + 1) % SPINNER_FRAMES.length;
						emitCentipedeUpdate();
					}, 100);
				}

				try {
					for (let i = 0; i < centipede.length; i++) {
						const step = centipede[i];
						ctx.ui.setWorkingMessage(
							`Running centipede step ${i + 1}/${centipede.length}: ${step.agent}`
						);
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
						latestPartialResult = undefined;

						// Create update callback that includes all previous results
						const centipedeUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										latestPartialResult = currentResult;
										emitCentipedeUpdate();
									}
								}
							: undefined;

						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							step.agent,
							taskWithContext,
							step.cwd,
							i + 1,
							signal,
							centipedeUpdate,
							mkCentipedeDetails,
							pi.events,
							undefined,
							step.model,
							parentModelId,
							defaults,
							routingHints
						);
						results.push(result);
						latestPartialResult = undefined;

						const isError =
							result.exitCode !== 0 ||
							result.stopReason === "error" ||
							result.stopReason === "aborted";
						if (isError) {
							if (spinnerInterval) clearInterval(spinnerInterval);
							ctx.ui.setWorkingMessage();
							const errorMsg =
								result.errorMessage ||
								result.stderr ||
								getFinalOutput(result.messages) ||
								"(no output)";
							return {
								content: [
									{
										type: "text",
										text: `Centipede stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
									},
								],
								details: mkCentipedeDetails(results),
								isError: true,
							};
						}
						previousOutput = getFinalOutput(result.messages);
					}
					if (spinnerInterval) clearInterval(spinnerInterval);
					ctx.ui.setWorkingMessage();
					return {
						content: [
							{
								type: "text",
								text: getFinalOutput(results.at(-1)?.messages ?? []) || "(no output)",
							},
						],
						details: mkCentipedeDetails(results),
					};
				} finally {
					if (spinnerInterval) clearInterval(spinnerInterval);
				}
			}

			if (tasks && tasks.length > 0) {
				if (tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Background mode: spawn without awaiting, return immediately
				if (params.background) {
					const taskIds: string[] = [];
					const errors: string[] = [];
					for (const t of tasks) {
						const result = await spawnBackgroundSubagent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							pi.events,
							undefined,
							(t as { model?: string }).model,
							parentModelId,
							defaults,
							routingHints
						);
						if (result?.startsWith("bg_")) taskIds.push(result);
						else if (result) errors.push(result);
					}
					const parts = [];
					if (taskIds.length > 0) {
						parts.push(
							`Started ${taskIds.length} background subagent(s):\n${taskIds.map((id) => `- ${id}`).join("\n")}\n\nUse subagent_status to check progress.`
						);
					}
					if (errors.length > 0) parts.push(`Errors:\n${errors.join("\n")}`);
					return {
						content: [{ type: "text", text: parts.join("\n\n") || "No subagents started." }],
						details: makeDetails("parallel")([]),
						isError: errors.length > 0 && taskIds.length === 0,
					};
				}

				// Clear any stale foreground subagent entries from previous runs
				// (preserves background subagents)
				clearForegroundSubagents(pi.events);

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < tasks.length; i++) {
					allResults[i] = {
						agent: tasks[i].agent,
						agentSource: "unknown",
						task: tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 0,
						},
					};
				}

				let spinnerFrame = 0;
				let spinnerInterval: NodeJS.Timeout | null = null;

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						const details = makeDetails("parallel")([...allResults]);
						details.spinnerFrame = spinnerFrame;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details,
						});
					}
				};

				// Start spinner animation
				spinnerInterval = setInterval(() => {
					spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
					emitParallelUpdate();
				}, 100);

				// Set contextual working message for synchronous parallel execution
				ctx.ui.setWorkingMessage(`Waiting for ${tasks.length} parallel agents to finish`);

				let results: SingleResult[];
				try {
					results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
						// No widget tracking for foreground tasks - they show inline in tool result
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							pi.events,
							undefined,
							(t as { model?: string }).model,
							parentModelId,
							defaults,
							routingHints
						);
						allResults[index] = result;
						return result;
					});
				} finally {
					// Cleanup spinner animation
					if (spinnerInterval) {
						clearInterval(spinnerInterval);
						spinnerInterval = null;
					}
					// Restore default working message
					ctx.ui.setWorkingMessage();
				}

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				// Background mode for single agent: spawn without awaiting
				if (params.background) {
					const result = await spawnBackgroundSubagent(
						ctx.cwd,
						agents,
						params.agent,
						params.task,
						params.cwd,
						pi.events,
						params.session,
						params.model,
						parentModelId,
						defaults,
						routingHints
					);
					if (result?.startsWith("bg_")) {
						return {
							content: [
								{
									type: "text",
									text: `Started background subagent: ${result}\n\nUse subagent_status to check progress.`,
								},
							],
							details: makeDetails("single")([]),
						};
					}
					return {
						content: [{ type: "text", text: result || "Failed to start background subagent" }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				// Set contextual working message for synchronous single agent
				ctx.ui.setWorkingMessage(`Running agent: ${params.agent}`);

				// Spinner animation for single agent
				let singleSpinnerFrame = 0;
				let singleSpinnerInterval: NodeJS.Timeout | null = null;
				let lastUpdate: AgentToolResult<SubagentDetails> | null = null;

				const emitSingleUpdate = () => {
					if (onUpdate && lastUpdate) {
						if (lastUpdate.details) {
							(lastUpdate.details as unknown as Record<string, unknown>).spinnerFrame =
								singleSpinnerFrame;
						}
						onUpdate(lastUpdate);
					}
				};

				if (onUpdate) {
					singleSpinnerInterval = setInterval(() => {
						singleSpinnerFrame = (singleSpinnerFrame + 1) % SPINNER_FRAMES.length;
						emitSingleUpdate();
					}, 100);
				}

				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					(update) => {
						lastUpdate = update;
						emitSingleUpdate();
					},
					makeDetails("single"),
					pi.events,
					params.session,
					params.model,
					parentModelId,
					defaults,
					routingHints
				);

				if (singleSpinnerInterval) {
					clearInterval(singleSpinnerInterval);
				}
				ctx.ui.setWorkingMessage();
				const isError =
					result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage ||
						result.stderr ||
						getFinalOutput(result.messages) ||
						"(no output)";
					return {
						content: [
							{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` },
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			const modelTag = args.model ? ` ${theme.fg("dim", args.model)}` : "";
			const centipedeArr = coerceArray(args.centipede);
			const tasksArr = coerceArray(args.tasks);
			if (centipedeArr && centipedeArr.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `centipede (${centipedeArr.length} steps)`) +
					theme.fg("muted", ` [${scope}]`) +
					modelTag;
				for (let i = 0; i < Math.min(centipedeArr.length, 3); i++) {
					const step = centipedeArr[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (centipedeArr.length > 3)
					text += `\n  ${theme.fg("muted", `... +${centipedeArr.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (tasksArr && tasksArr.length > 0) {
				// Minimal header - renderResult shows the detailed task list with status
				const text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${tasksArr.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`) +
					modelTag;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 200
					? `${args.task.slice(0, 200)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				modelTag;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded
							? item.text
							: item.text
									.split("\n")
									.filter((l) => l.trim())
									.slice(0, 3)
									.join("\n");
						text += `${theme.fg("dim", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isRunning = r.exitCode === -1;
				const isError =
					!isRunning &&
					(r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted");
				// Use animated spinner frame if available
				const spinnerChar =
					details.spinnerFrame !== undefined
						? SPINNER_FRAMES[details.spinnerFrame % SPINNER_FRAMES.length]
						: getSpinner()[0];
				const icon = isRunning
					? theme.fg("warning", spinnerChar) // Animated spinner while running
					: isError
						? theme.fg("error", getIcon("error"))
						: theme.fg("success", getIcon("success"));
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (r.model) header += ` ${theme.fg("dim", r.model)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0
									)
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (r.model) text += ` ${theme.fg("dim", r.model)}`;
				if (isRunning) {
					text += ` ${theme.fg("warning", "(running...)")}`;
					// Show current progress while running
					if (displayItems.length > 0) {
						text += `\n${renderDisplayItems(displayItems, 3)}`;
					}
				} else if (isError && r.stopReason) {
					text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					if (r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				} else if (displayItems.length === 0) {
					text += `\n${theme.fg("muted", "(no output)")}`;
				} else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				{
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				}
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "centipede") {
				const totalSteps = details.centipedeSteps?.length ?? details.results.length;
				const isRunning = details.results.some((r) => r.exitCode === -1);
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const spinnerChar =
					details.spinnerFrame !== undefined
						? SPINNER_FRAMES[details.spinnerFrame % SPINNER_FRAMES.length]
						: getSpinner()[0];

				const icon = isRunning
					? theme.fg("warning", spinnerChar)
					: failCount > 0
						? theme.fg("error", getIcon("error"))
						: theme.fg("success", getIcon("success"));

				/**
				 * Get the status icon for a centipede step by index (1-based).
				 * @param stepNum - 1-based step number
				 * @returns Formatted icon string: spinner if running, ✓ if done, × if failed, empty if upcoming
				 */
				const getStepIcon = (stepNum: number): string => {
					const r = details.results.find((res) => res.step === stepNum);
					if (!r) return "";
					if (r.exitCode === -1) return ` ${theme.fg("warning", spinnerChar)}`;
					if (r.exitCode === 0) return ` ${theme.fg("success", getIcon("success"))}`;
					return ` ${theme.fg("error", getIcon("error"))}`;
				};

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("centipede ")) +
								theme.fg("accent", `${successCount}/${totalSteps} steps`),
							0,
							0
						)
					);

					for (let si = 0; si < totalSteps; si++) {
						const stepNum = si + 1;
						const r = details.results.find((res) => res.step === stepNum);
						const stepAgent = r?.agent ?? details.centipedeSteps?.[si]?.agent ?? `step ${stepNum}`;
						const rIcon = getStepIcon(stepNum);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								theme.fg("muted", `─── Step ${stepNum}: `) + theme.fg("accent", stepAgent) + rIcon,
								0,
								0
							)
						);

						if (r) {
							const displayItems = getDisplayItems(r.messages);
							const finalOutput = getFinalOutput(r.messages);

							container.addChild(
								new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0)
							);

							for (const item of displayItems) {
								if (item.type === "toolCall") {
									container.addChild(
										new Text(
											theme.fg("muted", "→ ") +
												formatToolCall(item.name, item.args, theme.fg.bind(theme)),
											0,
											0
										)
									);
								}
							}

							if (finalOutput) {
								container.addChild(new Spacer(1));
								container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
							}

							const stepUsage = formatUsageStats(r.usage, r.model);
							if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
						}
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("centipede ")) +
					theme.fg("accent", `${successCount}/${totalSteps} steps`);
				for (let si = 0; si < totalSteps; si++) {
					const stepNum = si + 1;
					const r = details.results.find((res) => res.step === stepNum);
					const stepAgent = r?.agent ?? details.centipedeSteps?.[si]?.agent ?? `step ${stepNum}`;
					const rIcon = getStepIcon(stepNum);
					text += `\n\n${theme.fg("muted", `─── Step ${stepNum}: `)}${theme.fg("accent", stepAgent)}${rIcon}`;
					if (r) {
						const displayItems = getDisplayItems(r.messages);
						if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
						else text += `\n${renderDisplayItems(displayItems, 5)}`;
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) text += `\n${theme.fg("dim", stepUsage)}`;
					}
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				if (!isRunning) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				// Use animated spinner frame if available, otherwise fallback
				const spinnerChar =
					details.spinnerFrame !== undefined
						? SPINNER_FRAMES[details.spinnerFrame % SPINNER_FRAMES.length]
						: getSpinner()[0];
				const icon = isRunning
					? theme.fg("warning", spinnerChar)
					: failCount > 0
						? theme.fg("warning", getSpinner()[0])
						: theme.fg("success", getIcon("success"));
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${details.results.length} agents complete`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0
						)
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === 0
								? theme.fg("success", getIcon("success"))
								: theme.fg("error", getIcon("error"));
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0)
						);
						container.addChild(
							new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0)
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0
									)
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// While running, show progress inline (no separate widget for foreground tasks)
				if (isRunning) {
					// Show animated progress inline in tool result
					let text = `${theme.fg("warning", spinnerChar)} ${theme.fg("accent", status)}`;
					for (let i = 0; i < details.results.length; i++) {
						const r = details.results[i];
						const isLast = i === details.results.length - 1;
						const treeChar = isLast ? "└─" : "├─";
						const rIcon =
							r.exitCode === -1
								? theme.fg("warning", spinnerChar)
								: r.exitCode === 0
									? theme.fg("success", getIcon("success"))
									: theme.fg("error", getIcon("error"));
						const taskPreview = r.task.length > 40 ? `${r.task.slice(0, 37)}...` : r.task;
						const modelTag = r.model ? ` ${theme.fg("dim", r.model)}` : "";
						const contChar = isLast ? "   " : `${theme.fg("muted", "│")}  `;
						text += `\n${theme.fg("muted", treeChar)} ${theme.fg("accent", r.agent)} ${rIcon}${modelTag}`;
						text += `\n${contChar}${theme.fg("dim", taskPreview)}`;
						const agentUsage = formatUsageStats(r.usage);
						if (agentUsage) text += `\n${contChar}${theme.fg("dim", agentUsage)}`;
					}
					const liveTotal = formatUsageStats(aggregateUsage(details.results));
					if (liveTotal) text += `\n${theme.fg("dim", `Total: ${liveTotal}`)}`;
					return new Text(text, 0, 0);
				}

				// Only show full results when truly done (no widget entries)
				let text = `${icon} ${theme.fg("accent", status)}`;
				for (let i = 0; i < details.results.length; i++) {
					const r = details.results[i];
					const isLast = i === details.results.length - 1;
					const treeChar = isLast ? "└─" : "├─";
					const contChar = isLast ? "   " : `${theme.fg("muted", "│")}  `;
					const rIcon =
						r.exitCode === 0
							? theme.fg("success", getIcon("success"))
							: theme.fg("error", getIcon("error"));
					const displayItems = getDisplayItems(r.messages);
					const modelTag = r.model ? ` ${theme.fg("dim", r.model)}` : "";
					text += `\n${theme.fg("muted", treeChar)} ${theme.fg("accent", r.agent)} ${rIcon}${modelTag}`;
					if (displayItems.length === 0) text += `\n${contChar}${theme.fg("muted", "(no output)")}`;
					else {
						const rendered = renderDisplayItems(displayItems, 5)
							.split("\n")
							.filter((l) => l.trim())
							.join(`\n${contChar}`);
						text += `\n${contChar}${rendered}`;
					}
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// Tool to check status of background subagents
	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Check status of background subagents. Optionally provide a taskId to get details for a specific task.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Specific task ID to check (optional)" })),
		}),
		async execute(_toolCallId, params) {
			if (params.taskId) {
				const bg = backgroundSubagents.get(params.taskId);
				if (!bg) {
					return {
						details: {},
						content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					};
				}
				const duration = formatDuration(Date.now() - bg.startTime);
				const output = getFinalOutput(bg.result.messages) || "(no output yet)";
				return {
					details: {},
					content: [
						{
							type: "text",
							text: `**Task:** ${bg.id}\n**Agent:** ${bg.agent}\n**Status:** ${bg.status}\n**Duration:** ${duration}\n**Task:** ${bg.task}\n\n**Output:**\n${output}`,
						},
					],
				};
			}

			// List all background subagents
			const all = [...backgroundSubagents.values()];
			if (all.length === 0) {
				return {
					details: {},
					content: [{ type: "text", text: "No background subagents running." }],
				};
			}

			const lines = all.map((bg) => {
				const duration = formatDuration(Date.now() - bg.startTime);
				const statusIcon =
					bg.status === "running"
						? getIcon("in_progress")
						: bg.status === "completed"
							? getIcon("success")
							: getIcon("error");
				const preview = bg.task.length > 40 ? `${bg.task.slice(0, 37)}...` : bg.task;
				return `${statusIcon} **${bg.id}** (${bg.agent}) - ${bg.status} (${duration})\n   ${preview}`;
			});

			return {
				details: {},
				content: [
					{
						type: "text",
						text: `**Background Subagents (${all.length}):**\n\n${lines.join("\n\n")}`,
					},
				],
			};
		},
	});
}
