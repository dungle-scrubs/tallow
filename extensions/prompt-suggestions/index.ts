/**
 * Prompt suggestions extension — shows ghost text suggestions in the editor.
 *
 * Two modes:
 * 1. **Idle suggestion**: When input is empty, shows a full suggested prompt
 *    as dim ghost text. Enter accepts and submits, typing dismisses.
 * 2. **Inline autocomplete**: As the user types, after a debounce, calls a
 *    fast/cheap model (Groq Llama 3.1 8B by default) to suggest a completion.
 *    Tab to accept, keep typing to dismiss.
 *
 * @param pi - Extension API from the pi framework
 */

import { readFileSync } from "node:fs";
import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { EditorTheme } from "@mariozechner/pi-tui";
import { getTallowSettingsPath } from "../_shared/tallow-paths.js";
import { AutocompleteEngine, type ConversationContext } from "./autocomplete.js";
import { GENERAL_TEMPLATES, type PromptTemplate } from "./templates.js";

// ─── Settings ────────────────────────────────────────────────────────────────

/** Read a setting from ~/.tallow/settings.json with a typed fallback. */
function readSetting<T>(key: string, fallback: T): T {
	try {
		const raw = readFileSync(getTallowSettingsPath(), "utf-8");
		const settings = JSON.parse(raw);
		return key in settings ? (settings[key] as T) : fallback;
	} catch {
		return fallback;
	}
}

/** Default model for autocomplete: Groq Llama 3.1 8B ($0.05/$0.08 per M tokens). */
const DEFAULT_AUTOCOMPLETE_MODEL = "groq/llama-3.1-8b-instant";

/** Default debounce in ms before calling the autocomplete model. */
const DEFAULT_DEBOUNCE_MS = 600;

/** Max autocomplete calls per session (cost guardrail). */
const MAX_CALLS_PER_SESSION = 200;

interface PromptSuggestionEditor {
	addChangeListener(fn: (text: string) => void): void;
	getText(): string;
	setGhostText(text: string | null): void;
}

/**
 * Resolve the subset of editor APIs required by prompt suggestions.
 *
 * Published installs may resolve upstream `@mariozechner/pi-tui`, whose
 * editor does not implement ghost-text helpers. In that case, the
 * extension should degrade safely instead of crashing.
 *
 * @param editor - Candidate editor instance
 * @returns Prompt-suggestion editor surface, or null when unavailable
 */
export function resolvePromptSuggestionEditor(editor: unknown): PromptSuggestionEditor | null {
	if (!editor || typeof editor !== "object") return null;
	const candidate = editor as Partial<PromptSuggestionEditor>;
	if (typeof candidate.getText !== "function") return null;
	if (typeof candidate.setGhostText !== "function") return null;
	if (typeof candidate.addChangeListener !== "function") return null;
	return candidate as PromptSuggestionEditor;
}

// ─── Idle suggestions ────────────────────────────────────────────────────────

/**
 * Pick a random idle suggestion from the general templates.
 *
 * @returns A suggestion text, or null if pool is empty
 */
function pickIdleSuggestion(): string | null {
	const pool: readonly PromptTemplate[] = GENERAL_TEMPLATES;
	if (pool.length === 0) return null;
	const idx = Math.floor(Math.random() * pool.length);
	return pool[idx]?.text ?? null;
}

// ─── Conversation context ────────────────────────────────────────────────────

/** Max characters of conversation context to include (keeps autocomplete fast/cheap). */
const MAX_CONTEXT_CHARS = 2000;

/** Max number of recent exchanges to extract. */
const MAX_EXCHANGES = 6;

/**
 * Extract text content from an AgentMessage for autocomplete context.
 *
 * @param message - Session message (user or assistant)
 * @returns Plain text content, or null if no text found
 */
export function extractMessageText(message: { role: string; content: unknown }): string | null {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		const texts = message.content
			.filter((c: { type: string }) => c.type === "text")
			.map((c: { text: string }) => c.text);
		return texts.length > 0 ? texts.join(" ") : null;
	}
	return null;
}

/**
 * Build conversation context from session entries for autocomplete.
 *
 * Extracts recent user/assistant text exchanges, omitting tool calls and
 * results. Truncates to stay within budget.
 *
 * @param sessionManager - Read-only session manager
 * @returns Conversation context, or null if no history
 */
