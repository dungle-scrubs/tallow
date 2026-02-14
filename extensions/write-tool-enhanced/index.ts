/**
 * Enhanced write tool — shows full written content with summary footer.
 */
import { createWriteTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fileLink, Text } from "@mariozechner/pi-tui";
import { getIcon } from "../_icons/index.js";
import { renderLines } from "../tool-display/index.js";

const PREVIEW_MARKER = "__write_preview__";

interface WritePreviewDetails {
	_content?: string;
	_summary?: string;
	__write_preview__?: boolean;
}

export default function writePreview(pi: ExtensionAPI): void {
	const baseWriteTool = createWriteTool(process.cwd());

	pi.registerTool({
		name: "write",
		label: baseWriteTool.label,
		description: baseWriteTool.description,
		parameters: baseWriteTool.parameters,

		renderCall(args, theme) {
			const path = args.path ?? "file";
			return new Text(
				theme.fg("toolTitle", theme.bold("write ")) + theme.fg("muted", fileLink(path)),
				0,
				0
			);
		},

		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			const path = params.path ?? "file";
			const content = params.content ?? "";
			const lines = content.split("\n").length;
			const sizeKb = (content.length / 1024).toFixed(1);
			const summary = `${path} (${lines} lines, ${sizeKb}KB)`;

			const result = await baseWriteTool.execute(toolCallId, params, signal, onUpdate);
			return {
				content: result.content,
				details: {
					[PREVIEW_MARKER]: true,
					_content: content,
					_summary: summary,
				},
			};
		},

		renderResult(result, { isPartial, expanded }, theme) {
			const details = result.details as WritePreviewDetails | undefined;

			if (isPartial) {
				return renderLines([theme.fg("muted", "...")]);
			}

			if (!details?.[PREVIEW_MARKER]) {
				const textContent = result.content.find((c: { type: string }) => c.type === "text") as
					| { text: string }
					| undefined;
				return renderLines((textContent?.text ?? "").split("\n"));
			}

			const summary = details._summary ?? "file";
			// Linkify the file path portion of the summary (everything before the parens)
			const parenIdx = summary.indexOf(" (");
			const linkedSummary =
				parenIdx > 0
					? fileLink(summary.slice(0, parenIdx)) + summary.slice(parenIdx)
					: fileLink(summary);
			const footer = theme.fg("muted", `${getIcon("success")} ${linkedSummary}`);
			const body = details._content ?? "";
			const contentLines = body.split("\n").map((line) => theme.fg("dim", line));
			return renderLines([...contentLines, "", footer], { wrap: expanded });
		},
	});
}
