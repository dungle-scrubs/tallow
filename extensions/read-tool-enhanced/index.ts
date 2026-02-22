/**
 * Enhanced read tool with:
 * - Live truncated content during execution (first N lines)
 * - Compact summary when done (✓ file.md (22 lines, 0.8KB))
 * - Special rendering for SKILL.md files
 * - Structured parsing for PDFs and Jupyter notebooks
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
import { dirname, join, resolve } from "node:path";
import {
	createReadTool,
	type ExtensionAPI,
	keyHint,
	loadSkills,
	parseFrontmatter,
} from "@mariozechner/pi-coding-agent";
import {
	createImageMetadata,
	detectImageFormat,
	fileLink,
	formatImageDimensions,
	getImageDimensions,
	type ImageMetadata,
	imageFormatToMime,
	Text,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getIcon } from "../_icons/index.js";
import {
	appendSection,
	dimProcessOutputLine,
	formatPresentationText,
	formatSectionDivider,
	formatToolVerb,
	getToolDisplayConfig,
	renderLines,
	truncateForDisplay,
} from "../tool-display/index.js";
import {
	formatNotebookOutput,
	isNotebook,
	NOTEBOOK_MARKER,
	NotebookParseError,
	parseNotebook,
	summarizeNotebookCounts,
} from "./notebook.js";
import {
	formatPdfOutput,
	isPdf,
	PdfEncryptedError,
	PdfParseError,
	parsePageRanges,
	parsePdf,
} from "./pdf.js";

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
			const source =
				typeof pkg === "string"
					? pkg
					: typeof pkg === "object" && pkg !== null && "source" in pkg
						? pkg.source
						: null;
			if (!source || typeof source !== "string") continue;
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

/**
 * Parse display dimensions from the base read tool's resize note.
 *
 * The base tool emits text like:
 * `[Image: original 3840x2160, displayed at 800x450. ...]`
 *
 * @param text - Text content from the base tool's image result
 * @returns Parsed display dimensions, or null if not found
 */
function parseDisplayDimensions(
	text: string | undefined
): { widthPx: number; heightPx: number } | null {
	if (!text) return null;
	const match = text.match(/displayed at (\d+)x(\d+)/);
	if (!match) return null;
	return { widthPx: Number(match[1]), heightPx: Number(match[2]) };
}

/** Bytes needed to detect image format from magic numbers. */
const FORMAT_SNIFF_BYTES = 12;

/**
 * Detect image format from the first bytes of a file.
 *
 * Reads only 12 bytes using a file descriptor for minimal I/O overhead.
 * Returns null if the file doesn't exist, is unreadable, or isn't a
 * recognized image format.
 *
 * @param absolutePath - Absolute path to the file
 * @returns Detected MIME type string, or null
 */
