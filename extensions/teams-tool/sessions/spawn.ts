/**
 * Teammate session spawning — creates in-process agent sessions for teammates.
 */

import * as os from "node:os";
import * as path from "node:path";
import { listAvailableModels } from "@dungle-scrubs/synapse";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	AuthStorage,
	createAgentSession,
	createExtensionRuntime,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { applyKnownModelMetadataOverrides } from "../../../src/model-metadata-overrides.js";
import { getTallowHomeDir, getTallowPath } from "../../_shared/tallow-paths.js";
import {
	type AgentConfig,
	computeEffectiveTools,
	discoverAgents,
	resolveAgentForExecution,
} from "../../subagent-tool/agents.js";
import { type RoutingHints, routeModel } from "../../subagent-tool/model-router.js";
import { resolveStandardTools } from "../state/team-view.js";
import type { Teammate } from "../state/types.js";
import type { Team } from "../store.js";
import { createTeammateTools } from "../tools/teammate-tools.js";

interface SpawnTeammateSessionOptions {
	readonly agentName?: string;
	readonly cwd: string;
	readonly hints?: RoutingHints;
	readonly modelOverride?: string;
	readonly name: string;
	readonly parentModelId?: string;
	readonly piEvents?: ExtensionAPI["events"];
	readonly role?: string;
	readonly team: Team<Teammate>;
	readonly thinkingLevel?: string;
	readonly toolNames?: string[];
}

type TeammateThinkingLevel = "high" | "low" | "medium" | "off";

/**
 * Coerce an arbitrary string into a supported teammate thinking level.
 *
 * @param value - Raw level string from caller context or tool params
 * @returns Supported thinking level, or undefined when unsupported
 */
function coerceThinkingLevel(value: string | undefined): TeammateThinkingLevel | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "off" ||
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high"
	) {
		return normalized;
	}
	return undefined;
}

/**
 * Resolve an optional teammate agent template from the shared agent directories.
 *
 * Team teammates should not silently fall back to an ephemeral template when the
 * caller explicitly requested a named agent. Typos must fail closed.
 *
 * @param cwd - Working directory used for project-agent discovery
 * @param agentName - Optional template name requested by the caller
 * @returns Resolved agent template, or undefined when no template was requested
 * @throws {Error} When a named template cannot be found
 */
function resolveTeammateAgentTemplate(
	cwd: string,
	agentName: string | undefined
): AgentConfig | undefined {
	if (!agentName) return undefined;
	const discovery = discoverAgents(cwd, "both");
	const resolved = resolveAgentForExecution(agentName, discovery.agents, discovery.defaults);
	if (resolved.resolution === "ephemeral") {
		throw new Error(
			`Teammate agent template "${agentName}" was not found in user or project agent directories.`
		);
	}
	return resolved.agent;
}

/**
 * Build the coordination prompt appended to every teammate.
 *
 * @param team - Runtime team container
 * @param name - Teammate name
 * @param role - Effective teammate role text
 * @returns Coordination instructions shared by all teammates
 */
