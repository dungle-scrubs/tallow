/**
 * Enhanced read tool with:
 * - Live truncated content during execution (first N lines)
 * - Compact summary when done (✓ file.md (22 lines, 0.8KB))
 * - Special rendering for SKILL.md files
 * - Full content always sent to LLM via context restoration
 *
 * Uses raw render functions for renderResult so that
 * line order is explicitly controlled — summary footer always last.
 *
 * Call:     read index.ts
 * Loading:  [first 7 lines of content]
 *           ... (143 more lines, 150 total, ctrl+o to expand)
 * Complete: ✓ index.ts (150 lines, 4.2KB)
 * Expanded: [full content]
 *           ✓ index.ts (150 lines, 4.2KB)
 * Skill:    📚 skill: git (collapsed by default)
 */
import {
	createReadTool,
	type ExtensionAPI,
	keyHint,
	loadSkills,
} from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth } from "@mariozechner/pi-tui";
import { getIcon } from "../_icons/index.js";
import { getToolDisplayConfig, renderLines, truncateForDisplay } from "../tool-display/index.js";

/** Skill name → correct absolute file path cache. Populated lazily on first miss. */
let skillPathMap: Map<string, string> | null = null;

/**
 * Build a map of skill name → filePath from loaded skills.
 * Cached after first call; cleared on session start.
 * @returns Map from skill name to absolute SKILL.md path
 */
function getSkillPathMap(): Map<string, string> {
	if (!skillPathMap) {
		skillPathMap = new Map();
		try {
			const { skills } = loadSkills();
			for (const s of skills) {
				skillPathMap.set(s.name, s.filePath);
			}
		} catch {
			// Best-effort — if loading fails, map stays empty
		}
	}
	return skillPathMap;
}

/**
 * Resolve the correct skill path when the LLM guesses wrong.
 * Extracts the skill name from a failed path and looks up the real location.
 * @param failedPath - The path that produced ENOENT
 * @returns Correct absolute path if found, or null
 */
function resolveSkillFallback(failedPath: string): string | null {
	const name = getSkillName(failedPath);
	if (name === "unknown") return null;
	const correctPath = getSkillPathMap().get(name);
	if (correctPath && correctPath !== failedPath) return correctPath;
	return null;
}

const SUMMARY_MARKER = "__summarized_read__";
const MIN_SIZE_TO_SUMMARIZE = 500; // bytes

/**
 * Check if the read path points to a skill file.
 * @param path - File path being read
 * @returns True if path matches the /skills/{name}/SKILL.md pattern
 */
function isSkillPath(path: string): boolean {
	return path.includes("/skills/") && path.endsWith("SKILL.md");
}

/**
 * Extract the skill name from a SKILL.md path.
 * @param path - File path matching /skills/<name>/SKILL.md
 * @returns Skill name extracted from parent directory
 */
function getSkillName(path: string): string {
	const match = path.match(/\/skills\/([^/]+)\/SKILL\.md$/);
	return match?.[1] ?? "unknown";
}

/**
 * Check if file content looks like a skill file (has frontmatter with name/description).
 * @param content - Raw file content
 * @returns True if content has YAML frontmatter with skill metadata
 */
function isSkillContent(content: string): boolean {
	return (
		content.startsWith("---") && content.includes("\nname:") && content.includes("\ndescription:")
	);
}

