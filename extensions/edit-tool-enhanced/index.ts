/**
 * Enhanced edit tool — shows full diff preview and final summary footer.
 *
 * When lazygit is installed and the edited file lives in a git repo,
 * each footer includes a clickable "diff" OSC 8 link using the
 * `tallow://diff/<path>` scheme. A WezTerm `open-uri` handler can
 * intercept this to open lazygit filtered to the edited file.
 */
import { execSync } from "node:child_process";
import * as path from "node:path";
import {
	createEditTool,
	type EditToolDetails,
	type ExtensionAPI,
	renderDiff,
	type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { fileLink, hyperlink, Text } from "@mariozechner/pi-tui";
import { getIcon } from "../_icons/index.js";
import { renderLines } from "../tool-display/index.js";

/**
 * Check whether an executable exists on PATH.
 *
 * @param name - Executable name to look up
 * @returns True if `which <name>` succeeds
 */
export function isOnPath(name: string): boolean {
	try {
		execSync(`which ${name}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Check whether a file path is inside a git working tree.
 *
 * @param filePath - Absolute path to the file
 * @returns True if the file's directory is inside a git repo
 */
export function isInGitRepo(filePath: string): boolean {
	try {
		execSync("git rev-parse --is-inside-work-tree", {
			cwd: path.dirname(filePath),
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Build a `tallow://diff/<path>` OSC 8 hyperlink for a file, or empty string
 * if lazygit is missing or the file isn't in a git repo.
 *
 * @param filename - Relative or absolute file path
 * @param themeFg - Theme's `fg` function for coloring
 * @param lazygitAvailable - Whether lazygit is on PATH
 * @returns Formatted diff link string, or empty string
 */
export function buildDiffLink(
	filename: string,
	themeFg: (style: ThemeColor, text: string) => string,
	lazygitAvailable: boolean
): string {
	const absolutePath = path.resolve(process.cwd(), filename);
	if (!lazygitAvailable || !isInGitRepo(absolutePath)) return "";
	return ` ${themeFg("dim", hyperlink(`tallow://diff/${encodeURIComponent(absolutePath)}`, "diff"))}`;
}

/** Cached at module load — true when `lazygit` is on PATH. */
const hasLazygit = isOnPath("lazygit");

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
			return new Text(
				theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("muted", fileLink(path)),
				0,
				0
			);
		},

		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			const path = params.path ?? "file";
			const result = await baseEditTool.execute(toolCallId, params, signal, onUpdate);
			const details = result.details as EditToolDetails | undefined;
			const diff = details?.diff ?? "";

			return {
				content: result.content,
				details: {
					...details,
					[EDIT_MARKER]: true,
					_diff: diff,
					_filename: path,
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
			const diffLink = buildDiffLink(finalFilename, theme.fg.bind(theme), hasLazygit);

			const footer =
				theme.fg("muted", `${getIcon("success")} ${fileLink(finalFilename)} (edit applied)`) +
				diffLink;

			if (details._diff) {
				const diffLines = renderDiff(details._diff).split("\n");
				return renderLines([...diffLines, "", footer]);
			}

			return renderLines([footer]);
		},
	});
}
