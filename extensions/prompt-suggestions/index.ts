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
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type EditorTheme } from "@mariozechner/pi-tui";
import { AutocompleteEngine } from "./autocomplete.js";
import { GENERAL_TEMPLATES, type PromptTemplate } from "./templates.js";

// ─── Settings ────────────────────────────────────────────────────────────────

/** Read a setting from ~/.tallow/settings.json with a typed fallback. */
function readSetting<T>(key: string, fallback: T): T {
	try {
		const raw = readFileSync(join(homedir(), ".tallow", "settings.json"), "utf-8");
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

// ─── LLM completion ──────────────────────────────────────────────────────────

/**
 * Call the autocomplete model with the user's partial input.
 *
 * @param model - Resolved model object
 * @param apiKey - API key for the model
 * @param partialInput - What the user has typed so far
 * @param signal - Abort signal to cancel in-flight requests
 * @returns Completion text, or null on failure/abort
 */
async function getCompletion(
	model: Model<Api>,
	apiKey: string,
	partialInput: string,
	signal: AbortSignal
): Promise<string | null> {
	try {
		const result = await completeSimple(
			model,
			{
				systemPrompt:
					"You are an autocomplete engine for a coding assistant CLI. " +
					"The user is typing a prompt to send to a coding agent. " +
					"Complete their partial input with the most likely continuation. " +
					"Reply with ONLY the completion text (the part that comes after what they typed). " +
					"Keep it concise — one sentence max. Do not repeat what they already typed. " +
					"Do not add quotes or formatting.",
				messages: [
					{
						role: "user",
						content: partialInput,
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
	let editorRef: CustomEditor | null = null;

	/** Autocomplete engine instance, created after editor is available. */
	let engine: AutocompleteEngine | null = null;

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
			editorRef = editor;

			engine = new AutocompleteEngine(
				{
					enabled: autocompleteEnabled,
					debounceMs: debounceMs,
					maxCalls: MAX_CALLS_PER_SESSION,
					modelSetting: modelSetting as string,
				},
				ctx.modelRegistry,
				getCompletion,
				(text) => editor.setGhostText(text),
				() => editor.getText()
			);

			editor.addChangeListener((newText: string) => {
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
	});
}