export function buildConversationContext(
	sessionManager: ExtensionContext["sessionManager"]
): ConversationContext | null {
	const entries = sessionManager.getBranch();
	const exchanges: string[] = [];
	let totalChars = 0;

	// Walk backwards to get most recent exchanges first
	for (let i = entries.length - 1; i >= 0 && exchanges.length < MAX_EXCHANGES; i--) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;

		const msg = (entry as { type: "message"; message: { role: string; content: unknown } }).message;
		if (msg.role !== "user" && msg.role !== "assistant") continue;

		const text = extractMessageText(msg);
		if (!text) continue;

		// Truncate long messages (e.g. assistant responses with lots of code)
		const truncated = text.length > 500 ? `${text.slice(0, 500)}…` : text;
		const label = msg.role === "user" ? "User" : "Assistant";
		const line = `${label}: ${truncated}`;

		if (totalChars + line.length > MAX_CONTEXT_CHARS) break;
		exchanges.unshift(line);
		totalChars += line.length;
	}

	if (exchanges.length === 0) return null;
	return { recentExchanges: exchanges.join("\n\n") };
}

// ─── LLM completion ──────────────────────────────────────────────────────────

/**
 * Build the system prompt for general autocomplete, optionally including
 * conversation context.
 *
 * @param context - Recent conversation context, or null
 * @returns System prompt string
 */
export function buildAutocompleteSystemPrompt(context: ConversationContext | null): string {
	const base =
		"You are an inline autocomplete engine for a coding CLI. " +
		"A developer is typing a message to their coding agent. " +
		"Predict how the developer will finish their sentence. " +
		"Reply with ONLY the completion text — the part that comes after what they typed. " +
		"Keep it concise — one short clause or sentence. " +
		"Do not repeat what they already typed. " +
		"Do not add quotes, formatting, or explanations. " +
		"You are predicting the DEVELOPER's words, not responding as an AI assistant.";

	if (!context) return base;

	return `${base}\n\nHere is the recent conversation for context:\n\n${context.recentExchanges}`;
}

/**
 * Build a system prompt for `/loop` command autocomplete.
 *
 * The prompt teaches the model about natural-language loop syntax so it
 * suggests good intervals, specific conditions, and actionable tasks.
 * The user writes in natural language; a separate NL parser converts the
 * final command into strict `/loop` syntax.
 *
 * @param context - Recent conversation context, or null
 * @returns System prompt string
 */
export function buildLoopAutocompletePrompt(context: ConversationContext | null): string {
	const base =
		"You are completing a /loop command in a coding CLI. " +
		"The developer writes loops in natural language. The system parses it automatically.\n\n" +
		"A loop needs: a task to perform, how often, and optionally when to stop.\n\n" +
		"Good patterns:\n" +
		'- "check the latest GitHub Actions run every 2m until CI is green"\n' +
		'- "run the test suite every 30s until all tests pass"\n' +
		'- "check deploy health every 1m until all pods are healthy"\n' +
		'- "monitor build progress every 5m until the build completes"\n' +
		'- "check disk usage every 10m, max 20 times"\n\n' +
		"Reply with ONLY the completion text — the part that comes after what they typed. " +
		"Keep suggestions specific and actionable — avoid vague conditions like 'it works' or 'it's done'. " +
		"Suggest observable facts the agent can check. " +
		"If they wrote a task, suggest the interval and condition. " +
		"If they wrote an interval, suggest a clear task. " +
		"One line only. Do not repeat what they typed. Do not add formatting or explanations.";

	if (!context) return base;

	return `${base}\n\nRecent conversation for context:\n\n${context.recentExchanges}`;
}

/**
 * Select the appropriate system prompt based on the user's partial input.
 *
 * Commands with complex syntax (like `/loop`) get specialized prompts that
 * understand their structure and suggest valid, high-quality completions.
 *
 * @param partialInput - Current editor text
 * @param context - Recent conversation context, or null
 * @returns System prompt string
 */
export function selectAutocompletePrompt(
	partialInput: string,
	context: ConversationContext | null
): string {
	if (partialInput.startsWith("/loop ")) {
		return buildLoopAutocompletePrompt(context);
	}
	return buildAutocompleteSystemPrompt(context);
}

/**
 * Call the autocomplete model with the user's partial input and conversation context.
 *
 * @param model - Resolved model object
 * @param apiKey - API key for the model
 * @param partialInput - What the user has typed so far
 * @param signal - Abort signal to cancel in-flight requests
 * @param context - Recent conversation context for relevance
 * @returns Completion text, or null on failure/abort
 */
