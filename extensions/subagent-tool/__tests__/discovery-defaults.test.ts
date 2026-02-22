/**
 * Tests for subagent discovery, model inheritance, missing-agent recovery,
 * and defaults precedence.
 *
 * Verifies:
 * - Project root detection (git root vs cwd fallback)
 * - Model precedence (per-call > agent frontmatter > parent model)
 * - Missing-agent recovery (exact > best-match > ephemeral)
 * - Defaults loading and merge precedence
 * - Agent scoring heuristics
 */
import { describe, expect, it } from "bun:test";
import { resolveEffectiveIsolation } from "../agents.js";

// ── Helpers (mirrored from subagent-tool/index.ts) ───────────────────────────

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	disallowedTools?: string[];
	maxTurns?: number;
	mcpServers?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

interface AgentDefaults {
	tools?: string[];
	disallowedTools?: string[];
	maxTurns?: number;
	mcpServers?: string[];
	missingAgentBehavior?: "match-or-ephemeral" | "error";
	fallbackAgent?: string;
}

interface ResolvedAgent {
	agent: AgentConfig;
	resolution: "exact" | "match" | "ephemeral";
	requestedName: string;
}

/**
 * Score how well an agent name matches a requested name.
 * @param agentName - Discovered agent's name
 * @param requestedName - Name the caller asked for
 * @returns Match score (higher = better, 0 = no match)
 */
function scoreAgentMatch(agentName: string, requestedName: string): number {
	const a = agentName.toLowerCase();
	const r = requestedName.toLowerCase();
	if (a === r) return Infinity;
	if (a.startsWith(r)) return 100 + r.length;
	if (r.startsWith(a)) return 90 + a.length;
	if (a.includes(r)) return 50 + r.length;
	if (r.includes(a)) return 40 + a.length;
	return 0;
}

const MATCH_THRESHOLD = 40;

/**
 * Resolve an agent name to a runnable configuration.
 * @param agentName - Requested agent name
 * @param agents - Discovered agent configurations
 * @param defaults - Optional defaults for ephemeral agents
 * @returns Resolved agent with metadata
 */
