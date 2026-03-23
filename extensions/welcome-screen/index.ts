/**
 * Welcome Screen Extension
 *
 * Replaces the default pi framework startup header with a branded ASCII art
 * welcome screen showing the tallow logo, version, and update availability.
 *
 * The ASCII art is the tallow "T_" mark — a blocky amber T with a cursor,
 * evoking the retro CRT terminal aesthetic of the logo.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import { TALLOW_VERSION } from "../../src/config.js";

/** Timeout for npm registry fetch (ms). */
const FETCH_TIMEOUT = 4_000;

/** Registry URL for the tallow package. */
const REGISTRY_URL = "https://registry.npmjs.org/@dungle-scrubs/tallow/latest";

// ─── ASCII Art ───────────────────────────────────────────────────────────────

/**
 * The tallow "T_" mark — a blocky T with a cursor block.
 * Proportions mirror the logo: wide top bar, centered thick stem, cursor lower-right.
 */
const LOGO_LINES = [" ▐████████████▌ ", "      ████      ", "      ████  ▐█▌ "];

// ─── Version Check ───────────────────────────────────────────────────────────

/**
 * Fetch the latest published version from the npm registry.
 *
 * @returns Latest version string, or null on failure
 */
async function fetchLatestVersion(): Promise<string | null> {
	if (process.env.PI_SKIP_VERSION_CHECK === "1" || process.env.PI_OFFLINE) {
		return null;
	}
	try {
		const res = await fetch(REGISTRY_URL, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: string };
		return data.version ?? null;
	} catch {
		return null;
	}
}

/**
 * Compare two semver strings. Returns true if `latest` is newer than `current`.
 *
 * @param current - Currently installed version
 * @param latest - Latest available version
 * @returns True if latest is a newer version
 */
function isNewerVersion(current: string, latest: string): boolean {
	const parse = (v: string): number[] => v.split(".").map(Number);
	const c = parse(current);
	const l = parse(latest);
	for (let i = 0; i < 3; i++) {
		if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
		if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
	}
	return false;
}

// ─── Colors ──────────────────────────────────────────────────────────────────

/** Amber/gold (matches the logo glow). */
const AMBER = "\x1b[38;2;255;191;0m";
/** Dim amber for version text. */
const DIM_AMBER = "\x1b[38;2;180;130;30m";
/** Green for update notification. */
const GREEN = "\x1b[38;2;100;220;100m";
/** Reset all styles. */
const RESET = "\x1b[0m";

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Center a styled string within a given terminal width.
 *
 * @param line - Styled line (may contain ANSI escapes)
 * @param width - Terminal width
 * @returns Left-padded line
 */
function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	const left = Math.max(0, Math.floor((width - lineWidth) / 2));
	return " ".repeat(left) + line;
}

/**
 * Build the welcome screen lines.
 *
 * @param width - Terminal width for centering
 * @param updateVersion - Newer version available, or null
 * @returns Array of styled terminal lines
 */
function buildWelcomeLines(width: number, updateVersion: string | null): string[] {
	const lines: string[] = [];

	// Logo with amber coloring
	for (const logoLine of LOGO_LINES) {
		lines.push(centerLine(`${AMBER}${logoLine}${RESET}`, width));
	}

	// Version line — dim amber, centered below logo
	lines.push(centerLine(`${DIM_AMBER}tallow v${TALLOW_VERSION}${RESET}`, width));

	// Update notification
	if (updateVersion) {
		lines.push(centerLine(`${GREEN}update available: v${updateVersion}${RESET}`, width));
	}

	return lines;
}

// ─── Extension Entry ─────────────────────────────────────────────────────────

/**
 * Welcome screen extension.
 * Replaces the default header with an ASCII art logo on session_start.
 *
 * @param pi - Extension API
 */
export default function welcomeScreenExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		// Skip for resumed/continued sessions — only show on fresh instances.
		// Filter to message entries only — metadata entries like model_change and
		// thinking_level_change are injected during session setup and exist even
		// on a brand-new session. The role lives on entry.message, not the entry itself.
		const hasConversation = ctx.sessionManager.getEntries().some((e) => {
			const msg = (e as unknown as Record<string, unknown>).message as
				| { role?: string }
				| undefined;
			return msg?.role === "user" || msg?.role === "assistant";
		});
		if (hasConversation) return;

		let updateVersion: string | null = null;
		let tuiRef: TUI | null = null;

		// Set the header immediately with current version (no update info yet)
		ctx.ui.setHeader((tui, _theme) => {
			tuiRef = tui;

			return {
				render(width: number): string[] {
					return buildWelcomeLines(width, updateVersion);
				},
				invalidate(): void {
					// No cached state to clear
				},
			};
		});

		// Clear the changelog "What's New" children from the header container.
		// setHeader only replaces the builtInHeader text component — the changelog
		// section (DynamicBorder, "What's New" heading, Markdown body) lives as
		// separate children in headerContainer and persists unless removed.
		// headerContainer is the first child of the root TUI component.
		queueMicrotask(() => {
			if (!tuiRef) return;
			const tuiChildren = (tuiRef as unknown as Record<string, unknown>).children as
				| Array<Record<string, unknown>>
				| undefined;
			// headerContainer is the first child of the TUI root
			const headerContainer = tuiChildren?.[0]?.children as { length: number } | undefined;
			if (headerContainer && headerContainer.length > 2) {
				// Keep [0]=Spacer and [1]=custom header, drop the rest (bottom spacer + changelog)
				headerContainer.length = 2;
				tuiRef.requestRender();
			}
		});

		// Fire-and-forget version check — re-renders header when resolved
		fetchLatestVersion().then((latest) => {
			if (latest && isNewerVersion(TALLOW_VERSION, latest)) {
				updateVersion = latest;
				tuiRef?.requestRender();
			}
		});
	});
}
