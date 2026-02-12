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

import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	createReadTool,
	type ExtensionAPI,
	keyHint,
	loadSkills,
	parseFrontmatter,
} from "@mariozechner/pi-coding-agent";
import { fileLink, Text, visibleWidth } from "@mariozechner/pi-tui";
import { getIcon } from "../_icons/index.js";
import { getToolDisplayConfig, renderLines, truncateForDisplay } from "../tool-display/index.js";

interface SkillCacheEntry {
	path: string;
	icon: string;
}

export const DEFAULT_SKILL_ICON = "📚";

/**
 * Resolve `~` to home directory.
 * @param p - Path that may start with ~/
 * @returns Absolute path
 */
function resolveHome(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * Get skill directory paths from settings.json packages.
 * Mirrors the pattern used by context-fork for agent dirs.
 * @returns Array of resolved skill directory paths from packages
 */
export function getPackageSkillPaths(): string[] {
	const settingsPath = join(
		process.env.TALLOW_CODING_AGENT_DIR ?? join(homedir(), ".tallow"),
		"settings.json"
	);
	if (!fs.existsSync(settingsPath)) return [];

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { packages?: Array<string | { source: string }> };
		if (!Array.isArray(settings.packages)) return [];

		const settingsDir = dirname(settingsPath);
		const paths: string[] = [];

		for (const pkg of settings.packages) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("https://"))
				continue;

			const resolved = resolveHome(
				source.startsWith("./") || source.startsWith("../") ? join(settingsDir, source) : source
			);
			const skillsDir = join(resolved, "skills");
			if (fs.existsSync(skillsDir)) paths.push(skillsDir);
		}

		return paths;
	} catch {
		return [];
	}
}

/** Skill name → { path, icon } cache. Populated lazily on first miss. */
let skillPathMap: Map<string, SkillCacheEntry> | null = null;

/**
 * Read the `icon` field from a SKILL.md file's YAML frontmatter.
 * @param filePath - Absolute path to SKILL.md
 * @returns The icon string, or the default emoji if missing/empty/unreadable
 */
export function readSkillIcon(filePath: string): string {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<{ icon?: string }>(raw);
		return frontmatter.icon || DEFAULT_SKILL_ICON;
	} catch {
		return DEFAULT_SKILL_ICON;
	}
}

/**
 * Build a map of skill name → { path, icon } from loaded skills.
 * Cached after first call; cleared on session start.
 * @returns Map from skill name to cache entry with path and icon
 */
function getSkillPathMap(): Map<string, SkillCacheEntry> {
	if (!skillPathMap) {
		skillPathMap = new Map();
		try {
			const { skills } = loadSkills({ skillPaths: getPackageSkillPaths() });
			for (const s of skills) {
				skillPathMap.set(s.name, {
					path: s.filePath,
					icon: readSkillIcon(s.filePath),
				});
			}
		} catch {
			// Best-effort — if loading fails, map stays empty
		}
	}
	return skillPathMap;
}

/**
 * Get the icon for a skill by name.
 * @param name - Skill name
 * @returns The skill's custom icon, or default 📚
 */
function getSkillIcon(name: string): string {
	return getSkillPathMap().get(name)?.icon ?? DEFAULT_SKILL_ICON;
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
	const entry = getSkillPathMap().get(name);
	if (entry && entry.path !== failedPath) return entry.path;
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

			// Skill file: show icon + skill: name with expand hint
			if (isSkillPath(path)) {
				const skillName = getSkillName(path);
				const icon = getSkillIcon(skillName);
				const left = theme.fg("accent", `${icon} skill: ${skillName}`);
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

			return new Text(
				theme.fg("toolTitle", theme.bold("read ")) + theme.fg("muted", fileLink(path)),
				0,
				0
			);
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
			// Linkify the file path portion of the summary (everything before the parens)
			const parenIdx = summary.indexOf(" (");
			const linkedSummary =
				parenIdx > 0
					? fileLink(summary.slice(0, parenIdx)) + summary.slice(parenIdx)
					: fileLink(summary);
			const footer = theme.fg("muted", `${getIcon("success")} ${linkedSummary}`);

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
