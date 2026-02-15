/**
 * Health Extension — `/health` command
 *
 * Renders a diagnostic overview of the current session using a tree-style
 * layout (└) inline in the conversation. Covers session, model, context,
 * tools, commands, extensions, and environment.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { BorderedBox, ROUNDED, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

/** Result of a single diagnostic check. */
interface DiagnosticCheck {
	readonly name: string;
	readonly status: "pass" | "warn" | "fail";
	readonly message: string;
	readonly suggestion?: string;
}

/** Serializable payload attached to the custom message. */
interface HealthDetails {
	readonly session: {
		readonly id: string;
		readonly file: string | undefined;
		readonly name: string | undefined;
		readonly cwd: string;
		readonly branchCount: number;
		readonly entryCount: number;
	};
	readonly model: {
		readonly provider: string;
		readonly id: string;
		readonly name: string;
		readonly contextWindow: number;
		readonly maxTokens: number;
		readonly reasoning: boolean;
		readonly thinkingLevel: string;
		readonly input: readonly string[];
	};
	readonly context: {
		readonly tokens: number | null;
		readonly contextWindow: number;
		readonly percent: number | null;
		readonly status: "OK" | "Warning" | "Critical";
	};
	readonly tools: {
		readonly activeCount: number;
		readonly totalCount: number;
		readonly activeNames: readonly string[];
	};
	readonly commands: {
		readonly total: number;
		readonly bySource: Record<string, number>;
	};
	readonly extensions: {
		readonly themeOrUnknown: string;
	};
	readonly environment: {
		readonly tallowVersion: string;
		readonly piVersion: string;
		readonly nodeVersion: string;
		readonly platform: string;
		readonly tallowHome: string;
		readonly packageDir: string;
	};
	readonly diagnostics: readonly DiagnosticCheck[];
}

// ── Version readers ──────────────────────────────────────────────────────────

/**
 * Reads the version field from a package.json file.
 * @param pkgPath - Absolute path to the package.json
 * @returns Version string or "unknown" on failure
 */
