/**
 * Task classification via cheap LLM call.
 *
 * Determines a task's type (code/vision/text) and complexity (1-5)
 * using the cheapest available model from the registry.
 */

import { execFileSync } from "node:child_process";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import type { TaskType } from "./model-matrix.js";

export type TaskComplexity = 1 | 2 | 3 | 4 | 5;

export interface ClassificationResult {
	type: TaskType;
	complexity: TaskComplexity;
	reasoning: string;
}

/** Valid task types for validation. */
const VALID_TYPES: ReadonlySet<string> = new Set<TaskType>(["code", "vision", "text"]);

/** Valid complexity values for validation. */
const VALID_COMPLEXITIES: ReadonlySet<number> = new Set<TaskComplexity>([1, 2, 3, 4, 5]);

/**
 * Finds the cheapest available model by effective cost.
 *
 * @returns Model ID of the cheapest model, or undefined if no models available
 */
export function findCheapestModel(): string | undefined {
	let cheapestId: string | undefined;
	let cheapestCost = Infinity;

	for (const provider of getProviders()) {
		for (const m of getModels(provider)) {
			const effective = (m.cost.input + m.cost.output) / 2;
			if (effective < cheapestCost) {
				cheapestCost = effective;
				cheapestId = m.id;
			}
		}
	}

	return cheapestId;
}

/**
 * Builds the classification prompt for the LLM.
 *
 * @param task - Task description
 * @param primaryType - Agent's default type
 * @param agentRole - Optional agent role context
 * @returns Formatted prompt string
 */
function buildPrompt(task: string, primaryType: TaskType, agentRole?: string): string {
	const roleLine = agentRole ? `\nAgent role: ${agentRole}` : "";
	return `Classify this task on two axes.

TYPE — what LLM capability is needed:
- code: writing, refactoring, debugging, reviewing code
- vision: analyzing images, screenshots, UI mockups
- text: writing docs, planning, general reasoning, research

COMPLEXITY (1-5):
1 = Trivial (rename file, simple lookup, basic edit)
2 = Simple (single-file change, add test, fix typo)
3 = Moderate (multi-file change, implement function, debug)
4 = Complex (design + implement feature, architecture)
5 = Expert (cross-system design, security audit, optimization)

Default type for this agent: ${primaryType}
Use the default unless the task clearly requires a different type.

Task: ${task}${roleLine}

Respond with JSON only: {"type": "<type>", "complexity": <1-5>, "reasoning": "<one line>"}`;
}

/**
 * Extracts and parses JSON from LLM output that may contain markdown fences.
 *
 * @param raw - Raw LLM output string
 * @returns Parsed object, or undefined on failure
 */
function extractJson(raw: string): Record<string, unknown> | undefined {
	// Strip markdown code fences if present
	const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	const jsonStr = fenceMatch ? fenceMatch[1] : raw;

	try {
		return JSON.parse(jsonStr.trim());
	} catch {
		// Try to find a JSON object anywhere in the string
		const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
		if (objectMatch) {
			try {
				return JSON.parse(objectMatch[0]);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}

/**
 * Classify a task's type and complexity using the cheapest available LLM.
 *
 * Picks the cheapest model from the registry by (input + output) / 2 cost,
 * sends a structured classification prompt, and parses the JSON response.
 * Falls back to primaryType + complexity 3 on any failure.
 *
 * @param task - The task description to classify
 * @param primaryType - Agent's default type (used when ambiguous or on failure)
 * @param agentRole - Optional agent role for additional context
 * @returns Classification result with type, complexity, and reasoning
 */
export async function classifyTask(
	task: string,
	primaryType: TaskType,
	agentRole?: string
): Promise<ClassificationResult> {
	const fallback: ClassificationResult = {
		type: primaryType,
		complexity: 3,
		reasoning: "fallback: classification unavailable",
	};

	const modelId = findCheapestModel();
	if (!modelId) return fallback;

	const prompt = buildPrompt(task, primaryType, agentRole);

	try {
		const output = execFileSync(
			"pi",
			["--mode", "print", "-p", "--no-session", "--models", modelId, prompt],
			{
				encoding: "utf-8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			}
		);

		const parsed = extractJson(output);
		if (!parsed) return fallback;

		const type = String(parsed.type);
		const complexity = Number(parsed.complexity);
		const reasoning = String(parsed.reasoning ?? "");

		if (!VALID_TYPES.has(type) || !VALID_COMPLEXITIES.has(complexity)) {
			return fallback;
		}

		return {
			type: type as TaskType,
			complexity: complexity as TaskComplexity,
			reasoning,
		};
	} catch {
		return fallback;
	}
}