async function detectImageFormatFromFile(absolutePath: string): Promise<string | null> {
	try {
		const fd = fs.openSync(absolutePath, "r");
		try {
			const buf = Buffer.alloc(FORMAT_SNIFF_BYTES);
			const bytesRead = fs.readSync(fd, buf, 0, FORMAT_SNIFF_BYTES, 0);
			if (bytesRead === 0) return null;
			const format = detectImageFormat(buf.subarray(0, bytesRead));
			return format ? imageFormatToMime(format) : null;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** Marker for image results in details, used by renderResult. */
const IMAGE_MARKER = "__image_read__";

/** Marker for PDF results in details, used by renderResult. */
const PDF_MARKER = "__pdf_read__";

/**
 * Execute PDF reading: parse, format, and return a summarized result.
 *
 * @param absolutePath - Absolute path to the PDF file
 * @param displayPath - Original user-facing path string
 * @param pagesArg - Optional page range string from the user
 * @param onUpdate - Streaming update callback for live preview
 * @returns Tool result with PDF content and summary metadata
 */
async function executePdf(
	absolutePath: string,
	displayPath: string,
	pagesArg: string | undefined,
	onUpdate?: (partialResult: {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	}) => void
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}> {
	const buffer = fs.readFileSync(absolutePath);
	let pages: number[] | undefined;

	if (pagesArg) {
		try {
			pages = parsePageRanges(pagesArg);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: `Error parsing page range: ${msg}` }],
				details: {},
				isError: true,
			};
		}
	}

	try {
		const result = await parsePdf(buffer, pages);
		const formatted = formatPdfOutput(result, pages);

		// Stream a preview during execution
		const previewLines = formatted.split("\n").slice(0, 10).join("\n");
		onUpdate?.({
			content: [{ type: "text" as const, text: previewLines }],
			details: { _preview: true },
		});

		const sizeKb = (Buffer.byteLength(formatted, "utf-8") / 1024).toFixed(1);
		const pagesLabel = pages ? `pages ${pagesArg}` : `${result.totalPages} pages`;
		const summary = `${displayPath} (${pagesLabel}, ${sizeKb}KB extracted)`;
		const emptyText = result.text.trim().length === 0;

		return {
			content: [
				{
					type: "text" as const,
					text: emptyText
						? `PDF has ${result.totalPages} pages but no extractable text (may be scanned/image-only)`
						: summary,
				},
			],
			details: {
				[PDF_MARKER]: true,
				_fullText: formatted,
				_path: displayPath,
				_filename: displayPath,
				_totalPages: result.totalPages,
				_isPdf: true,
				_emptyText: emptyText,
			},
		};
	} catch (err: unknown) {
		if (err instanceof PdfEncryptedError) {
			return {
				content: [
					{ type: "text" as const, text: "Cannot read PDF: file is encrypted/password-protected" },
				],
				details: {},
			};
		}
		if (err instanceof PdfParseError) {
			return {
				content: [{ type: "text" as const, text: err.message }],
				details: {},
			};
		}
		throw err;
	}
}

/**
 * Execute notebook reading: parse notebook JSON, format cell content, and summarize.
 *
 * @param absolutePath - Absolute path to the notebook file
 * @param displayPath - Original user-facing path string
 * @param onUpdate - Streaming update callback for live preview
 * @returns Tool result with notebook content and summary metadata
 */
function executeNotebook(
	absolutePath: string,
	displayPath: string,
	onUpdate?: (partialResult: {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	}) => void
): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
} {
	const notebookContent = fs.readFileSync(absolutePath, "utf-8");

	try {
		const notebook = parseNotebook(notebookContent);
		const formatted = formatNotebookOutput(notebook);
		const counts = summarizeNotebookCounts(notebook);

		// Stream a preview during execution
		const previewLines = formatted.split("\n").slice(0, 10).join("\n");
		onUpdate?.({
			content: [{ type: "text" as const, text: previewLines }],
			details: { _preview: true },
		});

		const sizeKb = (Buffer.byteLength(formatted, "utf-8") / 1024).toFixed(1);
		const summary =
			`${displayPath} (${notebook.cells.length} cells, ` +
			`${counts.codeCells} code, ${counts.markdownCells} markdown, ` +
			`${counts.outputCount} outputs, ${sizeKb}KB extracted)`;

		return {
			content: [{ type: "text" as const, text: summary }],
			details: {
				[NOTEBOOK_MARKER]: true,
				_fullText: formatted,
				_path: displayPath,
				_filename: displayPath,
				_cellCount: notebook.cells.length,
				_codeCellCount: counts.codeCells,
				_markdownCellCount: counts.markdownCells,
				_outputCount: counts.outputCount,
				_rawCellCount: counts.rawCells,
				_language: notebook.language,
			},
		};
	} catch (err: unknown) {
		if (err instanceof NotebookParseError) {
			return {
				content: [{ type: "text" as const, text: err.message }],
				details: {},
				isError: true,
			};
		}
		throw err;
	}
}

/**
 * Linkify the file-path prefix in a summary string.
 *
 * Summaries follow `<path> (<meta>)`; this keeps metadata plain while turning
 * the path into an OSC 8 file link.
 *
 * @param summary - Summary text with optional metadata in parentheses
 * @returns Summary with the file path portion linkified
 */
function linkifySummaryPath(summary: string): string {
	const parenIdx = summary.indexOf(" (");
	return parenIdx > 0
		? fileLink(summary.slice(0, parenIdx)) + summary.slice(parenIdx)
		: fileLink(summary);
}

/**
 * Extended read tool schema that adds a `pages` parameter for PDF page selection.
 * Non-PDF files ignore this parameter.
 */
const enhancedReadSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Number({ description: "Line number to start reading from (1-indexed)" })
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	pages: Type.Optional(
		Type.String({
			description: 'Page range for PDF files (e.g. "1-5", "1,3,7-10"). Ignored for non-PDF files.',
		})
	),
});

export default function readSummary(pi: ExtensionAPI): void {
	const baseReadTool = createReadTool(process.cwd());
	const displayConfig = getToolDisplayConfig("read");

	pi.registerTool({
		name: "read",
		label: baseReadTool.label,
		description: baseReadTool.description,
		parameters: enhancedReadSchema,

		renderCall(args, theme) {
			const path = args.path ?? "file";

			// Skill file: show icon + skill: name with expand hint
			if (isSkillPath(path)) {
				const skillName = getSkillName(path);
				const icon = getSkillIcon(skillName);
				const left =
					formatPresentationText(theme, "identity", icon) +
					` ${formatPresentationText(theme, "identity", `skill: ${skillName}`)}`;
				const right = formatPresentationText(theme, "hint", keyHint("expandTools", "to expand"));

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

			// PDF file: show pages if specified
			const verb = formatToolVerb("read", false);
			const pagesArg = args.pages as string | undefined;
			if (pagesArg) {
				return new Text(
					formatPresentationText(theme, "title", `${verb} `) +
						formatPresentationText(theme, "action", fileLink(path)) +
						formatPresentationText(theme, "meta", ` (pages ${pagesArg})`),
					0,
					0
				);
			}

			return new Text(
				formatPresentationText(theme, "title", `${verb} `) +
					formatPresentationText(theme, "action", fileLink(path)),
				0,
				0
			);
		},

		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			let path = params.path ?? "file";

			const absolutePath = resolve(process.cwd(), path);

			// ── PDF handling ────────────────────────────────────
			if (await isPdf(absolutePath)) {
				return executePdf(absolutePath, path, params.pages as string | undefined, onUpdate);
			}

			// ── Notebook handling (.ipynb) ──────────────────────
			if (isNotebook(absolutePath)) {
				return executeNotebook(absolutePath, path, onUpdate);
			}

			// ── Image detection from bytes ──────────────────────
			// Read first 12 bytes to detect image format by magic numbers.
			// The base tool handles actual image reading via file-type; we
			// detect early to capture structured metadata for display.
			const detectedMime = await detectImageFormatFromFile(absolutePath);
			if (detectedMime) {
				const result = await baseReadTool.execute(toolCallId, params, signal, onUpdate);

				// Extract image metadata from the base tool's result
				const imageContent = result.content.find((c: { type: string }) => c.type === "image") as
					| { type: "image"; data: string; mimeType: string }
					| undefined;

				let imageMeta: ImageMetadata | undefined;
				if (imageContent) {
					const mime = imageContent.mimeType;
					const origDims = getImageDimensions(imageContent.data, mime);
					const format = detectImageFormat(Buffer.from(imageContent.data.slice(0, 64), "base64"));

					if (origDims) {
						// Parse display dimensions from the base tool's resize note
						const textContent = result.content.find((c: { type: string }) => c.type === "text") as
							| { text: string }
							| undefined;
						const displayDims = parseDisplayDimensions(textContent?.text) ?? origDims;
						const fileStat = fs.statSync(absolutePath, { throwIfNoEntry: false });
						imageMeta = createImageMetadata(origDims, displayDims, format, fileStat?.size);
					}
				}

				const sizeKb = imageMeta?.sizeBytes
					? `${(imageMeta.sizeBytes / 1024).toFixed(1)}KB`
					: undefined;
				const dimStr = imageMeta ? formatImageDimensions(imageMeta) : undefined;
				const fmtLabel = imageMeta?.format?.toUpperCase();
				const parts = [fmtLabel, dimStr, sizeKb].filter(Boolean);
				const summary = parts.length > 0 ? `${path} (${parts.join(", ")})` : `${path}`;

				return {
					content: [
						{ type: "text" as const, text: summary },
						...result.content.filter((c: { type: string }) => c.type === "image"),
					],
					details: {
						[IMAGE_MARKER]: true,
						_path: path,
						_filename: path,
						_imageMetadata: imageMeta,
					},
				};
			}

			// ── Standard file handling ──────────────────────────
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
						_cellCount?: number;
						_codeCellCount?: number;
						_emptyText?: boolean;
						_imageMetadata?: ImageMetadata;
						_isPdf?: boolean;
						_language?: string;
						_markdownCellCount?: number;
						_outputCount?: number;
						_rawCellCount?: number;
						_totalPages?: number;
						[IMAGE_MARKER]?: boolean;
						[NOTEBOOK_MARKER]?: boolean;
						[PDF_MARKER]?: boolean;
						[SUMMARY_MARKER]?: boolean;
				  }
				| undefined;

			const textContent = result.content.find((c: { type: string }) => c.type === "text") as
				| { text: string }
				| undefined;
			const styleProcessLine = (line: string): string =>
				dimProcessOutputLine(line, (value) =>
					formatPresentationText(theme, "process_output", value)
				);
			const readVerb = formatToolVerb("read", true);
			const buildFooter = (summary: string): string => {
				const linkedSummary = linkifySummaryPath(summary);
				return (
					formatPresentationText(theme, "status_success", `${getIcon("success")} ${readVerb}`) +
					` ${formatPresentationText(theme, "action", linkedSummary)}`
				);
			};

			// Live preview during execution
			if (isPartial && details?._preview) {
				const previewText = textContent?.text ?? "";
				return renderLines(previewText.split("\n").map(styleProcessLine));
			}

			// Loading state (fallback)
			if (isPartial) {
				return renderLines([formatPresentationText(theme, "meta", "...")]);
			}

			// Skill file: collapsed by default, show full on expand
			if (details?._isSkill) {
				if (expanded && details?._fullText) {
					return renderLines(details._fullText.split("\n").map(styleProcessLine), { wrap: true });
				}
				return renderLines([]);
			}

			// Image file: show dimensions and format
			if (details?.[IMAGE_MARKER]) {
				const summary = textContent?.text ?? "image";
				return renderLines([buildFooter(summary)]);
			}

			// PDF file: compact summary collapsed, full text expanded
			if (details?.[PDF_MARKER]) {
				const summary = textContent?.text ?? "PDF";
				const footer = buildFooter(summary);

				if (expanded && details?._fullText) {
					const lines: string[] = [];
					appendSection(lines, [formatSectionDivider(theme, "Output")]);
					appendSection(lines, details._fullText.split("\n").map(styleProcessLine));
					appendSection(lines, [footer], { blankBefore: true });
					return renderLines(lines, { wrap: true });
				}
				return renderLines([footer]);
			}

			// Notebook file: compact summary collapsed, full text expanded
			if (details?.[NOTEBOOK_MARKER]) {
				const summary = textContent?.text ?? "Notebook";
				const footer = buildFooter(summary);

				if (expanded && details?._fullText) {
					const lines: string[] = [];
					appendSection(lines, [formatSectionDivider(theme, "Output")]);
					appendSection(lines, details._fullText.split("\n").map(styleProcessLine));
					appendSection(lines, [footer], { blankBefore: true });
					return renderLines(lines, { wrap: true });
				}
				return renderLines([footer]);
			}

			// If not summarized, show raw content
			if (!details?.[SUMMARY_MARKER]) {
				const raw = textContent?.text ?? "";
				return renderLines(raw.split("\n").map(styleProcessLine));
			}

			const summary = textContent?.text ?? "file";
			const footer = buildFooter(summary);

			// Expanded: full content with wrapping, then summary footer at bottom
			if (expanded && details?._fullText) {
				const lines: string[] = [];
				appendSection(lines, [formatSectionDivider(theme, "Output")]);
				appendSection(lines, details._fullText.split("\n").map(styleProcessLine));
				appendSection(lines, [footer], { blankBefore: true });
				return renderLines(lines, { wrap: true });
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
			// Restore full text for summarized text files, PDFs, and notebook results.
			const isSummarized = details?.[SUMMARY_MARKER] && details._fullText;
			const isPdfResult = details?.[PDF_MARKER] && details._fullText;
			const isNotebookResult = details?.[NOTEBOOK_MARKER] && details._fullText;
			if (!(isSummarized || isPdfResult || isNotebookResult)) continue;

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