export default function readSummary(pi: ExtensionAPI): void {
	const baseReadTool = createReadTool(process.cwd());
	const displayConfig = getToolDisplayConfig("read");

	pi.registerTool({
		name: "read",
		label: baseReadTool.label,
		description: baseReadTool.description,
		parameters: baseReadTool.parameters,

		renderCall(args, theme) {
			const path = args.path ?? "file";

			// Skill file: show 📚 skill: name with expand hint
			if (isSkillPath(path)) {
				const skillName = getSkillName(path);
				const left = theme.fg("accent", `📚 skill: ${skillName}`);
				const right = theme.fg("dim", keyHint("expandTools", "to expand"));

				return {
					render(width: number): string[] {
						const leftWidth = visibleWidth(left);
						const rightWidth = visibleWidth(right);
						const gap = width - leftWidth - rightWidth;
						if (gap >= 2) {
							return [left + " ".repeat(gap) + right];
						}
						return [left];
					},
					invalidate() {},
				};
			}

			return new Text(theme.fg("toolTitle", theme.bold("read ")) + theme.fg("muted", path), 0, 0);
		},

		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			let path = params.path ?? "file";

			let result: Awaited<ReturnType<typeof baseReadTool.execute>>;
			try {
				result = await baseReadTool.execute(toolCallId, params, signal, onUpdate);
			} catch (err: unknown) {
				// Auto-correct wrong skill paths: if ENOENT on a skill-looking path,
				// look up the correct path from loaded skills and retry transparently.
				const isEnoent =
					err instanceof Error &&
					(err.message.includes("ENOENT") || (err as NodeJS.ErrnoException).code === "ENOENT");
				if (isEnoent && isSkillPath(path)) {
					const correctPath = resolveSkillFallback(path);
					if (correctPath) {
						path = correctPath;
						result = await baseReadTool.execute(
							toolCallId,
							{ ...params, path: correctPath },
							signal,
							onUpdate
						);
					} else {
						throw err;
					}
				} else {
					throw err;
				}
			}

			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") return result;

			const fullText = textContent.text;

			// Stream the live truncated preview via onUpdate
			if (fullText.length >= MIN_SIZE_TO_SUMMARIZE) {
				const { visible, truncated, totalLines, hiddenLines } = truncateForDisplay(
					fullText,
					displayConfig
				);
				const previewLines = truncated
					? `${visible}\n... (${hiddenLines} more lines, ${totalLines} total)`
					: visible;

				onUpdate?.({
					content: [{ type: "text", text: previewLines }],
					details: { _preview: true },
				});
			}

			// Don't summarize small files
			if (fullText.length < MIN_SIZE_TO_SUMMARIZE) return result;

			const lines = fullText.split("\n").length;
			const sizeKb = (fullText.length / 1024).toFixed(1);
			const summary = `${path} (${lines} lines, ${sizeKb}KB)`;

			return {
				content: [{ type: "text", text: summary }],
				details: {
					...(typeof result.details === "object" ? result.details : {}),
					[SUMMARY_MARKER]: true,
					_fullText: fullText,
					_path: path,
					_filename: path,
					_isSkill: isSkillContent(fullText),
				},
			};
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as
				| {
						_loading?: boolean;
						_preview?: boolean;
						_filename?: string;
						_fullText?: string;
						_isSkill?: boolean;
						[SUMMARY_MARKER]?: boolean;
				  }
				| undefined;

			const textContent = result.content.find((c: { type: string }) => c.type === "text") as
				| { text: string }
				| undefined;

			// Live preview during execution
			if (isPartial && details?._preview) {
				const previewText = textContent?.text ?? "";
				return renderLines(previewText.split("\n").map((l) => theme.fg("dim", l)));
			}

			// Loading state (fallback)
			if (isPartial) {
				return renderLines([theme.fg("muted", "...")]);
			}

			// Skill file: collapsed by default, show full on expand
			if (details?._isSkill) {
				if (expanded && details?._fullText) {
					return renderLines(details._fullText.split("\n"));
				}
				return renderLines([]);
			}

			// If not summarized, show raw content
			if (!details?.[SUMMARY_MARKER]) {
				const raw = textContent?.text ?? "";
				return renderLines(raw.split("\n").map((l) => theme.fg("dim", l)));
			}

			const summary = textContent?.text ?? "file";
			const footer = theme.fg("muted", `${getIcon("success")} ${summary}`);

			// Expanded: full content, then summary footer at bottom
			if (expanded && details?._fullText) {
				const contentLines = details._fullText.split("\n").map((l) => theme.fg("dim", l));
				return renderLines([...contentLines, footer]);
			}

			// Collapsed: summary footer only
			return renderLines([footer]);
		},
	});

	// Invalidate skill path cache on session start (skills may have changed)
	pi.on("session_start", async () => {
		skillPathMap = null;
	});

	// Restore full content for LLM context
	pi.on("context", async (event, _ctx) => {
		const messages = event.messages;
		let modified = false;

		for (const msg of messages) {
			if (msg.role !== "toolResult") continue;

			const details = msg.details as Record<string, unknown> | undefined;
			if (!(details?.[SUMMARY_MARKER] && details._fullText)) continue;

			const textContent = msg.content.find(
				(c): c is { type: "text"; text: string } => c.type === "text"
			);
			if (textContent) {
				textContent.text = details._fullText as string;
				modified = true;
			}
		}

		if (modified) {
			return { messages };
		}
	});
}
