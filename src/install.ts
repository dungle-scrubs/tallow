#!/usr/bin/env node

/**
 * Tallow interactive installer.
 *
 * Usage:
 *   npx tallow install        (after global install)
 *   node dist/install.js      (from source)
 *
 * Flags:
 *   --yes, -y   Non-interactive: rebuild + reinstall, keep all settings.
 *
 * Walks the user through selecting which bundled components to install,
 * builds the project, links the binary globally, and sets up ~/.tallow/.
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";

// ─── Constants ───────────────────────────────────────────────────────────────

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = join(__filename_, "..");
const PACKAGE_DIR = resolve(__dirname_, "..");
const TALLOW_HOME = join(homedir(), ".tallow");
const SETTINGS_PATH = join(TALLOW_HOME, "settings.json");
const TEMPLATES_DIR = join(PACKAGE_DIR, "templates");

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtensionInfo {
	readonly description: string;
	readonly name: string;
}

interface ThemeInfo {
	readonly filename: string;
	readonly name: string;
}

interface InstallChoices {
	readonly defaultTheme: string;
	readonly extensions: readonly string[];
	readonly themes: readonly string[];
}

// ─── Discovery ───────────────────────────────────────────────────────────────

function discoverExtensions(dir: string): readonly ExtensionInfo[] {
	if (!existsSync(dir)) return [];

	return readdirSync(dir)
		.filter((entry) => {
			if (entry.startsWith(".") || entry === "node_modules") return false;
			const full = join(dir, entry);
			return existsSync(join(full, "index.ts"));
		})
		.map((name) => {
			const indexPath = join(dir, name, "index.ts");
			const content = readFileSync(indexPath, "utf-8");
			const descMatch = content.match(/description:\s*["'`]([^"'`]+)["'`]/);
			return {
				description: descMatch?.[1] ?? "",
				name,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function discoverThemes(dir: string): readonly ThemeInfo[] {
	if (!existsSync(dir)) return [];

	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((filename) => ({
			filename,
			name: basename(filename, ".json"),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cancelled(): never {
	p.cancel("Installation cancelled.");
	process.exit(0);
}

function isCancel<T>(value: T | symbol): value is symbol {
	return p.isCancel(value);
}

function readSettings(): Record<string, unknown> {
	if (existsSync(SETTINGS_PATH)) {
		try {
			return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	return {};
}

function writeSettings(settings: Record<string, unknown>): void {
	writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Copy template files (agents, commands) to ~/.tallow/.
 * Skips files that already exist so user edits are preserved.
 *
 * @returns Count of files copied vs skipped
 */
function installTemplates(): { copied: number; skipped: number } {
	let copied = 0;
	let skipped = 0;

	for (const category of ["agents", "commands"] as const) {
		const srcDir = join(TEMPLATES_DIR, category);
		if (!existsSync(srcDir)) continue;

		const destDir = join(TALLOW_HOME, category);
		ensureDir(destDir);

		for (const file of readdirSync(srcDir)) {
			if (file.startsWith(".")) continue;
			const dest = join(destDir, file);
			if (existsSync(dest)) {
				skipped++;
			} else {
				copyFileSync(join(srcDir, file), dest);
				copied++;
			}
		}
	}

	return { copied, skipped };
}

// ─── Grouping extensions by category ─────────────────────────────────────────

interface ExtensionGroup {
	readonly extensions: readonly ExtensionInfo[];
	readonly label: string;
}

function groupExtensions(extensions: readonly ExtensionInfo[]): readonly ExtensionGroup[] {
	const coreTools = [
		"bash-tool-enhanced",
		"cd-tool",
		"edit-tool-enhanced",
		"read-tool-enhanced",
		"write-tool-enhanced",
		"web-fetch-tool",
	];

	const agentTools = ["agent-commands-tool", "subagent-tool", "teams-tool", "background-task-tool"];

	const devTools = [
		"lsp",
		"plan-mode-tool",
		"mcp-adapter-tool",
		"git-status",
		"context-files",
		"hooks",
	];

	const uiExtensions = [
		"ask-user-question-tool",
		"cheatsheet",
		"clear",
		"command-expansion",
		"command-prompt",
		"context-usage",
		"custom-footer",
		"health",
		"init",
		"output-styles-tool",
		"show-system-prompt",
		"tasks",
		"theme-selector",
		"tool-display",
	];

	const categorize = (names: readonly string[]): readonly ExtensionInfo[] =>
		names
			.map((n) => extensions.find((e) => e.name === n))
			.filter((e): e is ExtensionInfo => e !== undefined);

	const categorized = new Set([...coreTools, ...agentTools, ...devTools, ...uiExtensions]);
	const other = extensions.filter((e) => !categorized.has(e.name));

	return [
		{
			label: "Core Tools (bash, edit, read, write, cd, web-fetch)",
			extensions: categorize(coreTools),
		},
		{
			label: "Agent & Delegation (subagents, teams, background tasks)",
			extensions: categorize(agentTools),
		},
		{
			label: "Developer Tools (LSP, plan mode, MCP, git, hooks)",
			extensions: categorize(devTools),
		},
		{
			label: "UI & Experience (tasks, themes, commands, display)",
			extensions: categorize(uiExtensions),
		},
		...(other.length > 0 ? [{ label: "Other", extensions: other }] : []),
	];
}