async function getCompletion(
	model: Model<Api>,
	apiKey: string,
	partialInput: string,
	signal: AbortSignal,
	context: ConversationContext | null
): Promise<string | null> {
	try {
		const userMessage = partialInput.startsWith("/loop ")
			? `Complete this /loop command:\n${partialInput}`
			: `Complete this developer message:\n${partialInput}`;

		const result = await completeSimple(
			model,
			{
				systemPrompt: selectAutocompletePrompt(partialInput, context),
				messages: [
					{
						role: "user",
						content: userMessage,
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, signal, maxTokens: 60, temperature: 0.3 }
		);

		if (signal.aborted) return null;

		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		const cleaned = text.trim().split("\n")[0]?.trim() ?? "";
		return cleaned.length > 0 ? cleaned : null;
	} catch {
		return null;
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

/**
 * Register the prompt suggestions extension.
 *
 * @param pi - Extension API from the pi framework
 */
export default function promptSuggestions(pi: ExtensionAPI): void {
	const enabled = readSetting("prompt-suggestions.enabled", true);
	if (!enabled) return;

	const autocompleteEnabled = readSetting("prompt-suggestions.autocomplete", true);
	const debounceMsConfig = readSetting("prompt-suggestions.debounceMs", DEFAULT_DEBOUNCE_MS);
	const debounceMs = typeof debounceMsConfig === "number" ? debounceMsConfig : DEFAULT_DEBOUNCE_MS;
	const modelSetting = readSetting("prompt-suggestions.model", DEFAULT_AUTOCOMPLETE_MODEL);

	/** Reference to the editor instance for ghost text control. */
	let editorRef: PromptSuggestionEditor | null = null;

	/** Autocomplete engine instance, created after editor is available. */
	let engine: AutocompleteEngine | null = null;

	/** Session manager reference for conversation context. */
	let sessionManagerRef: ExtensionContext["sessionManager"] | null = null;

	/** Debounce timer for idle suggestions (shows when input is cleared). */
	let idleTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Show an idle suggestion if the editor is empty and agent is idle.
	 */
	function showIdleSuggestion(): void {
		if (!editorRef || engine?.busy) return;
		if (editorRef.getText().length > 0) return;

		const suggestion = pickIdleSuggestion();
		if (suggestion) {
			editorRef.setGhostText(suggestion);
		}
	}

	/** Clear the idle suggestion timer. */
	function clearIdleTimer(): void {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	// ── Editor component registration ────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		sessionManagerRef = ctx.sessionManager;

		// Register Groq as a provider if not already available and env var is set
		if (!ctx.modelRegistry.find("groq", "llama-3.1-8b-instant") && process.env.GROQ_API_KEY) {
			ctx.modelRegistry.registerProvider("groq", {
				baseUrl: "https://api.groq.com/openai/v1",
				apiKey: process.env.GROQ_API_KEY,
				api: "openai-completions" as Api,
				models: [
					{
						id: "llama-3.1-8b-instant",
						name: "Llama 3.1 8B Instant",
						reasoning: false,
						input: ["text"],
						cost: { input: 0.05, output: 0.08, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 131072,
						maxTokens: 131072,
					},
				],
			});
		}

		ctx.ui.setEditorComponent((tui, editorTheme: EditorTheme, keybindings) => {
			const editor = new CustomEditor(tui, editorTheme, keybindings);
			const promptEditor = resolvePromptSuggestionEditor(editor);
			if (!promptEditor) {
				engine = null;
				editorRef = null;
				ctx.ui.notify(
					"Prompt suggestions disabled: current editor runtime lacks ghost-text support.",
					"warning"
				);
				return editor;
			}

			editorRef = promptEditor;
			engine = new AutocompleteEngine(
				{
					enabled: autocompleteEnabled,
					debounceMs: debounceMs,
					maxCalls: MAX_CALLS_PER_SESSION,
					modelSetting: modelSetting as string,
				},
				ctx.modelRegistry,
				getCompletion,
				(text) => promptEditor.setGhostText(text),
				() => promptEditor.getText(),
				() => (sessionManagerRef ? buildConversationContext(sessionManagerRef) : null)
			);

			promptEditor.addChangeListener((newText: string) => {
				clearIdleTimer();

				if (newText.length === 0 && !engine?.busy) {
					engine?.cancel();
					idleTimer = setTimeout(showIdleSuggestion, 300);
				} else if (newText.length > 0) {
					engine?.trigger(newText);
				}
			});

			setTimeout(showIdleSuggestion, 100);
			return editor;
		});
	});

	// ── Agent lifecycle ──────────────────────────────────────────────────────

	pi.on("turn_start", async () => {
		if (engine) engine.busy = true;
		if (editorRef) editorRef.setGhostText(null);
		clearIdleTimer();
	});

	pi.on("turn_end", async () => {
		if (engine) engine.busy = false;
		setTimeout(showIdleSuggestion, 200);
	});

	// ── Cleanup ──────────────────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		engine?.dispose();
		engine = null;
		clearIdleTimer();
		editorRef = null;
		sessionManagerRef = null;
	});
}
