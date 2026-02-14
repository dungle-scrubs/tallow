/**
 * Agent classification, identity management, and tool-call summarisation.
 *
 * Provides keyword-based heuristics to label subagents with a display name
 * and activity type, optional async refinement via Haiku, deterministic
 * color assignment, and human-readable tool-call summaries for the widget.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Generated agent identity: a display name and type label.
 * Populated on subagent_start with keyword heuristic, refined by Haiku.
 */
export interface AgentIdentity {
	/** Display name shown in widget and used as task owner (e.g. "scout", "auditor"). */
	displayName: string;
	/** Activity type label (e.g. "Explore", "Review"). */
	typeLabel: string;
}

/** Live activity status for a running subagent (updated via event bus). */
export interface AgentActivity {
	toolName: string;
	summary: string;
	timestamp: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Valid type labels for agent classification. */
export const AGENT_TYPE_LABELS = [
	"Explore",
	"Implement",
	"Review",
	"Plan",
	"Test",
	"Fix",
	"Research",
	"Write",
	"Debug",
	"Refactor",
	"Deploy",
	"Monitor",
	"Design",
	"Analyze",
] as const;

/** Agent color palette for teammate display (CC-style). */
export const AGENT_COLORS: readonly string[] = [
	"green",
	"cyan",
	"magenta",
	"yellow",
	"blue",
	"red",
] as const;

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Classify an agent's task into a display name + type label using keyword heuristics.
 *
 * Concatenates `agentName` and `task`, then tests against an ordered list of
 * regex patterns.  The first match wins.  Falls back to the raw agent name
 * with label `"General"` when nothing matches.
 *
 * @param task - The task description
 * @param agentName - The agent definition name (e.g. "worker")
 * @returns An {@link AgentIdentity} with displayName and typeLabel
 */
export function classifyAgent(task: string, agentName: string): AgentIdentity {
	const combined = `${agentName} ${task}`.toLowerCase();
	const patterns: [RegExp, string, string][] = [
		[/\b(review|critique|feedback|inspect|evaluate)\b/, "reviewer", "Review"],
		[/\b(audit|check|security)\b/, "auditor", "Review"],
		[/\b(explore|discover|scout|survey)\b/, "scout", "Explore"],
		[/\b(research|investigate|find|search)\b/, "researcher", "Explore"],
		[/\b(plan|spec|architect|propose|outline|strategy)\b/, "planner", "Plan"],
		[/\b(design|mockup|wireframe|layout)\b/, "designer", "Design"],
		[/\b(test|verify|validate|assert|qa)\b/, "tester", "Test"],
		[/\b(fix|bug|debug|resolve|patch|hotfix)\b/, "fixer", "Fix"],
		[/\b(refactor|restructure|reorganize|simplify)\b/, "refactorer", "Refactor"],
		[/\b(deploy|release|publish|ship)\b/, "deployer", "Deploy"],
		[/\b(monitor|watch|observe|alert)\b/, "monitor", "Monitor"],
		[/\b(analyze|compare|measure|profile|benchmark)\b/, "analyst", "Analyze"],
		[/\b(write|create|build|implement|add|make|develop|code)\b/, "builder", "Implement"],
	];

	for (const [pattern, name, label] of patterns) {
		if (pattern.test(combined)) return { displayName: name, typeLabel: label };
	}
	return { displayName: agentName, typeLabel: "General" };
}

/**
 * Assigns a deterministic color to an agent name via hash.
 *
 * @param name - Agent name to hash
 * @returns ANSI color name from {@link AGENT_COLORS}
 */
export function agentColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = Math.trunc(hash * 31 + name.charCodeAt(i));
	}
	return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

/**
 * Builds a human-readable summary from a tool call.
 *
 * @param toolName - Name of the tool being called
 * @param toolInput - Tool input parameters
 * @returns Short activity description suitable for widget display
 */
export function summarizeToolCall(toolName: string, toolInput: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const cmd = String(toolInput.command ?? "");
			const firstLine = cmd.split("\n")[0];
			return firstLine.length > 40 ? `${firstLine.slice(0, 37)}...` : firstLine;
		}
		case "read":
			return `Reading ${String(toolInput.path ?? "")}`;
		case "edit":
			return `Editing ${String(toolInput.path ?? "")}`;
		case "write":
			return `Writing ${String(toolInput.path ?? "")}`;
		case "grep":
			return `Searching: ${String(toolInput.pattern ?? "")}`;
		case "find":
			return `Finding: ${String(toolInput.pattern ?? "")}`;
		case "ls":
			return `Listing ${String(toolInput.path ?? ".")}`;
		default:
			return toolName;
	}
}

/**
 * Refine an agent identity asynchronously via a lightweight Haiku call.
 *
 * Generates both a short display name and type label in one request.
 * Falls back silently on any failure — the heuristic identity remains.
 *
 * @param subagentId - Subagent ID to update in the cache
 * @param task - Task description to classify
 * @param getApiKey - Function to retrieve the Anthropic API key
 * @param identities - Map to update with the refined identity
 */
export async function refineAgentIdentityAsync(
	subagentId: string,
	task: string,
	getApiKey: () => Promise<string | undefined>,
	identities: Map<string, AgentIdentity>
): Promise<void> {
	try {
		const apiKey = await getApiKey();
		if (!apiKey) return;

		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "claude-haiku-3-5-20241022",
				max_tokens: 20,
				messages: [
					{
						role: "user",
						content:
							"Given this agent task, respond with EXACTLY two words separated by a space:\n" +
							"1. A short lowercase agent name (like: scout, auditor, builder, tester, planner, researcher, fixer, designer)\n" +
							`2. A type label from: ${AGENT_TYPE_LABELS.join(", ")}\n\n` +
							`Task: "${task.slice(0, 300)}"\n\nExample response: researcher Explore`,
					},
				],
			}),
		});
		if (!response.ok) return;

		const data = (await response.json()) as { content?: Array<{ text?: string }> };
		const text = data.content?.[0]?.text?.trim() ?? "";
		const parts = text.split(/\s+/);
		if (parts.length >= 2) {
			const name = parts[0].toLowerCase().replace(/[^a-z-]/g, "");
			const label = parts[1];
			if (
				name.length > 0 &&
				AGENT_TYPE_LABELS.includes(label as (typeof AGENT_TYPE_LABELS)[number])
			) {
				identities.set(subagentId, { displayName: name, typeLabel: label });
			}
		}
	} catch {
		// Silently fall back to heuristic
	}
}
