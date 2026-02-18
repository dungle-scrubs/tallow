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
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { type RoutingHints, routeModel } from "../../subagent-tool/model-router.js";
import { resolveStandardTools } from "../state/team-view.js";
import type { Teammate } from "../state/types.js";
import type { Team } from "../store.js";
import { createTeammateTools } from "../tools/teammate-tools.js";

/**
 * Spawn a teammate as an in-process AgentSession with shared team tools.
 *
 * Model selection follows the same routing as subagents:
 * - modelOverride set → explicit fuzzy resolution (best match)
 * - modelScope set → auto-route within that model family
 * - neither → full auto-route based on role complexity and cost preference
 *
 * @param cwd - Working directory
 * @param team - Team to add the teammate to
 * @param name - Teammate name
 * @param role - Role description (used for task classification + system prompt)
 * @param modelOverride - Explicit model name (fuzzy matched). Skips auto-routing.
 * @param toolNames - Standard tool names (defaults to all coding tools)
 * @param piEvents - Event emitter for lifecycle events
 * @param hints - Optional routing hints (modelScope, costPreference, etc.)
 * @param parentModelId - Parent model ID for fallback inheritance
 * @returns The created Teammate
 * @throws If model not found or session creation fails
 */
export async function spawnTeammateSession(
	cwd: string,
	team: Team<Teammate>,
	name: string,
	role: string,
	modelOverride: string | undefined,
	toolNames?: string[],
	piEvents?: ExtensionAPI["events"],
	hints?: RoutingHints,
	parentModelId?: string
): Promise<Teammate> {
	const routing = await routeModel(role, modelOverride, undefined, parentModelId, role, hints);
	if (!routing.ok) {
		const available = listAvailableModels().slice(0, 20).join(", ");
		throw new Error(`Model not found: "${routing.query}". Available: ${available}`);
	}
	const resolved = routing.model;
	const { findModel } = await import("../state/team-view.js");
	const model = findModel(resolved.id);
	if (!model) {
		throw new Error(`Model resolved to "${resolved.id}" but not found in registry`);
	}

	const authStorage = new AuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);

	const otherNames = Array.from(team.teammates.keys()).filter((n) => n !== name);
	const systemPrompt = [
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

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const teammateCustomTools = createTeammateTools(team, name, piEvents);

	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(os.tmpdir(), `pi-team-${team.name}-${name}`),
		model,
		thinkingLevel: "off",
		authStorage,
		modelRegistry,
		resourceLoader,
		tools: resolveStandardTools(cwd, toolNames),
		customTools: teammateCustomTools,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 2 },
		}),
	});

	const mate: Teammate = { name, role, model: resolved.id, session, status: "idle" };
	team.teammates.set(name, mate);
	return mate;
}