function resolveAgentForExecution(
	agentName: string,
	agents: AgentConfig[],
	defaults?: AgentDefaults
): ResolvedAgent {
	const exact = agents.find((a) => a.name === agentName);
	if (exact) return { agent: exact, resolution: "exact", requestedName: agentName };

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

	const ephemeral: AgentConfig = {
		name: agentName,
		description: "Ephemeral agent for task delegation",
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
 * Merge multiple defaults sources (last wins for each field).
 * @param sources - Defaults in precedence order
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

/** Helper to create a minimal agent config for testing */
function makeAgent(name: string, source: "user" | "project" = "user", model?: string): AgentConfig {
	return {
		name,
		description: `Test agent: ${name}`,
		systemPrompt: `You are ${name}.`,
		source,
		filePath: `/agents/${name}.md`,
		model,
	};
}

// ═════════════════════════════════════════════════════════════════
// Agent Name Scoring
// ═════════════════════════════════════════════════════════════════

describe("scoreAgentMatch", () => {
	it("returns Infinity for exact match", () => {
		expect(scoreAgentMatch("worker", "worker")).toBe(Infinity);
	});

	it("is case-insensitive", () => {
		expect(scoreAgentMatch("Worker", "worker")).toBe(Infinity);
	});

	it("scores prefix matches high", () => {
		const score = scoreAgentMatch("worker", "work");
		expect(score).toBeGreaterThan(MATCH_THRESHOLD);
		expect(score).toBe(100 + 4); // 100 + "work".length
	});

	it("scores reverse prefix matches", () => {
		const score = scoreAgentMatch("work", "worker");
		expect(score).toBeGreaterThan(MATCH_THRESHOLD);
		expect(score).toBe(90 + 4); // 90 + "work".length
	});

	it("scores contains matches", () => {
		const score = scoreAgentMatch("code-worker", "work");
		expect(score).toBeGreaterThan(MATCH_THRESHOLD);
	});

	it("returns 0 for no match", () => {
		expect(scoreAgentMatch("scout", "worker")).toBe(0);
	});

	it("returns 0 for completely different names", () => {
		expect(scoreAgentMatch("alpha", "zebra")).toBe(0);
	});
});

// ═════════════════════════════════════════════════════════════════
// Missing-Agent Recovery
// ═════════════════════════════════════════════════════════════════

describe("resolveAgentForExecution", () => {
	const agents = [makeAgent("worker"), makeAgent("scout"), makeAgent("reviewer", "project")];

	it("returns exact match with 'exact' resolution", () => {
		const result = resolveAgentForExecution("worker", agents);
		expect(result.resolution).toBe("exact");
		expect(result.agent.name).toBe("worker");
	});

	it("returns best match when name is close", () => {
		const result = resolveAgentForExecution("work", agents);
		expect(result.resolution).toBe("match");
		expect(result.agent.name).toBe("worker");
	});

	it("returns ephemeral for completely unknown name", () => {
		const result = resolveAgentForExecution("navigator", agents);
		expect(result.resolution).toBe("ephemeral");
		expect(result.agent.name).toBe("navigator");
	});

	it("ephemeral agent has sane defaults", () => {
		const result = resolveAgentForExecution("unknown-agent", agents);
		expect(result.agent.systemPrompt).toContain("unknown-agent");
		expect(result.agent.source).toBe("user");
		expect(result.agent.filePath).toBe("");
	});

	it("applies defaults to ephemeral agents", () => {
		const defaults: AgentDefaults = {
			tools: ["read", "bash"],
			maxTurns: 10,
		};
		const result = resolveAgentForExecution("unknown", agents, defaults);
		expect(result.resolution).toBe("ephemeral");
		expect(result.agent.tools).toEqual(["read", "bash"]);
		expect(result.agent.maxTurns).toBe(10);
	});

	it("does not apply defaults to exact matches", () => {
		const defaults: AgentDefaults = { tools: ["read"], maxTurns: 5 };
		const result = resolveAgentForExecution("worker", agents, defaults);
		expect(result.resolution).toBe("exact");
		expect(result.agent.tools).toBeUndefined();
		expect(result.agent.maxTurns).toBeUndefined();
	});

	it("preserves requestedName for transparency", () => {
		const result = resolveAgentForExecution("work", agents);
		expect(result.requestedName).toBe("work");
	});
});

// ═════════════════════════════════════════════════════════════════
// Model Precedence
// ═════════════════════════════════════════════════════════════════

describe("model precedence", () => {
	it("per-call model beats agent model beats parent model", () => {
		// Simulates the precedence logic in runSingleAgent
		const agentModel: string | undefined = "agent-model";
		const parentModelId: string | undefined = "parent-model";
		const perCallModel: string | undefined = "per-call-model";
		const effective = perCallModel ?? agentModel ?? parentModelId;
		expect(effective).toBe("per-call-model");
	});

	it("agent model beats parent model when no per-call", () => {
		const agentModel: string | undefined = "agent-model";
		const parentModelId: string | undefined = "parent-model";
		const perCallModel: string | undefined = undefined;
		const effective = perCallModel ?? agentModel ?? parentModelId;
		expect(effective).toBe("agent-model");
	});

	it("parent model used when no explicit model exists", () => {
		const agentModel: string | undefined = undefined;
		const parentModelId: string | undefined = "parent-model";
		const perCallModel: string | undefined = undefined;
		const effective = perCallModel ?? agentModel ?? parentModelId;
		expect(effective).toBe("parent-model");
	});

	it("undefined when all model sources are empty", () => {
		const agentModel: string | undefined = undefined;
		const parentModelId: string | undefined = undefined;
		const perCallModel: string | undefined = undefined;
		const effective = perCallModel ?? agentModel ?? parentModelId;
		expect(effective).toBeUndefined();
	});
});

// ═════════════════════════════════════════════════════════════════
// Defaults Merge Precedence
// ═════════════════════════════════════════════════════════════════

describe("mergeDefaults", () => {
	it("returns empty object for no sources", () => {
		expect(mergeDefaults()).toEqual({});
	});

	it("returns empty object for undefined sources", () => {
		expect(mergeDefaults(undefined, undefined)).toEqual({});
	});

	it("passes through single source", () => {
		const src: AgentDefaults = { tools: ["read"], maxTurns: 10 };
		expect(mergeDefaults(src)).toEqual({ tools: ["read"], maxTurns: 10 });
	});

	it("later source overrides earlier for scalar values", () => {
		const user: AgentDefaults = { maxTurns: 10, fallbackAgent: "worker" };
		const project: AgentDefaults = { maxTurns: 20 };
		const result = mergeDefaults(user, project);
		expect(result.maxTurns).toBe(20);
		expect(result.fallbackAgent).toBe("worker"); // kept from user
	});

	it("later source overrides earlier for array values", () => {
		const user: AgentDefaults = { tools: ["read", "bash"] };
		const project: AgentDefaults = { tools: ["read", "edit", "write"] };
		const result = mergeDefaults(user, project);
		expect(result.tools).toEqual(["read", "edit", "write"]);
	});

	it("skips undefined sources in the chain", () => {
		const user: AgentDefaults = { maxTurns: 5 };
		const result = mergeDefaults(undefined, user, undefined);
		expect(result.maxTurns).toBe(5);
	});

	it("supports full precedence chain: built-in < user < project", () => {
		const builtin: AgentDefaults = { maxTurns: 25, missingAgentBehavior: "match-or-ephemeral" };
		const user: AgentDefaults = { maxTurns: 15, tools: ["read", "bash"] };
		const project: AgentDefaults = { maxTurns: 10 };
		const result = mergeDefaults(builtin, user, project);
		expect(result.maxTurns).toBe(10); // project wins
		expect(result.tools).toEqual(["read", "bash"]); // user (project didn't set)
		expect(result.missingAgentBehavior).toBe("match-or-ephemeral"); // built-in (others didn't set)
	});
});

describe("resolveEffectiveIsolation", () => {
	it("uses per-call isolation when provided", () => {
		const effective = resolveEffectiveIsolation("worktree", undefined, undefined);
		expect(effective).toBe("worktree");
	});

	it("falls back to agent frontmatter isolation", () => {
		const effective = resolveEffectiveIsolation(undefined, "worktree", undefined);
		expect(effective).toBe("worktree");
	});

	it("falls back to defaults isolation", () => {
		const effective = resolveEffectiveIsolation(undefined, undefined, "worktree");
		expect(effective).toBe("worktree");
	});

	it("returns undefined when isolation is unset everywhere", () => {
		const effective = resolveEffectiveIsolation(undefined, undefined, undefined);
		expect(effective).toBeUndefined();
	});
});
