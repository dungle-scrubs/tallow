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
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme } from "@mariozechner/pi-tui";
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

// ─── Autocomplete model ──────────────────────────────────────────────────────

/**
 * Resolve the autocomplete model from the registry.
 * Tries the configured model, then falls back to any available Groq model.
 *
 * @param ctx - Extension context with model registry
 * @param modelSetting - Provider/model string (e.g. "groq/llama-3.1-8b-instant")
 * @returns Resolved model and API key, or null if unavailable
 */
async function resolveAutocompleteModel(
	ctx: ExtensionContext,
	modelSetting: string
): Promise<{ model: Model<Api>; apiKey: string } | null> {
	const slashIdx = modelSetting.indexOf("/");
	if (slashIdx === -1) return null;

	const provider = modelSetting.slice(0, slashIdx);
	const modelId = modelSetting.slice(slashIdx + 1);

	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) return null;

	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) return null;

	return { model, apiKey };
}

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

		// Extract text from the response
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		// Clean up: trim, remove quotes, take first line only
		const cleaned = text.trim().split("\n")[0]?.trim() ?? "";
		return cleaned.length > 0 ? cleaned : null;
	} catch {
		// Silently swallow errors (network, abort, rate limit)
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
	let editorRef: Editor | null = null;

	/** Extension context, captured on session_start for model registry access. */
	let ctxRef: ExtensionContext | null = null;

	/** Whether the agent is currently processing (suppress suggestions while busy). */
	let agentBusy = false;

	/** Debounce timer for idle suggestions (shows when input is cleared). */
	let idleTimer: ReturnType<typeof setTimeout> | null = null;

	/** Debounce timer for autocomplete model calls. */
	let autocompleteTimer: ReturnType<typeof setTimeout> | null = null;

	/** Abort controller for in-flight autocomplete requests. */
	let abortController: AbortController | null = null;

	/** Number of autocomplete calls made this session (cost guardrail). */
	let callCount = 0;

	/** Cached resolved model (resolved once on first autocomplete attempt). */
	let resolvedModel: { model: Model<Api>; apiKey: string } | null | undefined;

	/**
	 * Show an idle suggestion if the editor is empty and agent is idle.
	 */
	function showIdleSuggestion(): void {
		if (!editorRef || agentBusy) return;
		if (editorRef.getText().length > 0) return;

		const suggestion = pickIdleSuggestion();
		if (suggestion) {
			editorRef.setGhostText(suggestion);
		}
	}

	/** Cancel any pending or in-flight autocomplete. */
	function cancelAutocomplete(): void {
		if (autocompleteTimer) {
			clearTimeout(autocompleteTimer);
			autocompleteTimer = null;
		}
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
	}

	/**
	 * Trigger debounced autocomplete for the given partial input.
	 * Cancels any prior pending/in-flight request.
	 *
	 * @param partialInput - Current editor text
	 */
	function triggerAutocomplete(partialInput: string): void {
		cancelAutocomplete();

		if (!autocompleteEnabled || !ctxRef || agentBusy) return;
		if (callCount >= MAX_CALLS_PER_SESSION) return;

		// Don't autocomplete slash commands (handled by built-in autocomplete)
		if (partialInput.startsWith("/")) return;

		// Need at least a few characters to generate a useful completion
		if (partialInput.trim().length < 4) return;

		autocompleteTimer = setTimeout(async () => {
			if (!editorRef || !ctxRef) return;

			// Resolve model on first call
			if (resolvedModel === undefined) {
				resolvedModel = (await resolveAutocompleteModel(ctxRef, modelSetting as string)) ?? null;
			}
			if (!resolvedModel) return;

			abortController = new AbortController();
			callCount++;

			const completion = await getCompletion(
				resolvedModel.model,
				resolvedModel.apiKey,
				partialInput,
				abortController.signal
			);

			abortController = null;

			// Only show if editor text hasn't changed since we started
			if (editorRef && editorRef.getText() === partialInput && completion) {
				editorRef.setGhostText(completion);
			}
		}, debounceMs);
	}

	// ── Editor component registration ────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctxRef = ctx;

		ctx.ui.setEditorComponent((tui, editorTheme: EditorTheme) => {
			const editor = new Editor(tui, editorTheme);
			editorRef = editor;

			editor.onChange = (newText: string) => {
				// Clear pending timers on any text change
				if (idleTimer) {
					clearTimeout(idleTimer);
					idleTimer = null;
				}

				if (newText.length === 0 && !agentBusy) {
					// Text cleared — show idle suggestion after short delay
					cancelAutocomplete();
					idleTimer = setTimeout(showIdleSuggestion, 300);
				} else if (newText.length > 0) {
					// User is typing — trigger autocomplete
					triggerAutocomplete(newText);
				}
			};

			// Show initial idle suggestion
			setTimeout(showIdleSuggestion, 100);

			return editor;
		});
	});

	// ── Agent lifecycle ──────────────────────────────────────────────────────

	pi.on("turn_start", async () => {
		agentBusy = true;
		cancelAutocomplete();
		if (editorRef) editorRef.setGhostText(null);
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	});

	pi.on("turn_end", async () => {
		agentBusy = false;
		setTimeout(showIdleSuggestion, 200);
	});

	// ── Cleanup ──────────────────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		cancelAutocomplete();
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
		editorRef = null;
		ctxRef = null;
	});
}
