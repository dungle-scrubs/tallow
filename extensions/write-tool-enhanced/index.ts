/**
 * Enhanced write tool — shows full written content with summary footer.
 */
import { createWriteTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fileLink, Text } from "@mariozechner/pi-tui";
import { getIcon } from "../_icons/index.js";
import {
	appendSection,
	dimProcessOutputLine,
	formatPresentationText,
	formatSectionDivider,
	formatToolVerb,
	renderLines,
} from "../tool-display/index.js";

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
			const verb = formatToolVerb("write", false);
			return new Text(
				formatPresentationText(theme, "title", `${verb} `) +
					formatPresentationText(theme, "action", fileLink(path)),
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
			const styleProcessLine = (line: string): string =>
				dimProcessOutputLine(line, (value) =>
					formatPresentationText(theme, "process_output", value)
				);

			if (isPartial) {
				return renderLines([formatPresentationText(theme, "meta", "...")]);
			}

			if (!details?.[PREVIEW_MARKER]) {
				const textContent = result.content.find((c: { type: string }) => c.type === "text") as
					| { text: string }
					| undefined;
				return renderLines((textContent?.text ?? "").split("\n").map(styleProcessLine));
			}

			const summary = details._summary ?? "file";
			const parenIdx = summary.indexOf(" (");
			const linkedSummary =
				parenIdx > 0
					? fileLink(summary.slice(0, parenIdx)) + summary.slice(parenIdx)
					: fileLink(summary);
			const verb = formatToolVerb("write", true);
			const footer =
				formatPresentationText(theme, "status_success", `${getIcon("success")} ${verb}`) +
				` ${formatPresentationText(theme, "action", linkedSummary)}`;
			const body = details._content ?? "";
			const contentLines = body.split("\n").map(styleProcessLine);
			const lines: string[] = [];
			appendSection(lines, [formatSectionDivider(theme, "Content")]);
			appendSection(lines, contentLines);
			appendSection(lines, [footer], { blankBefore: true });
			return renderLines(lines, { wrap: expanded });
		},
	});
}
