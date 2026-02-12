/**
 * Ask User Question Tool - Single question with options
 * Full custom UI: options list + inline editor for "Type something..."
 * Escape in editor returns to options, Escape in options cancels
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Loader,
	matchesKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";

/** An option with a label and optional description */
interface OptionWithDesc {
	label: string;
	description?: string;
}

/** Display option including the "Type something" option */
type DisplayOption = OptionWithDesc & { isOther?: boolean };

/** Details returned from the ask_user_question tool execution */
interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(
		Type.String({ description: "Optional description shown below label" })
	),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

/**
 * Registers the ask_user_question tool with Pi.
 * Provides an interactive UI for asking users questions with selectable options.
 * @param pi - The Pi extension API
 */
export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: `Ask the user a question and let them pick from options. Use when you need user input to proceed.

WHEN TO USE:
- Need user to choose between distinct options
- Clarifying ambiguous requests
- Confirming destructive actions
- Selecting from multiple valid approaches

WHEN NOT TO USE:
- You can make a reasonable default choice
- The answer is obvious from context
- User already specified preference`,
		parameters: QuestionParams,

		/**
		 * Executes the ask_user_question tool, displaying an interactive selection UI.
		 * @param _toolCallId - Unique identifier for this tool call
		 * @param params - The question and options to display
		 * @param _onUpdate - Callback for streaming updates (unused)
		 * @param ctx - Extension context with UI access
		 * @param _signal - Abort signal for cancellation
		 * @returns Tool result with the user's selection
		 */
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{ type: "text", text: "Error: UI not available (running in non-interactive mode)" },
					],
					details: {
						question: params.question,
						options: params.options.map((o) => o.label),
						answer: null,
					} as QuestionDetails,
				};
			}

			if (params.options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No options provided" }],
					details: { question: params.question, options: [], answer: null } as QuestionDetails,
				};
			}

			const allOptions: DisplayOption[] = [
				...params.options,
				{ label: "Type something.", isOther: true },
			];

			ctx.ui.setWorkingMessage(Loader.HIDE);

			const result = await ctx.ui.custom<{
				answer: string;
				wasCustom: boolean;
				index?: number;
			} | null>((tui, theme, _kb, done) => {
				let optionIndex = 0;
				let editMode = false;
				let cachedLines: string[] | undefined;

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (trimmed) {
						done({ answer: trimmed, wasCustom: true });
					} else {
						editMode = false;
						editor.setText("");
						refresh();
					}
				};

				/**
				 * Invalidates the cached render and requests a UI refresh.
				 */
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				/**
				 * Handles keyboard input for navigation and selection.
				 * @param data - The raw input data from the terminal
				 */
				function handleInput(data: string) {
					if (editMode) {
						if (matchesKey(data, Key.escape)) {
							editMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter)) {
						const selected = allOptions[optionIndex];
						if (selected.isOther) {
							editMode = true;
							refresh();
						} else {
							done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
						}
						return;
					}

					if (matchesKey(data, Key.escape)) {
						done(null);
					}
				}

				/**
				 * Renders the question UI with options list.
				 * @param width - Available width for rendering
				 * @returns Array of rendered lines
				 */
				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));
					// Wrap question text instead of truncating
					for (const line of wrapTextWithAnsi(theme.fg("text", ` ${params.question}`), width)) {
						lines.push(line);
					}
					lines.push("");

					for (let i = 0; i < allOptions.length; i++) {
						const opt = allOptions[i];
						const selected = i === optionIndex;
						const isOther = opt.isOther === true;
						const prefix = selected ? theme.fg("accent", "> ") : "  ";

						if (isOther && editMode) {
							add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
						} else if (selected) {
							add(prefix + theme.fg("accent", `${i + 1}. ${opt.label}`));
						} else {
							add(`  ${theme.fg("text", `${i + 1}. ${opt.label}`)}`);
						}

						// Show description if present
						if (opt.description) {
							add(`     ${theme.fg("muted", opt.description)}`);
						}
					}

					if (editMode) {
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(Math.max(1, width - 2))) {
							add(` ${line}`);
						}
					}

					lines.push("");
					if (editMode) {
						add(theme.fg("dim", " Enter to submit • Esc to go back"));
					} else {
						add(theme.fg("dim", " ↑↓ navigate • Enter to select • Esc to cancel"));
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			// Restore the working loader now that user has answered
			ctx.ui.setWorkingMessage();

			// Build simple options list for details
			const simpleOptions = params.options.map((o) => o.label);

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: null,
					} as QuestionDetails,
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: result.answer,
						wasCustom: true,
					} as QuestionDetails,
				};
			}
			return {
				content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: false,
				} as QuestionDetails,
			};
		},

		/**
		 * Renders the tool call display in the conversation.
		 * @param args - The tool arguments
		 * @param theme - Theme for styling
		 * @returns Text element for display
		 */
		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		/**
		 * Renders the tool result display in the conversation.
		 * @param result - The tool execution result
		 * @param _options - Render options (unused)
		 * @param theme - Theme for styling
		 * @returns Text element for display
		 */
		renderResult(result, _options, theme) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", `${getIcon("success")} `) +
						theme.fg("muted", "(wrote) ") +
						theme.fg("accent", details.answer),
					0,
					0
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(
				theme.fg("success", `${getIcon("success")} `) + theme.fg("accent", display),
				0,
				0
			);
		},
	});
}
