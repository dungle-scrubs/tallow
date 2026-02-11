/**
 * Enhanced bash tool with tail-truncated live output.
 *
 * Wraps the built-in bash tool. Same execute logic,
 * custom rendering that caps visible output to N tail lines.
 *
 * Uses raw render functions (not Text) for renderResult so that
 * line order is explicitly controlled — summary footer always last.
 *
 * During:   last 7 lines of streaming output
 *           ... (93 above lines, 100 total, ctrl+o to expand)
 * Done:     [output lines]
 *           ✓ bash (100 lines, 3.2KB, exit 0)
 * Expanded: full output + footer
 */
import {
	type BashToolDetails,
	createBashTool,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
	formatTruncationIndicator,
	getToolDisplayConfig,
	renderLines,
	truncateForDisplay,
} from "../tool-display/index.js";

/**
 * Strip non-display OSC escape sequences from bash output.
 *
 * Programs like nvim-treesitter emit OSC 1337 (iTerm2 SetUserVar) or other
 * application-specific OSC sequences that pi-tui's visibleWidth() doesn't
 * recognise. It only strips OSC 8 hyperlinks, so unrecognised sequences get
 * counted as visible characters, causing "exceeds terminal width" crashes.
 *
 * We strip all OSC sequences EXCEPT OSC 8 (hyperlinks) which pi-tui handles.
 * Format: \x1b] <params> (\x07 | \x1b\\)
 *
 * @param line - Raw output line from bash
 * @returns Line with non-display OSC sequences removed
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences requires control chars
const NON_DISPLAY_OSC_RE = /\x1b\](?!8;;)[^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripNonDisplayOsc(line: string): string {
	if (!line.includes("\u001b]")) return line;
	return line.replace(NON_DISPLAY_OSC_RE, "");
}

/**
 * Detect whether a line already contains ANSI escape sequences.
 *
 * We only need a lightweight check for CSI/OSC prefixes because bash output
 * from tools like git diff includes those directly in each affected line.
 *
 * @param line - Output line from bash
 * @returns True when ANSI escape sequences are already present
 */
function hasAnsiEscape(line: string): boolean {
	return line.includes("\u001b[") || line.includes("\u001b]");
}

/**
 * Keep existing ANSI-colored output untouched.
 *
 * Many commands (like git diff) already include color/reset sequences.
 * Wrapping those lines again with theme colors can create nested escape
 * state that leaks styling between rows.
 *
 * Strips non-display OSC sequences first so visibleWidth() counts correctly.
 *
 * @param line - Output line from bash
 * @param dim - Theme dim color function
 * @returns Safely styled line for display
 */
function styleBashLine(line: string, dim: (value: string) => string): string {
	const clean = stripNonDisplayOsc(line);
	return hasAnsiEscape(clean) ? clean : dim(clean);
}

export default function bashLive(pi: ExtensionAPI): void {
	const baseBashTool = createBashTool(process.cwd());
	const displayConfig = getToolDisplayConfig("bash");

	pi.registerTool({
		name: "bash",
		label: baseBashTool.label,
		description: baseBashTool.description,
		parameters: baseBashTool.parameters,

		renderCall(args, theme) {
			const cmd = args.command ?? "";
			const firstLine = cmd.split("\n")[0];
			const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
			const multiLine = cmd.includes("\n") ? theme.fg("dim", " (multiline)") : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("bash ")) + theme.fg("muted", preview) + multiLine,
				0,
				0
			);
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cmd = params.command ?? "";
			const firstLine = cmd.split("\n")[0];
			const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
			ctx.ui.setWorkingMessage(`Running: ${preview}`);
			try {
				return await baseBashTool.execute(toolCallId, params, signal, onUpdate);
			} catch (err) {
				// Exit code 1 is normal for many commands (grep, diff, test).
				// Pi core rejects on any non-zero exit, but exit 1 shouldn't be an error.
				const msg = err instanceof Error ? err.message : String(err);
				const exitMatch = msg.match(/Command exited with code (\d+)/);
				if (exitMatch && Number(exitMatch[1]) === 1) {
					return { content: [{ type: "text" as const, text: msg }], details: undefined };
				}
				throw err;
			} finally {
				ctx.ui.setWorkingMessage();
			}
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const textContent = result.content.find((c: { type: string }) => c.type === "text") as
				| { text: string }
				| undefined;
			const text = textContent?.text ?? "";
			const details = result.details as BashToolDetails | undefined;

			// During execution: show tail-truncated live output
			if (isPartial) {
				if (!text) return renderLines([theme.fg("muted", "...")]);

				const { visible, truncated, totalLines, hiddenLines } = truncateForDisplay(
					text,
					displayConfig
				);

				const lines: string[] = [];
				if (truncated) {
					lines.push(formatTruncationIndicator(displayConfig, totalLines, hiddenLines, theme));
				}
				for (const line of visible.split("\n")) {
					lines.push(styleBashLine(line, (value) => theme.fg("dim", value)));
				}
				return renderLines(lines);
			}

			// Done: build exit status summary
			const lineCount = text.split("\n").length;
			const sizeKb = (text.length / 1024).toFixed(1);

			const exitMatch = text.match(/Command exited with code (\d+)/);
			const exitCode = exitMatch ? Number(exitMatch[1]) : 0;

			// Exit 0–1: normal (grep no-match, diff, test false, etc.)
			const statusIcon = exitCode <= 1 ? "✓" : "✗";
			const statusColor = exitCode <= 1 ? "muted" : "error";
			const summary = `${statusIcon} bash (${lineCount} lines, ${sizeKb}KB, exit ${exitCode})`;
			const fullPathSuffix = details?.fullOutputPath
				? theme.fg("dim", ` → ${details.fullOutputPath}`)
				: "";

			// Expanded: show all output, footer last
			if (expanded) {
				const lines: string[] = [];
				for (const line of text.split("\n")) {
					lines.push(styleBashLine(line, (value) => theme.fg("dim", value)));
				}
				lines.push(theme.fg(statusColor, summary) + fullPathSuffix);
				return renderLines(lines);
			}

			// Collapsed: show tail-truncated output, footer last
			const { visible, truncated, totalLines, hiddenLines } = truncateForDisplay(
				text,
				displayConfig
			);

			const lines: string[] = [];
			if (truncated) {
				lines.push(formatTruncationIndicator(displayConfig, totalLines, hiddenLines, theme));
			}
			for (const line of visible.split("\n")) {
				lines.push(styleBashLine(line, (value) => theme.fg("dim", value)));
			}
			lines.push(theme.fg(statusColor, summary) + fullPathSuffix);
			return renderLines(lines);
		},
	});
}
