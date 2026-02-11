/**
 * Enhanced edit tool — shows full diff preview and final summary footer.
 *
 * No animated progress indicator.
 */
import {
	createEditTool,
	type EditToolDetails,
	type ExtensionAPI,
	renderDiff,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { getIcon } from "../_icons/index.js";
import { renderLines } from "../tool-display/index.js";

const EDIT_MARKER = "__edit_live__";

interface EditLiveDetails {
	_diff?: string;
	_filename?: string;
	[EDIT_MARKER]?: boolean;
}

export default function editLive(pi: ExtensionAPI): void {
	const baseEditTool = createEditTool(process.cwd());

	pi.registerTool({
		name: "edit",
		label: baseEditTool.label,
		description: baseEditTool.description,
		parameters: baseEditTool.parameters,

		renderCall(args, theme) {
			const path = args.path ?? "file";
			const filename = path.split("/").pop() ?? path;
			return new Text(
				theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("muted", filename),
				0,
				0
			);
		},

		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			const path = params.path ?? "file";
			const filename = path.split("/").pop() ?? path;
			const result = await baseEditTool.execute(toolCallId, params, signal, onUpdate);
			const details = result.details as EditToolDetails | undefined;
			const diff = details?.diff ?? "";

			return {
				content: result.content,
				details: {
					...details,
					[EDIT_MARKER]: true,
					_diff: diff,
					_filename: filename,
				},
			};
		},

		renderResult(result, { isPartial }, theme) {
			const details = result.details as (EditToolDetails & EditLiveDetails) | undefined;
			const textContent = result.content.find((c: { type: string }) => c.type === "text") as
				| { text: string }
				| undefined;

			if (isPartial) {
				return renderLines([theme.fg("muted", "...")]);
			}

			const errorText = textContent?.text ?? "";
			if (errorText.startsWith("Error") || errorText.includes("not found")) {
				return renderLines([theme.fg("error", errorText || "Edit failed")]);
			}

			if (!details?.[EDIT_MARKER]) {
				if (details?.diff) {
					return renderLines(renderDiff(details.diff).split("\n"));
				}
				return renderLines((textContent?.text ?? "").split("\n"));
			}

			const finalFilename = details._filename ?? "file";
			const footer = theme.fg("muted", `${getIcon("success")} ${finalFilename} (edit applied)`);

			if (details._diff) {
				const diffLines = renderDiff(details._diff).split("\n");
				return renderLines([...diffLines, "", footer]);
			}

			return renderLines([footer]);
		},
	});
}