function readPackageVersion(pkgPath: string): string {
	try {
		const raw = readFileSync(pkgPath, "utf-8");
		const pkg = JSON.parse(raw) as { version?: string };
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

// ── Context status ───────────────────────────────────────────────────────────

/**
 * Derives a health status label from context usage percentage.
 * @param percent - Usage percentage (0–100)
 * @returns Status label
 */
function deriveContextStatus(percent: number | null): "OK" | "Warning" | "Critical" {
	if (percent === null) return "OK";
	if (percent > 80) return "Critical";
	if (percent > 50) return "Warning";
	return "OK";
}

// ── Token formatting ─────────────────────────────────────────────────────────

/**
 * Formats a token count with k/M suffixes.
 * @param count - Token count
 * @returns Human-readable token string
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

// ── Renderer ─────────────────────────────────────────────────────────────────

/**
 * Maps a context status to the appropriate theme color slot.
 * @param status - Context health status
 * @returns Theme color name
 */
function statusColor(status: "OK" | "Warning" | "Critical"): "success" | "warning" | "error" {
	if (status === "OK") return "success";
	if (status === "Warning") return "warning";
	return "error";
}

/** A single section block: header + leaf rows. */
interface Section {
	readonly title: string;
	readonly rows: readonly {
		readonly label: string;
		readonly value: string;
		readonly last: boolean;
	}[];
}

/**
 * Builds section data from HealthDetails (no styling yet — pure data).
 * @param d - Pre-computed health details
 * @returns Array of sections with their rows
 */
function buildSections(d: HealthDetails): Section[] {
	const sessionRows = [
		{ label: "ID", value: d.session.id, last: false },
		{ label: "File", value: d.session.file ?? "none", last: false },
		...(d.session.name ? [{ label: "Name", value: d.session.name, last: false }] : []),
		{ label: "CWD", value: d.session.cwd, last: false },
		{ label: "Branches", value: String(d.session.branchCount), last: false },
		{ label: "Entries", value: String(d.session.entryCount), last: true },
	];

	const modelRows = [
		{ label: "Provider", value: d.model.provider, last: false },
		{
			label: "ID",
			value: d.model.name !== d.model.id ? `${d.model.id} (${d.model.name})` : d.model.id,
			last: false,
		},
		{
			label: "Context",
			value: `${formatTokens(d.model.contextWindow)} window, ${formatTokens(d.model.maxTokens)} max output`,
			last: false,
		},
		{ label: "Reasoning", value: d.model.reasoning ? "yes" : "no", last: false },
		{ label: "Thinking", value: d.model.thinkingLevel, last: false },
		{ label: "Input", value: d.model.input.join(", "), last: true },
	];

	const tokensStr = d.context.tokens !== null ? formatTokens(d.context.tokens) : "?";
	const percentStr = d.context.percent !== null ? `${d.context.percent.toFixed(0)}%` : "?";
	const usageStr = `${tokensStr}/${formatTokens(d.context.contextWindow)} tokens (${percentStr})`;
	const contextRows = [
		{ label: "Usage", value: usageStr, last: false },
		{ label: "Status", value: d.context.status, last: true },
	];

	const toolsRows = [
		{ label: "Active", value: `${d.tools.activeCount}/${d.tools.totalCount}`, last: false },
		{ label: "List", value: d.tools.activeNames.join(", "), last: true },
	];

	const sourceParts = Object.entries(d.commands.bySource)
		.map(([src, count]) => `${count} ${src}`)
		.join(", ");
	const commandsRows = [
		{ label: "Registered", value: `${d.commands.total} (${sourceParts})`, last: true },
	];

	const extensionsRows = [{ label: "Theme", value: d.extensions.themeOrUnknown, last: true }];

	const environmentRows = [
		{ label: "Tallow", value: d.environment.tallowVersion, last: false },
		{ label: "Pi", value: d.environment.piVersion, last: false },
		{ label: "Node", value: d.environment.nodeVersion, last: false },
		{ label: "Platform", value: d.environment.platform, last: false },
		{ label: "Home", value: d.environment.tallowHome, last: false },
		{ label: "Package", value: d.environment.packageDir, last: true },
	];

	const diagnosticRows = d.diagnostics.map((check, i) => {
		const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
		const value = check.suggestion ? `${check.message} → ${check.suggestion}` : check.message;
		return { label: `${icon} ${check.name}`, value, last: i === d.diagnostics.length - 1 };
	});

	return [
		{ title: "Session", rows: sessionRows },
		{ title: "Model", rows: modelRows },
		{ title: "Context", rows: contextRows },
		{ title: "Tools", rows: toolsRows },
		{ title: "Commands", rows: commandsRows },
		{ title: "Extensions", rows: extensionsRows },
		{ title: "Environment", rows: environmentRows },
		...(diagnosticRows.length > 0 ? [{ title: "Diagnostics", rows: diagnosticRows }] : []),
	];
}

/** Prefix width: "  └ " = 4 visible chars. */
const LEAF_PREFIX_WIDTH = 4;

/**
 * Renders a single section block into styled lines, truncated to fit colWidth.
 * @param section - Section data
 * @param colWidth - Available column width in terminal chars
 * @param theme - Active theme
 * @param d - Health details for conditional styling
 * @returns Array of styled lines for this section
 */
function renderSection(
	section: Section,
	colWidth: number,
	theme: Theme,
	d: HealthDetails
): string[] {
	const lines: string[] = [];
	lines.push(`  ${theme.fg("accent", theme.bold(section.title))}`);

	for (const row of section.rows) {
		const glyph = row.last ? "└" : "├";
		const labelStr = `${row.label}:`;
		// Visible: "  ├ Label: " = prefix(4) + label + ": " + space
		const labelWidth = visibleWidth(labelStr);
		const maxValueWidth = colWidth - LEAF_PREFIX_WIDTH - labelWidth - 1; // -1 for space after ":"

		let styledValue: string;

		// Apply semantic styling to specific values
		if (section.title === "Context" && row.label === "Status") {
			const status = row.value as "OK" | "Warning" | "Critical";
			styledValue = theme.fg(statusColor(status), row.value);
		} else if (section.title === "Model" && row.label === "Reasoning") {
			styledValue = row.value === "yes" ? theme.fg("success", "yes") : theme.fg("dim", "no");
		} else if (section.title === "Model" && row.label === "ID" && d.model.name !== d.model.id) {
			// Style the parenthetical name as dim
			const truncated = truncateToWidth(row.value, Math.max(maxValueWidth, 10), "…");
			const parenStart = truncated.indexOf("(");
			if (parenStart !== -1) {
				styledValue = truncated.slice(0, parenStart) + theme.fg("dim", truncated.slice(parenStart));
			} else {
				styledValue = truncated;
			}
		} else if (section.title === "Session" && row.label === "File" && row.value === "none") {
			styledValue = theme.fg("dim", "none");
		} else if (section.title === "Tools" && row.label === "List") {
			styledValue = theme.fg("dim", truncateToWidth(row.value, Math.max(maxValueWidth, 10), "…"));
		} else if (section.title === "Commands" && row.label === "Registered") {
			// Style the parenthetical source breakdown as dim
			const truncated = truncateToWidth(row.value, Math.max(maxValueWidth, 10), "…");
			const parenStart = truncated.indexOf("(");
			if (parenStart !== -1) {
				styledValue = truncated.slice(0, parenStart) + theme.fg("dim", truncated.slice(parenStart));
			} else {
				styledValue = truncated;
			}
		} else if (section.title === "Diagnostics") {
			// Color diagnostic labels by their status icon
			const truncated = truncateToWidth(row.value, Math.max(maxValueWidth, 10), "…");
			if (row.label.startsWith("✓")) {
				styledValue = theme.fg("success", truncated);
			} else if (row.label.startsWith("⚠")) {
				styledValue = theme.fg("warning", truncated);
			} else {
				styledValue = theme.fg("error", truncated);
			}
		} else {
			styledValue = truncateToWidth(row.value, Math.max(maxValueWidth, 10), "…");
		}

		let styledLabel = theme.fg("muted", labelStr);
		// Color diagnostic labels by status
		if (section.title === "Diagnostics") {
			if (row.label.startsWith("✓")) styledLabel = theme.fg("success", labelStr);
			else if (row.label.startsWith("⚠")) styledLabel = theme.fg("warning", labelStr);
			else styledLabel = theme.fg("error", labelStr);
		}

		lines.push(`  ${theme.fg("dim", glyph)} ${styledLabel} ${styledValue}`);
	}

	return lines;
}

/**
 * Determines column count from available width.
 * @param width - Terminal width in columns
 * @returns 1, 2, or 3
 */
function columnCount(width: number): number {
	if (width >= 160) return 3;
	if (width >= 80) return 2;
	return 1;
}

/**
 * Merges section line arrays side-by-side into composite lines.
 * Each column is padded to colWidth. Gap between columns = 2 spaces.
 * @param columns - Array of line arrays, one per column
 * @param colWidth - Width of each column
 * @returns Merged lines
 */
function mergeColumns(columns: string[][], colWidth: number): string[] {
	const maxHeight = Math.max(...columns.map((c) => c.length));
	const gap = "  ";
	const merged: string[] = [];

	for (let row = 0; row < maxHeight; row++) {
		let line = "";
		for (let col = 0; col < columns.length; col++) {
			const cell = columns[col]?.[row] ?? "";
			if (col < columns.length - 1) {
				// Pad interior columns to colWidth + gap
				const cellWidth = visibleWidth(cell);
				const padding = Math.max(0, colWidth - cellWidth);
				line += cell + " ".repeat(padding) + gap;
			} else {
				// Last column: no padding (avoids exceeding terminal width)
				line += cell;
			}
		}
		merged.push(line);
	}

	return merged;
}

/**
 * Builds the responsive diagnostic output from HealthDetails.
 * Lays out sections in 1–3 columns depending on terminal width.
 *
 * @param d - Pre-computed health details
 * @param theme - Active theme for styling
 * @param width - Terminal width in columns
 * @returns Array of styled terminal lines
 */
function renderHealth(d: HealthDetails, theme: Theme, width: number): string[] {
	const sections = buildSections(d);
	const cols = columnCount(width);

	if (cols === 1) {
		// Single column: render sequentially with blank line between sections
		const lines: string[] = [];
		const colWidth = width - 1; // leave 1 char margin
		for (const section of sections) {
			lines.push("");
			lines.push(...renderSection(section, colWidth, theme, d));
		}
		lines.push("");
		return lines;
	}

	// Multi-column: distribute sections across columns, then merge groups
	const gap = 2;
	const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
	const lines: string[] = [];

	// Render each section into its own line array
	const rendered = sections.map((s) => renderSection(s, colWidth, theme, d));

	// Distribute into column groups — fill columns greedily by line count
	// to keep roughly balanced heights
	const groups: string[][][] = []; // groups of column-arrays to merge
	let currentGroup: string[][] = [];

	for (const sectionLines of rendered) {
		currentGroup.push(sectionLines);
		if (currentGroup.length === cols) {
			groups.push(currentGroup);
			currentGroup = [];
		}
	}
	if (currentGroup.length > 0) {
		groups.push(currentGroup);
	}

	// Merge each group into composite lines
	for (const group of groups) {
		lines.push("");
		lines.push(...mergeColumns(group, colWidth));
	}

	lines.push("");
	return lines;
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

/** Input data for running diagnostic checks. */
export interface DiagnosticInput {
	readonly model: HealthDetails["model"];
	readonly context: HealthDetails["context"];
	readonly tools: HealthDetails["tools"];
	readonly environment: HealthDetails["environment"];
	readonly tallowHome: string;
	readonly cwd: string;
}

/**
 * Run validation checks and return actionable diagnostics.
 *
 * @param input - Pre-collected health data
 * @returns Array of diagnostic check results
 */
export function runDiagnostics(input: DiagnosticInput): DiagnosticCheck[] {
	const checks: DiagnosticCheck[] = [];

	// 1. Model configured
	if (input.model.provider === "unknown" || input.model.id === "unknown") {
		checks.push({
			name: "Model",
			status: "fail",
			message: "No model configured",
			suggestion: "Run `tallow install` or set --model provider/model-id",
		});
	} else {
		checks.push({
			name: "Model",
			status: "pass",
			message: `${input.model.provider}/${input.model.id}`,
		});
	}

	// 2. Auth configured for provider
	const authPath = join(input.tallowHome, "auth.json");
	if (input.model.provider !== "unknown") {
		if (existsSync(authPath)) {
			try {
				const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
				if (auth[input.model.provider]) {
					checks.push({
						name: "Auth",
						status: "pass",
						message: `${input.model.provider} credentials found`,
					});
				} else {
					checks.push({
						name: "Auth",
						status: "warn",
						message: `No credentials for ${input.model.provider}`,
						suggestion: "Run `tallow install` or set TALLOW_API_KEY",
					});
				}
			} catch {
				checks.push({
					name: "Auth",
					status: "warn",
					message: "auth.json is corrupt",
					suggestion: "Delete and re-run `tallow install`",
				});
			}
		} else {
			checks.push({
				name: "Auth",
				status: "warn",
				message: "No auth.json found",
				suggestion: "Run `tallow install` or set TALLOW_API_KEY env var",
			});
		}
	}

	// 3. Context usage
	if (input.context.status === "Critical") {
		checks.push({
			name: "Context",
			status: "fail",
			message: `${input.context.percent?.toFixed(0)}% used — model may lose earlier context`,
			suggestion: "Start a new session or compact conversation",
		});
	} else if (input.context.status === "Warning") {
		checks.push({
			name: "Context",
			status: "warn",
			message: `${input.context.percent?.toFixed(0)}% used`,
			suggestion: "Consider starting a new session soon",
		});
	} else {
		checks.push({ name: "Context", status: "pass", message: "Within limits" });
	}

	// 4. Tools available
	if (input.tools.activeCount === 0) {
		checks.push({
			name: "Tools",
			status: "fail",
			message: "No tools active",
			suggestion: "Check extension loading and /plan-mode status",
		});
	} else {
		checks.push({ name: "Tools", status: "pass", message: `${input.tools.activeCount} active` });
	}

	// 5. Node version (require >= 18)
	const nodeVer = Number.parseInt(input.environment.nodeVersion.replace("v", ""), 10);
	if (nodeVer < 18) {
		checks.push({
			name: "Node",
			status: "fail",
			message: `Node ${input.environment.nodeVersion} is too old`,
			suggestion: "Upgrade to Node 18+ (LTS recommended)",
		});
	} else {
		checks.push({ name: "Node", status: "pass", message: input.environment.nodeVersion });
	}

	// 6. Settings file exists
	const settingsPath = join(input.tallowHome, "settings.json");
	if (existsSync(settingsPath)) {
		try {
			JSON.parse(readFileSync(settingsPath, "utf-8"));
			checks.push({ name: "Settings", status: "pass", message: "Valid JSON" });
		} catch {
			checks.push({
				name: "Settings",
				status: "fail",
				message: "settings.json contains invalid JSON",
				suggestion: "Fix JSON syntax or delete to reset",
			});
		}
	} else {
		checks.push({ name: "Settings", status: "pass", message: "Using defaults" });
	}

	// 7. Project context files
	const hasAgents = existsSync(join(input.cwd, "AGENTS.md"));
	const hasClaude = existsSync(join(input.cwd, "CLAUDE.md"));
	if (hasAgents || hasClaude) {
		const found = [hasAgents && "AGENTS.md", hasClaude && "CLAUDE.md"].filter(Boolean).join(", ");
		checks.push({ name: "Project context", status: "pass", message: found });
	} else {
		checks.push({
			name: "Project context",
			status: "warn",
			message: "No AGENTS.md or CLAUDE.md in cwd",
			suggestion: "Create one to give the agent project-specific instructions",
		});
	}

	return checks;
}

// ── Extension entry point ────────────────────────────────────────────────────

/**
 * Registers the /health command and its inline message renderer.
 * @param pi - Extension API
 */
export default function healthExtension(pi: ExtensionAPI): void {
	// Resolve versions once at load time
	const packageDir = process.env.TALLOW_PACKAGE_DIR ?? process.env.PI_PACKAGE_DIR ?? "";
	const tallowVersion = readPackageVersion(join(packageDir, "package.json"));
	const piVersion = readPackageVersion(
		join(packageDir, "node_modules", "@mariozechner", "pi-coding-agent", "package.json")
	);
	const tallowHome = process.env.TALLOW_CODING_AGENT_DIR ?? join(homedir(), ".tallow");

	// ── Message renderer ─────────────────────────────────────────────────

	pi.registerMessageRenderer<HealthDetails>("health", (message, _options, theme) => {
		const details = message.details;
		if (!details) {
			return {
				render(_width: number): string[] {
					return ["No health data available."];
				},
				invalidate() {},
			};
		}

		return {
			/**
			 * Renders the health diagnostic tree inside a rounded border.
			 * @param width - Available terminal width
			 * @returns Array of styled lines
			 */
			render(width: number): string[] {
				const innerWidth = width - 4; // 2 borders + 2 padding
				const contentLines = renderHealth(details, theme, innerWidth);
				const box = new BorderedBox(contentLines, {
					borderStyle: ROUNDED,
					title: "Health",
					borderColorFn: (s) => theme.fg("muted", s),
					titleColorFn: (s) => theme.fg("accent", s),
				});
				return box.render(width);
			},
			invalidate() {},
		};
	});

	// ── /health command ──────────────────────────────────────────────────

	const healthHandler = async (_args: string, ctx: ExtensionContext) => {
		// ── Session ──────────────────────────────────────────────────
		const sm = ctx.sessionManager;
		const sessionData = {
			id: sm.getSessionId(),
			file: sm.getSessionFile(),
			name: pi.getSessionName(),
			cwd: ctx.cwd,
			branchCount: sm.getTree().length,
			entryCount: sm.getEntries().length,
		};

		// ── Model ────────────────────────────────────────────────────
		const model = ctx.model;
		const modelData = {
			provider: model?.provider ?? "unknown",
			id: model?.id ?? "unknown",
			name: model?.name ?? "unknown",
			contextWindow: model?.contextWindow ?? 0,
			maxTokens: model?.maxTokens ?? 0,
			reasoning: model?.reasoning ?? false,
			thinkingLevel: pi.getThinkingLevel(),
			input: model?.input ?? ["text"],
		};

		// ── Context ──────────────────────────────────────────────────
		const usage: ContextUsage | undefined = ctx.getContextUsage();
		const contextData = usage
			? {
					tokens: usage.tokens,
					contextWindow: usage.contextWindow,
					percent: usage.percent,
					status: deriveContextStatus(usage.percent),
				}
			: {
					tokens: 0,
					contextWindow: model?.contextWindow ?? 0,
					percent: 0,
					status: "OK" as const,
				};

		// ── Tools ────────────────────────────────────────────────────
		const activeTools = pi.getActiveTools();
		const allTools = pi.getAllTools();
		const toolsData = {
			activeCount: activeTools.length,
			totalCount: allTools.length,
			activeNames: activeTools,
		};

		// ── Commands ─────────────────────────────────────────────────
		const commands = pi.getCommands();
		const bySource: Record<string, number> = {};
		for (const cmd of commands) {
			const src = cmd.source ?? "unknown";
			bySource[src] = (bySource[src] ?? 0) + 1;
		}
		const commandsData = { total: commands.length, bySource };

		// ── Extensions ───────────────────────────────────────────────
		const extensionsData = {
			themeOrUnknown: ctx.ui.theme?.name ?? "unknown",
		};

		// ── Environment ──────────────────────────────────────────────
		const environmentData = {
			tallowVersion,
			piVersion,
			nodeVersion: process.version,
			platform: `${process.platform}/${process.arch}`,
			tallowHome,
			packageDir,
		};

		// ── Diagnostics ──────────────────────────────────────────────
		const diagnostics = runDiagnostics({
			model: modelData,
			context: contextData,
			tools: toolsData,
			environment: environmentData,
			tallowHome,
			cwd: ctx.cwd,
		});

		const details: HealthDetails = {
			session: sessionData,
			model: modelData,
			context: contextData,
			tools: toolsData,
			commands: commandsData,
			extensions: extensionsData,
			environment: environmentData,
			diagnostics,
		};

		pi.sendMessage({
			customType: "health",
			content: "Session health diagnostics",
			display: true,
			details,
		});
	};

	const description = "Show session diagnostics (model, context, tools, environment)";
	pi.registerCommand("health", { description, handler: healthHandler });
	pi.registerCommand("doctor", { description, handler: healthHandler });
}
