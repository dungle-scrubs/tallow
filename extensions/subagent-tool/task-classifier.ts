/**
 * Task classification — wraps synapse's DI-based classifier with pi-ai bindings.
 *
 * @module
 */

import type {
	ClassificationResult,
	ClassifierModel,
	CompleteFn,
	ModelLister,
	TaskComplexity,
	TaskType,
} from "@dungle-scrubs/synapse";
import {
	classifyTask as classifyTaskBase,
	findCheapestModel as findCheapestModelBase,
} from "@dungle-scrubs/synapse";
import { completeSimple, getModel, getModels, getProviders } from "@mariozechner/pi-ai";

export type { ClassificationResult, TaskComplexity, TaskType };

/**
 * Lists all available models with cost info from the pi-ai registry.
 *
 * @returns Array of models with provider, id, and cost
 */
const listModels: ModelLister = () => {
	const result: ClassifierModel[] = [];
	for (const provider of getProviders()) {
		for (const m of getModels(provider)) {
			result.push({
				provider: m.provider,
				id: m.id,
				cost: { input: m.cost.input, output: m.cost.output },
			});
		}
	}
	return result;
};

/**
 * Completes a prompt using pi-ai's completeSimple.
 *
 * @param provider - Model provider
 * @param modelId - Model ID
 * @param prompt - Prompt text
 * @returns Response text
 */
const complete: CompleteFn = async (provider, modelId, prompt) => {
	const model = getModel(provider as never, modelId as never);
	const response = await completeSimple(model, {
		messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
	});
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && "text" in c)
		.map((c) => c.text)
		.join("");
};

/** The injected deps for classifyTask. */
const deps = { listModels, complete };

/**
 * Finds the cheapest available model by effective cost.
 *
 * @returns Model ID of the cheapest model, or undefined if no models available
 */
export function findCheapestModel(): string | undefined {
	return findCheapestModelBase(listModels)?.id;
}

/**
 * Classify a task's type and complexity using the cheapest available LLM.
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
	return classifyTaskBase(task, primaryType, deps, agentRole);
}
