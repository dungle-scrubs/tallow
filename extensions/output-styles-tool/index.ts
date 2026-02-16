/**
 * Output Styles — switchable agent personality modes.
 *
 * Drop markdown files with frontmatter in:
 *   ~/.tallow/output-styles/   (global)
 *   .tallow/output-styles/           (project)
 *
 * Select with `/output-style` or `/output-style <name>`.
 *
 * Frontmatter options:
 *   name                   - Display name (default: filename)
 *   description            - Shown in selector
 *   keep-tool-instructions - Append instead of prepend (default: false)
 *   reminder               - Re-inject style every N turns (default: false)
 *   reminder-interval      - Turns between reminders (default: 5)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { atomicWriteFileSync } from "../_shared/atomic-write.js";
import {
	buildReminderContent,
	buildStyledPrompt,
	type OutputStyle,
	parseStyleFile,
	shouldRemind,
} from "./utils.js";

// ── Discovery ───────────────────────────────────────

/** Standard locations for output style files */
const USER_STYLES_DIR = path.join(
	process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".tallow"),
	"output-styles"
);
const PROJECT_STYLES_DIR = path.join(process.cwd(), ".tallow", "output-styles");

/**
 * Discover all available output styles from user and project directories.
 * Project styles override user styles with the same ID.
 * @returns Map of style ID → OutputStyle
 */
function discoverStyles(): Map<string, OutputStyle> {
	const styles = new Map<string, OutputStyle>();

	for (const [dir, scope] of [
		[USER_STYLES_DIR, "user"],
		[PROJECT_STYLES_DIR, "project"],
	] as const) {
		if (!fs.existsSync(dir)) continue;

		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;

			const filePath = path.join(dir, file);
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const style = parseStyleFile(content, filePath, scope);
				styles.set(style.id, style);
			} catch {
				// Skip unreadable files
			}
		}
	}

	return styles;
}

// ── State File ──────────────────────────────────────

const STATE_FILE = path.join(USER_STYLES_DIR, ".active");

/**
 * Read the persisted active style ID.
 * @returns Style ID string, or null if none set
 */
function readActiveStyleId(): string | null {
	try {
		if (fs.existsSync(STATE_FILE)) {
			return fs.readFileSync(STATE_FILE, "utf-8").trim() || null;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Persist the active style ID (or clear it).
 * @param id - Style ID to persist, or null to clear
 */
function writeActiveStyleId(id: string | null): void {
	try {
		fs.mkdirSync(USER_STYLES_DIR, { recursive: true });
		if (id) {
			atomicWriteFileSync(STATE_FILE, id);
		} else if (fs.existsSync(STATE_FILE)) {
			fs.unlinkSync(STATE_FILE);
		}
	} catch {
		/* ignore */
	}
}

// ── Extension ───────────────────────────────────────

const CUSTOM_TYPE = "output-style-selection";

export default function outputStyles(pi: ExtensionAPI): void {
	let activeStyle: OutputStyle | null = null;
	let turnCount = 0;

	/**
	 * Load or reload the active style from persisted state.
	 */
	function loadActiveStyle(): void {
		const id = readActiveStyleId();
		if (!id) {
			activeStyle = null;
			return;
		}
		const styles = discoverStyles();
		activeStyle = styles.get(id) ?? null;
		if (!activeStyle) writeActiveStyleId(null);
	}

	/**
	 * Update the status bar indicator.
	 */
	function updateStatus(ctx: {
		ui: { setStatus: (id: string, text: string | undefined) => void };
	}): void {
		if (activeStyle) {
			ctx.ui.setStatus("output-style", `📝 ${activeStyle.name}`);
		} else {
			ctx.ui.setStatus("output-style", undefined);
		}
	}

	// ── Session restore ─────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Check for session-level override first
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as { styleId: string | null } | undefined;
				if (data?.styleId) {
					const styles = discoverStyles();
					activeStyle = styles.get(data.styleId) ?? null;
				} else {
					activeStyle = null;
				}
			}
		}

		// Fall back to persisted state if no session override
		if (!activeStyle) loadActiveStyle();
		updateStatus(ctx);
	});

	// ── System prompt modification ──────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!activeStyle) return;

		const systemPrompt = buildStyledPrompt(event.systemPrompt, activeStyle);

		const result: {
			systemPrompt: string;
			message?: { customType: string; content: string; display: boolean };
		} = { systemPrompt };

		if (shouldRemind(activeStyle, turnCount)) {
			result.message = {
				customType: "output-style-reminder",
				content: buildReminderContent(activeStyle),
				display: false,
			};
		}

		turnCount++;
		return result;
	});

	// ── Command ─────────────────────────────────────

	pi.registerCommand("output-style", {
		description: "Switch output style (agent personality)",
		getArgumentCompletions: (prefix: string) => {
			const styles = discoverStyles();
			const items = [
				{ value: "off", label: "off", description: "Disable output style" },
				...Array.from(styles.values()).map((s) => ({
					value: s.id,
					label: s.id,
					description: s.description || s.name,
				})),
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const styles = discoverStyles();

			// Direct selection: /output-style <name> or /output-style off
			if (args) {
				const trimmed = args.trim();
				if (trimmed === "off" || trimmed === "none" || trimmed === "default") {
					activeStyle = null;
					turnCount = 0;
					writeActiveStyleId(null);
					pi.appendEntry(CUSTOM_TYPE, { styleId: null });
					updateStatus(ctx);
					ctx.ui.notify("Output style disabled", "info");
					return;
				}

				const match = styles.get(trimmed);
				if (match) {
					activeStyle = match;
					turnCount = 0;
					writeActiveStyleId(match.id);
					pi.appendEntry(CUSTOM_TYPE, { styleId: match.id });
					updateStatus(ctx);
					ctx.ui.notify(`Output style: ${match.name}`, "info");
					return;
				}

				ctx.ui.notify(`Unknown style: "${trimmed}"`, "error");
				return;
			}

			// Interactive selector
			if (styles.size === 0) {
				ctx.ui.notify(
					`No styles found. Add .md files to:\n  ${USER_STYLES_DIR}\n  ${PROJECT_STYLES_DIR}`,
					"warning"
				);
				return;
			}

			const options = [
				"None (default)",
				...Array.from(styles.values()).map((s) => {
					const badge = s.scope === "project" ? " [project]" : "";
					const desc = s.description ? ` — ${s.description}` : "";
					return `${s.name}${badge}${desc}`;
				}),
			];

			const choice = await ctx.ui.select("Output Style", options);
			if (choice === undefined) return;

			if (choice === "None (default)") {
				activeStyle = null;
				turnCount = 0;
				writeActiveStyleId(null);
				pi.appendEntry(CUSTOM_TYPE, { styleId: null });
				updateStatus(ctx);
				ctx.ui.notify("Output style disabled", "info");
				return;
			}

			const selected = Array.from(styles.values()).find((s) => choice.startsWith(s.name));
			if (selected) {
				activeStyle = selected;
				turnCount = 0;
				writeActiveStyleId(selected.id);
				pi.appendEntry(CUSTOM_TYPE, { styleId: selected.id });
				updateStatus(ctx);
				ctx.ui.notify(`Output style: ${selected.name}`, "info");
			}
		},
	});

	// ── Render reminders invisibly ──────────────────

	pi.registerMessageRenderer("output-style-reminder", (_message, _options, theme) => {
		return {
			render(_width: number): string[] {
				return [theme.fg("dim", "📝 style reminder injected")];
			},
			invalidate() {},
		};
	});
}