// ─── Existing install detection ──────────────────────────────────────────────

interface ExistingInstall {
	readonly authConfigured: boolean;
	readonly customExtensions: readonly string[];
	readonly hasHooks: boolean;
	readonly hasSessions: boolean;
	readonly settings: Record<string, unknown>;
}

function detectExistingInstall(): ExistingInstall | undefined {
	if (!existsSync(TALLOW_HOME)) return undefined;

	const settings = readSettings();

	const customExtDir = join(TALLOW_HOME, "extensions");
	const customExtensions = existsSync(customExtDir)
		? readdirSync(customExtDir).filter(
				(e) => !e.startsWith(".") && existsSync(join(customExtDir, e, "index.ts"))
			)
		: [];

	const sessionsDir = join(TALLOW_HOME, "sessions");
	const hasSessions =
		existsSync(sessionsDir) &&
		readdirSync(sessionsDir).filter((f) => !f.startsWith(".")).length > 0;

	const authConfigured = existsSync(join(TALLOW_HOME, "auth.json"));
	const hasHooks =
		existsSync(join(TALLOW_HOME, "hooks")) || existsSync(join(TALLOW_HOME, "hooks.json"));

	return { authConfigured, customExtensions, hasHooks, hasSessions, settings };
}

function describeExisting(existing: ExistingInstall): string {
	const lines: string[] = [];

	const currentTheme = existing.settings.theme;
	if (currentTheme) lines.push(`Theme:              ${currentTheme}`);

	const disabled = existing.settings.disabledExtensions;
	if (Array.isArray(disabled) && disabled.length > 0) {
		lines.push(`Disabled extensions: ${disabled.length}`);
	}

	if (existing.customExtensions.length > 0) {
		lines.push(`Custom extensions:   ${existing.customExtensions.join(", ")}`);
	}

	if (existing.hasSessions) lines.push("Sessions:           ✓ (will be preserved)");
	if (existing.authConfigured) lines.push("Auth/API keys:      ✓ (will be preserved)");
	if (existing.hasHooks) lines.push("Hooks:              ✓ (will be preserved)");

	const packages = existing.settings.packages;
	if (Array.isArray(packages) && packages.length > 0) {
		lines.push(`Packages:           ${packages.join(", ")}`);
	}

	return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runNonInteractive(): Promise<void> {
	const existing = detectExistingInstall();
	if (!existing) {
		console.error(
			"No existing installation found at ~/.tallow/. Run without --upgrade for first-time setup."
		);
		process.exit(1);
	}

	console.log("🕯️  tallow install (non-interactive)");
	console.log("");

	const templates = installTemplates();
	if (templates.copied > 0) {
		console.log(`✓ Added ${templates.copied} new template files`);
	}

	console.log("");
	console.log("Done! All settings preserved. 🕯️");
}

async function main(): Promise<void> {
	// Non-interactive mode
	if (process.argv.includes("--yes") || process.argv.includes("-y")) {
		return runNonInteractive();
	}

	const extensionsDir = join(PACKAGE_DIR, "extensions");
	const themesDir = join(PACKAGE_DIR, "themes");

	const allExtensions = discoverExtensions(extensionsDir);
	const allThemes = discoverThemes(themesDir);

	p.intro("🕯️ tallow installer");

	// ── Detect existing install ──────────────────────────────────────────────

	const existing = detectExistingInstall();
	const isUpgrade = existing !== undefined;

	if (isUpgrade) {
		p.log.info("Existing installation detected at ~/.tallow/");
		p.note(describeExisting(existing), "Current config");

		const upgradeAction = await p.select({
			message: "What would you like to do?",
			options: [
				{
					label: "Upgrade in place",
					hint: "Rebuild & reinstall, keep all settings",
					value: "upgrade" as const,
				},
				{
					label: "Reconfigure",
					hint: "Choose extensions/themes again (preserves sessions, auth, hooks)",
					value: "reconfigure" as const,
				},
				{
					label: "Fresh install",
					hint: "Reset settings to defaults (preserves sessions, auth, hooks)",
					value: "fresh" as const,
				},
			],
		});

		if (isCancel(upgradeAction)) cancelled();

		if (upgradeAction === "upgrade") {
			return await runUpgrade(existing);
		}

		if (upgradeAction === "fresh") {
			const confirmFresh = await p.confirm({
				message:
					"This will reset your settings.json to defaults. Sessions, auth, hooks, and custom extensions are safe. Continue?",
				initialValue: false,
			});
			if (isCancel(confirmFresh) || !confirmFresh) cancelled();
			// Fall through to full install flow with fresh settings
			return await runFullInstall(allExtensions, allThemes, {});
		}

		// "reconfigure" — fall through with existing settings as defaults
		return await runFullInstall(allExtensions, allThemes, existing.settings);
	}

	// ── First-time install ───────────────────────────────────────────────────

	return await runFullInstall(allExtensions, allThemes, {});
}

// ─── Upgrade in place ────────────────────────────────────────────────────────

async function runUpgrade(existing: ExistingInstall): Promise<void> {
	p.note(
		["• Update template files (agents, commands)", "• Keep all existing settings untouched"].join(
			"\n"
		),
		"Upgrade plan"
	);

	const confirm = await p.confirm({
		message: "Proceed with upgrade?",
		initialValue: true,
	});

	if (isCancel(confirm) || !confirm) cancelled();

	// Copy any new agents/commands — preserves user edits
	const templates = installTemplates();
	if (templates.copied > 0) {
		p.log.info(`Added ${templates.copied} new template files`);
	}

	p.note(
		[
			"Settings, sessions, auth, hooks — all preserved",
			`Theme: ${existing.settings.theme ?? "default"}`,
		].join("\n"),
		"Upgrade complete"
	);

	p.outro("Done! Happy coding 🕯️");
}

// ─── Full install (first time or reconfigure) ───────────────────────────────

async function runFullInstall(
	allExtensions: readonly ExtensionInfo[],
	allThemes: readonly ThemeInfo[],
	existingSettings: Record<string, unknown>
): Promise<void> {
	const currentTheme =
		typeof existingSettings.theme === "string" ? existingSettings.theme : "trash-panda";
	const currentDisabled = Array.isArray(existingSettings.disabledExtensions)
		? new Set(existingSettings.disabledExtensions as string[])
		: new Set<string>();

	// ── Step 1: Install scope ────────────────────────────────────────────────

	const scope = await p.select({
		message: "What would you like to install?",
		options: [
			{
				label: "Everything",
				hint: `${allExtensions.length} extensions, ${allThemes.length} themes`,
				value: "all" as const,
			},
			{
				label: "Let me choose",
				hint: "Pick extensions and themes individually",
				value: "custom" as const,
			},
		],
	});

	if (isCancel(scope)) cancelled();

	let choices: InstallChoices;

	if (scope === "all") {
		// ── All: just pick a default theme ───────────────────────────────────

		const theme = await p.select({
			message: "Pick a default theme",
			options: allThemes.map((t) => ({ label: t.name, value: t.name })),
			initialValue: currentTheme,
		});

		if (isCancel(theme)) cancelled();

		choices = {
			defaultTheme: theme,
			extensions: allExtensions.map((e) => e.name),
			themes: allThemes.map((t) => t.name),
		};
	} else {
		// ── Custom: pick extension groups, then themes ────────────────────────

		const groups = groupExtensions(allExtensions);

		p.note(
			groups
				.map((g) => `${g.label}\n${g.extensions.map((e) => `  • ${e.name}`).join("\n")}`)
				.join("\n\n"),
			"Available extension groups"
		);

		// Pre-select groups where all extensions are currently enabled
		const preselectedGroups = groups
			.filter((g) => g.extensions.every((e) => !currentDisabled.has(e.name)))
			.map((g) => g.label);

		const selectedGroups = await p.multiselect({
			message: "Which extension groups do you want?",
			options: groups.map((g) => ({
				label: g.label,
				hint: `${g.extensions.length} extensions`,
				value: g.label,
			})),
			initialValues: preselectedGroups,
			required: false,
		});

		if (isCancel(selectedGroups)) cancelled();

		const selectedGroupSet = new Set(selectedGroups);
		const selectedExtensions = groups
			.filter((g) => selectedGroupSet.has(g.label))
			.flatMap((g) => g.extensions.map((e) => e.name));

		// ── Themes ───────────────────────────────────────────────────────────

		const selectedThemes = await p.multiselect({
			message: "Which themes do you want?",
			options: allThemes.map((t) => ({
				label: t.name,
				value: t.name,
			})),
			initialValues: allThemes.map((t) => t.name),
			required: false,
		});

		if (isCancel(selectedThemes)) cancelled();

		const themeList = selectedThemes.length > 0 ? selectedThemes : allThemes.map((t) => t.name);

		const theme = await p.select({
			message: "Pick a default theme",
			options: themeList.map((t) => ({ label: t, value: t })),
			initialValue: themeList.includes(currentTheme) ? currentTheme : themeList[0],
		});

		if (isCancel(theme)) cancelled();

		choices = {
			defaultTheme: theme,
			extensions: selectedExtensions,
			themes: themeList,
		};
	}

	// ── Summary ──────────────────────────────────────────────────────────────

	const agentCount = existsSync(join(TEMPLATES_DIR, "agents"))
		? readdirSync(join(TEMPLATES_DIR, "agents")).filter((f) => !f.startsWith(".")).length
		: 0;
	const commandCount = existsSync(join(TEMPLATES_DIR, "commands"))
		? readdirSync(join(TEMPLATES_DIR, "commands")).filter((f) => !f.startsWith(".")).length
		: 0;

	const summaryLines = [
		`Extensions:  ${choices.extensions.length}/${allExtensions.length}`,
		`Themes:      ${choices.themes.length}/${allThemes.length}`,
		`Agents:      ${agentCount} → ~/.tallow/agents/`,
		`Commands:    ${commandCount} → ~/.tallow/commands/`,
		`Default:     ${choices.defaultTheme}`,
		`Config dir:  ${TALLOW_HOME}`,
	];

	// Show what will be preserved if this is a reconfigure
	const hasExisting = Object.keys(existingSettings).length > 0;
	if (hasExisting) {
		summaryLines.push("", "Preserved: sessions, auth, hooks, custom extensions, packages");
	}

	p.note(summaryLines.join("\n"), "Install summary");

	const confirm = await p.confirm({
		message: "Proceed with installation?",
		initialValue: true,
	});

	if (isCancel(confirm) || !confirm) cancelled();

	// ── Step 3: Set up ~/.tallow/ ────────────────────────────────────────────

	const s = p.spinner();
	s.start("Setting up ~/.tallow/...");

	ensureDir(TALLOW_HOME);
	ensureDir(join(TALLOW_HOME, "sessions"));
	ensureDir(join(TALLOW_HOME, "extensions"));

	// Copy agents and commands — skips files the user already has
	const templates = installTemplates();
	if (templates.copied > 0) {
		p.log.info(
			`Installed ${templates.copied} template files (${templates.skipped} already existed)`
		);
	}

	// Merge into existing settings — only touch what the installer manages
	const settings = readSettings();
	settings.theme = choices.defaultTheme;

	if (choices.extensions.length < allExtensions.length) {
		const disabled = allExtensions
			.filter((e) => !choices.extensions.includes(e.name))
			.map((e) => e.name);
		settings.disabledExtensions = disabled;
	} else {
		delete settings.disabledExtensions;
	}

	// Preserve everything else (packages, enableSkillCommands, lastChangelogVersion, etc.)
	writeSettings(settings);
	s.stop("Config ready at ~/.tallow/");

	// ── Done ─────────────────────────────────────────────────────────────────

	p.note(
		[
			"Run `tallow` in any project directory to start",
			"Run `tallow --help` to see all options",
			`Config lives at ${TALLOW_HOME}/settings.json`,
		].join("\n"),
		"Next steps"
	);
	p.outro("Done! Happy coding 🕯️");
}

main().catch((error) => {
	console.error("Install failed:", error);
	process.exit(1);
});