function buildCoordinationPrompt(team: Team<Teammate>, name: string, role: string): string {
	const otherNames = Array.from(team.teammates.keys()).filter(
		(teammateName) => teammateName !== name
	);
	return [
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
}

/**
 * Merge teammate coordination with an optional agent template system prompt.
 *
 * @param team - Runtime team container
 * @param name - Teammate name
 * @param role - Effective teammate role text
 * @param templateAgent - Optional resolved agent template
 * @returns Final system prompt text for the teammate session
 */
function buildTeammateSystemPrompt(
	team: Team<Teammate>,
	name: string,
	role: string,
	templateAgent: AgentConfig | undefined
): string {
	const sections = [buildCoordinationPrompt(team, name, role)];
	if (templateAgent?.systemPrompt.trim()) {
		sections.push(
			[`Base agent template: ${templateAgent.name}`, templateAgent.systemPrompt.trim()].join("\n\n")
		);
	}
	if (templateAgent?.maxTurns) {
		sections.unshift(
			`You have a maximum of ${templateAgent.maxTurns} tool-use turns for this task. Plan accordingly and return your best partial result before hitting the limit.`
		);
	}
	return sections.join("\n\n");
}

/**
 * Resolve the standard tool allowlist for a teammate.
 *
 * Explicit tool names passed to `team_spawn` win. Otherwise agent-template
 * allow/deny lists are applied when present.
 *
 * @param explicitToolNames - Tools passed directly to team_spawn
 * @param templateAgent - Optional resolved agent template
 * @returns Effective tool names, or undefined to allow the default coding set
 */
function resolveTeammateToolNames(
	explicitToolNames: string[] | undefined,
	templateAgent: AgentConfig | undefined
): string[] | undefined {
	if (explicitToolNames) return explicitToolNames;
	if (!templateAgent) return undefined;
	return computeEffectiveTools(templateAgent.tools, templateAgent.disallowedTools);
}

/**
 * Create a loader that only exposes the requested teammate skills/system prompt.
 *
 * Extensions are disabled on purpose — teammates get only the explicitly passed
 * standard tools plus the injected team coordination tools.
 *
 * @param cwd - Working directory
 * @param settingsManager - Shared in-memory settings for the teammate session
 * @param systemPrompt - Final system prompt text
 * @param templateAgent - Optional resolved agent template
 * @returns Reloaded resource loader ready for createAgentSession
 */
async function createTeammateResourceLoader(
	cwd: string,
	settingsManager: SettingsManager,
	systemPrompt: string,
	templateAgent: AgentConfig | undefined
): Promise<DefaultResourceLoader> {
	const requestedSkills = new Set(templateAgent?.skills ?? []);
	const loader = new DefaultResourceLoader({
		agentDir: getTallowHomeDir(),
		cwd,
		extensionsOverride: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		promptsOverride: () => ({ diagnostics: [], prompts: [] }),
		settingsManager,
		skillsOverride: (base) => ({
			diagnostics: base.diagnostics,
			skills:
				requestedSkills.size === 0
					? []
					: base.skills.filter((skill) => requestedSkills.has(skill.name)),
		}),
		systemPromptOverride: () => systemPrompt,
	});
	await loader.reload();
	return loader;
}

/**
 * Spawn a teammate as an in-process AgentSession with shared team tools.
 *
 * Model selection follows the same routing as subagents:
 * - modelOverride set → explicit fuzzy resolution (best match)
 * - template agent model set → explicit or auto-routing keyword from frontmatter
 * - neither → full auto-route based on role complexity and cost preference
 *
 * @param options - Session spawn options
 * @returns The created Teammate
 * @throws {Error} If model or agent template resolution fails
 */
export async function spawnTeammateSession(
	options: SpawnTeammateSessionOptions
): Promise<Teammate> {
	const templateAgent = resolveTeammateAgentTemplate(options.cwd, options.agentName);
	const role = options.role?.trim() || templateAgent?.description?.trim();
	if (!role) {
		throw new Error("team_spawn requires either a role or an agent template.");
	}

	const routingTask = templateAgent?.systemPrompt?.trim()
		? `${role}\n\n${templateAgent.systemPrompt.trim()}`
		: role;
	const routing = await routeModel(
		routingTask,
		options.modelOverride,
		templateAgent?.model,
		options.parentModelId,
		role,
		options.hints,
		options.cwd
	);
	if (!routing.ok) {
		const available = listAvailableModels().slice(0, 20).join(", ");
		throw new Error(`Model not found: "${routing.query}". Available: ${available}`);
	}
	const resolvedModel = routing.model;

	// Use the user's tallow auth and model config so teammates inherit
	// API keys and custom model definitions from the main session.
	const authStorage = AuthStorage.create(getTallowPath("auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, getTallowPath("models.json"));
	applyKnownModelMetadataOverrides(modelRegistry);
	const model = modelRegistry.find(resolvedModel.provider, resolvedModel.id);
	if (!model) {
		throw new Error(
			`Model resolved to "${resolvedModel.id}" (provider: ${resolvedModel.provider}) but not found in registry`
		);
	}

	const systemPrompt = buildTeammateSystemPrompt(options.team, options.name, role, templateAgent);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 2 },
	});
	const resourceLoader = await createTeammateResourceLoader(
		options.cwd,
		settingsManager,
		systemPrompt,
		templateAgent
	);
	const teammateCustomTools = createTeammateTools(options.team, options.name, options.piEvents);
	const thinkingLevel = coerceThinkingLevel(options.thinkingLevel) ?? "off";
	const toolNames = resolveTeammateToolNames(options.toolNames, templateAgent);
	const standardTools =
		toolNames && toolNames.length === 0 ? [] : resolveStandardTools(options.cwd, toolNames);

	const { session } = await createAgentSession({
		authStorage,
		customTools: teammateCustomTools,
		cwd: options.cwd,
		agentDir: path.join(os.tmpdir(), `pi-team-${options.team.name}-${options.name}`),
		model,
		modelRegistry,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		settingsManager,
		thinkingLevel,
		tools: standardTools,
	});

	const teammate: Teammate = {
		model: resolvedModel.id,
		name: options.name,
		role,
		session,
		status: "idle",
	};
	options.team.teammates.set(options.name, teammate);
	return teammate;
}
