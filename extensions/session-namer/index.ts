/**
 * Session Namer Extension
 *
 * Auto-generates meaningful session names using a lightweight model (Haiku)
 * after the first agent response. Names persist via pi.setSessionName() and
 * are displayed by the custom-footer extension. Also sets the terminal tab
 * title so named sessions are identifiable across tabs.
 *
 * - On agent_end (first turn): fires-and-forgets a Haiku call to name the session
 * - Built-in /name command handles manual view/override
 * - --no-session-name flag: opt out
 */

import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/** Whether the naming LLM call has already been triggered this session. */
let namingTriggered = false;

/**
 * System prompt for the naming model. Requests a concise 3-8 word
 * descriptive name based on the opening exchange.
 */
const NAMING_SYSTEM_PROMPT = `You name coding sessions. Given the opening exchange, produce a short descriptive name (3-8 words). Output ONLY the name, nothing else.
Good: "Refactoring auth middleware to JWT"
Bad: "Session about refactoring" (too vague)
Bad: "The user asked me to refactor..." (not a name)`;

/**
 * Cleans raw LLM output into a usable session name.
 * Strips surrounding quotes, "Session:" prefixes, and trailing punctuation.
 *
 * @param raw - Raw text from the naming model
 * @returns Cleaned session name
 */
export function cleanName(raw: string): string {
	let name = raw.trim();
	// Strip surrounding quotes
	if (
		(name.startsWith('"') && name.endsWith('"')) ||
		(name.startsWith("'") && name.endsWith("'"))
	) {
		name = name.slice(1, -1);
	}
	// Strip "Session:" or "Name:" prefix
	name = name.replace(/^(session|name)\s*:\s*/i, "");
	// Strip trailing punctuation
	name = name.replace(/[.!]+$/, "");
	return name.trim();
}

/**
 * Find a suitable lightweight model for session naming.
 * Prefers Haiku (cheap/fast), falls back to Sonnet.
 *
 * @param ctx - Extension context with model registry
 * @returns Model instance or undefined if none available
 */
function findNamingModel(ctx: ExtensionContext): Model<Api> | undefined {
	const registry = ctx.modelRegistry;
	const candidates = [
		["anthropic", "claude-haiku-4-5"],
		["anthropic", "claude-sonnet-4-5"],
	] as const;

	for (const [provider, modelId] of candidates) {
		const model = registry.find(provider, modelId);
		if (model) return model;
	}

	const available = registry.getAvailable();
	return available.length > 0 ? available[0] : undefined;
}

/**
 * Builds the naming prompt from the first user message and assistant response.
 *
 * @param userText - First user message text
 * @param assistantText - First assistant response text (truncated)
 * @returns Formatted prompt for the naming model
 */
export function buildNamingPrompt(userText: string, assistantText: string): string {
	const truncatedAssistant =
		assistantText.length > 500 ? `${assistantText.slice(0, 500)}…` : assistantText;
	return `User: ${userText}\n\nAssistant: ${truncatedAssistant}`;
}

/**
 * Session Namer extension entry point.
 *
 * @param pi - Extension API for registering handlers, commands, and flags
 */
export default function (pi: ExtensionAPI): void {
	pi.registerFlag("no-session-name", {
		description: "Disable automatic session naming",
		type: "boolean",
		default: false,
	});

	// ── session_start: set terminal title if name exists ──
	pi.on("session_start", async (_event, ctx) => {
		namingTriggered = false;
		const existing = pi.getSessionName();
		if (existing) {
			ctx.ui.setTitle(`tallow — ${existing}`);
		}
	});

	// ── agent_end: auto-name after first exchange ──
	pi.on("agent_end", async (event, ctx) => {
		if (pi.getFlag("no-session-name")) return;
		if (namingTriggered) return;
		if (pi.getSessionName()) return; // already named (resumed or manual)

		namingTriggered = true;

		// Extract first user message and first assistant response
		const messages = event.messages;
		let userText = "";
		let assistantText = "";

		for (const msg of messages) {
			if ("role" in msg && msg.role === "user" && !userText) {
				const content = msg.content;
				if (typeof content === "string") {
					userText = content;
				} else if (Array.isArray(content)) {
					userText = content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join(" ");
				}
			}
			if ("role" in msg && msg.role === "assistant" && !assistantText) {
				if (Array.isArray(msg.content)) {
					assistantText = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join(" ");
				}
			}
			if (userText && assistantText) break;
		}

		if (!userText) return;

		// Fire-and-forget: non-blocking LLM call
		const ui = ctx.ui;
		void (async () => {
			try {
				const model = findNamingModel(ctx);
				if (!model) return;

				const apiKey = await ctx.modelRegistry.getApiKey(model);
				if (!apiKey) return;

				const prompt = buildNamingPrompt(userText, assistantText);
				const response: AssistantMessage = await completeSimple(
					model,
					{
						systemPrompt: NAMING_SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: prompt }],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey, maxTokens: 50 }
				);

				const rawName = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join(" ");

				const name = cleanName(rawName);
				if (!name) return;

				pi.setSessionName(name);
				ui.setTitle(`tallow — ${name}`);
			} catch {
				// Silent failure — no name is fine
			}
		})();
	});

	// Built-in /name command handles view/set — no need to register one here.
}
