/**
 * Nested Prompts Extension
 *
 * Merges `commands/` and `prompts/` as equivalent sources and registers
 * prompts with colon-separated namespaces so subdirectory and
 * cross-package prompts never collide.
 *
 * Both directories are treated as synonyms — files from either are merged
 * into a single set, deduplicated by name (`prompts/` wins on conflict).
 *
 * Local prompts (not in a package):
 *   .tallow/prompts/<file>.md              → handled by pi built-in
 *   .tallow/commands/<file>.md             → /file (if not in prompts/)
 *   .tallow/prompts/<dir>/<file>.md        → /dir:file
 *   .tallow/commands/<dir>/<file>.md       → /dir:file (if not in prompts/)
 *   ~/.tallow/prompts/<dir>/<file>.md → /dir:file
 *   ~/.tallow/commands/<dir>/<file>.md → /dir:file (if not in prompts/)
 *
 * Package prompts (from settings.json packages/plugins):
 *   <pkg>/prompts/<file>.md            → /namespace:file
 *   <pkg>/commands/<file>.md           → /namespace:file
 *   <pkg>/prompts/<dir>/<file>.md      → /namespace:dir:file
 *   <pkg>/commands/<dir>/<file>.md     → /namespace:dir:file
 *
 * Namespace is the package directory name (e.g. "base", "fuse").
 * Skips files starting with `_` (templates/internal files).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

/** Frontmatter parsed from a prompt markdown file. */
interface PromptFrontmatter {
	description?: string;
	"argument-hint"?: string;
	[key: string]: unknown;
}

type PromptVisibilityMode = "compact" | "verbose";

interface PromptVisibilityEntry {
	mode?: PromptVisibilityMode;
}

const PROMPT_VISIBILITY_ENTRY_TYPE = "nested-prompts-view";

/**
 * Parses YAML frontmatter from prompt content.
 * @param content - Raw prompt content with optional frontmatter
 * @returns Parsed frontmatter object
 */
function parseFrontmatter(content: string): PromptFrontmatter {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) return {};

	const frontmatter: PromptFrontmatter = {};
	const lines = match[1].split("\n");

	for (const line of lines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;

		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();
		frontmatter[key] = value;
	}

	return frontmatter;
}

/**
 * Substitutes $ARGUMENTS, $@, $1, $2, etc. placeholders with actual arguments.
 * Also supports ${@:N} and ${@:N:L} slicing syntax.
 * @param content - Prompt content with placeholders
 * @param args - Space-separated argument string
 * @returns Content with substitutions applied
 */
function substituteArguments(content: string, args: string): string {
	const argList = args.split(/\s+/).filter(Boolean);

	// Replace $1, $2, etc. first (before wildcards to prevent re-substitution)
	let result = content.replace(/\$(\d+)/g, (_, num) => {
		const index = Number.parseInt(num, 10) - 1;
		return argList[index] ?? "";
	});

	// Replace ${@:start:length} and ${@:start}
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = Number.parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) {
			const length = Number.parseInt(lengthStr, 10);
			return argList.slice(start, start + length).join(" ");
		}
		return argList.slice(start).join(" ");
	});

	// Replace $ARGUMENTS and $@ with all args
	result = result.replace(/\$ARGUMENTS/g, args);
	result = result.replace(/\$@/g, args);

	return result;
}

/**
 * Reads the description (and optional argument-hint) from a prompt file.
 * @param filePath - Path to the prompt markdown file
 * @param fallback - Default description if frontmatter is missing
 * @returns Description string
 */
function readDescription(filePath: string, fallback: string): string {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const fm = parseFrontmatter(content);
		let desc = fm.description || fallback;
		if (fm["argument-hint"]) {
			desc += ` ${fm["argument-hint"]}`;
		}
		return desc;
	} catch {
		return fallback;
	}
}

/**
 * Checks whether a dirent is a readable file (follows symlinks).
 */
function isFile(dirPath: string, entry: fs.Dirent): boolean {
	if (entry.isFile()) return true;
	if (entry.isSymbolicLink()) {
		try {
			return fs.statSync(path.join(dirPath, entry.name)).isFile();
		} catch {
			return false;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Local prompts: subfolder:command
// ---------------------------------------------------------------------------

/**
 * Discovers prompt files in subdirectories of local prompt/command folders.
 * Scans multiple directories and merges results; first directory wins on
 * name collisions (so `prompts/` should come before `commands/`).
 * Only looks one level deep (direct subdirectories).
 * @param dirs - Root directories to scan (prompts/, commands/)
 * @returns Array of { dir, name, filePath } deduplicated by dir:name
 */
function discoverLocalNestedPrompts(
	dirs: string[]
): Array<{ dir: string; name: string; filePath: string }> {
	const seen = new Map<string, { dir: string; name: string; filePath: string }>();

	for (const promptsDir of dirs) {
		if (!fs.existsSync(promptsDir)) continue;

		try {
			const entries = fs.readdirSync(promptsDir, { withFileTypes: true });

			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_"))
					continue;

				const subdir = path.join(promptsDir, entry.name);
				try {
					const files = fs.readdirSync(subdir, { withFileTypes: true });
					for (const file of files) {
						if (!file.name.endsWith(".md") || file.name.startsWith("_")) continue;
						if (!isFile(subdir, file)) continue;

						const key = `${entry.name}:${file.name.replace(/\.md$/, "")}`;
						if (seen.has(key)) continue;

						seen.set(key, {
							dir: entry.name,
							name: file.name.replace(/\.md$/, ""),
							filePath: path.join(subdir, file.name),
						});
					}
				} catch {
					/* skip unreadable subdirs */
				}
			}
		} catch {
			/* skip unreadable dir */
		}
	}

	return Array.from(seen.values());
}

/**
 * Discovers top-level .md files in commands/ directories that are NOT
 * already present in the corresponding prompts/ directories.
 * Pi's built-in system handles prompts/ top-level files; this fills the
 * gap for commands/ files without creating duplicates.
 * @param commandsDirs - commands/ directories to scan
 * @param promptsDirs - prompts/ directories (used to exclude duplicates)
 * @returns Array of { name, filePath } for commands-only top-level files
 */
function discoverLocalTopLevelCommands(
	commandsDirs: string[],
	promptsDirs: string[]
): Array<{ name: string; filePath: string }> {
	const promptNames = new Set<string>();
	for (const dir of promptsDirs) {
		if (!fs.existsSync(dir)) continue;
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.endsWith(".md") && !entry.name.startsWith("_") && isFile(dir, entry)) {
					promptNames.add(entry.name.replace(/\.md$/, ""));
				}
			}
		} catch {
			/* skip unreadable dir */
		}
	}

	const results: Array<{ name: string; filePath: string }> = [];
	const seen = new Set<string>();

	for (const dir of commandsDirs) {
		if (!fs.existsSync(dir)) continue;
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!entry.name.endsWith(".md") || entry.name.startsWith("_")) continue;
				if (!isFile(dir, entry)) continue;

				const name = entry.name.replace(/\.md$/, "");
				if (promptNames.has(name) || seen.has(name)) continue;
				seen.add(name);

				results.push({ name, filePath: path.join(dir, entry.name) });
			}
		} catch {
			/* skip unreadable dir */
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Package prompts: namespace:folder:command  or  namespace:command
// ---------------------------------------------------------------------------

interface PackagePromptSource {
	namespace: string;
	promptsDirs: string[];
}

/**
 * Resolves a path that may start with ~ to an absolute path.
 */
function resolvePath(p: string, base: string): string {
	const trimmed = p.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	return path.resolve(base, trimmed);
}

/** Convention directories to scan for prompts inside a package. */
const PROMPT_CONVENTION_DIRS = ["prompts", "commands"];

/**
 * Reads a settings.json and returns prompt sources from installed packages.
 * For each package, collects ALL convention directories (prompts/, commands/)
 * as a single merged source — they are treated as synonyms.
 * Does NOT rely on the package manifest, so packages can set `"prompts": []`
 * to prevent pi's built-in loading while the extension handles everything.
 * @param settingsPath - Absolute path to settings.json
 * @returns Array of { namespace, promptsDirs } grouped by package
 */
function discoverPackagePromptSources(settingsPath: string): PackagePromptSource[] {
	const results: PackagePromptSource[] = [];
	if (!fs.existsSync(settingsPath)) return results;

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as {
			packages?: Array<string | { source: string }>;
		};

		const sources = settings.packages ?? [];
		if (sources.length === 0) return results;

		const settingsDir = path.dirname(settingsPath);
		const seen = new Set<string>();

		for (const pkg of sources) {
			const source = typeof pkg === "string" ? pkg : pkg.source;

			// Only handle local paths
			if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("https://"))
				continue;

			const resolved = resolvePath(source, settingsDir);
			if (seen.has(resolved)) continue;
			seen.add(resolved);

			const namespace = path.basename(resolved);

			// Collect all convention directories for this package
			const dirs: string[] = [];
			for (const dir of PROMPT_CONVENTION_DIRS) {
				const promptsDir = path.join(resolved, dir);
				if (fs.existsSync(promptsDir)) {
					dirs.push(promptsDir);
				}
			}

			if (dirs.length > 0) {
				results.push({ namespace, promptsDirs: dirs });
			}
		}
	} catch {
		/* skip unreadable settings */
	}

	return results;
}

/**
 * Discovers ALL prompts across multiple package directories (top-level +
 * one-deep subdirs). Merges results from all dirs, deduplicating by name
 * so that `prompts/` and `commands/` are treated as one source.
 * First directory wins on name collisions.
 * @param promptsDirs - Resolved prompt/command directories for one package
 * @returns Array of { dir (null for top-level), name, filePath }
 */
function discoverPackagePrompts(
	promptsDirs: string[]
): Array<{ dir: string | null; name: string; filePath: string }> {
	const seen = new Map<string, { dir: string | null; name: string; filePath: string }>();

	for (const promptsDir of promptsDirs) {
		if (!fs.existsSync(promptsDir)) continue;

		try {
			const entries = fs.readdirSync(promptsDir, { withFileTypes: true });

			for (const entry of entries) {
				if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

				const fullPath = path.join(promptsDir, entry.name);

				if (isFile(promptsDir, entry) && entry.name.endsWith(".md")) {
					// Top-level file → namespace:name
					const name = entry.name.replace(/\.md$/, "");
					const key = name;
					if (!seen.has(key)) {
						seen.set(key, { dir: null, name, filePath: fullPath });
					}
				} else if (entry.isDirectory()) {
					// Subdirectory → namespace:dir:name
					try {
						const files = fs.readdirSync(fullPath, { withFileTypes: true });
						for (const file of files) {
							if (!file.name.endsWith(".md") || file.name.startsWith("_")) continue;
							if (!isFile(fullPath, file)) continue;

							const name = file.name.replace(/\.md$/, "");
							const key = `${entry.name}/${name}`;
							if (!seen.has(key)) {
								seen.set(key, {
									dir: entry.name,
									name,
									filePath: path.join(fullPath, file.name),
								});
							}
						}
					} catch {
						/* skip unreadable subdirs */
					}
				}
			}
		} catch {
			/* skip unreadable dir */
		}
	}

	return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Shared: register a prompt as an extension command
// ---------------------------------------------------------------------------

/**
 * Registers a single prompt as an extension command.
 * @param pi - Extension API
 * @param commandName - The colon-separated command name (e.g. "base:skill:new")
 * @param filePath - Absolute path to the prompt markdown file
 * @param registered - Set of already-registered names (mutated)
 */
function registerPrompt(
	pi: ExtensionAPI,
	commandName: string,
	filePath: string,
	registered: Set<string>,
	getVisibilityMode: () => PromptVisibilityMode
): void {
	if (registered.has(commandName)) return;
	registered.add(commandName);

	const description = readDescription(filePath, `Run ${commandName}`);

	pi.registerCommand(commandName, {
		description,
		handler: async (args, cmdCtx) => {
			let content: string;
			try {
				content = fs.readFileSync(filePath, "utf-8");
			} catch {
				cmdCtx.ui.notify(`Failed to read prompt: ${commandName}`, "error");
				return;
			}

			// Strip frontmatter
			content = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");

			// Substitute arguments
			if (args) {
				content = substituteArguments(content, args);
			}

			const visibilityMode = getVisibilityMode();
			const inputText = args ? `/${commandName} ${args}` : `/${commandName}`;
			if (visibilityMode === "compact") {
				pi.sendMessage({
					content: `🪆 ${inputText}`,
					customType: "nested-prompt-summary",
					details: { commandName, mode: visibilityMode },
					display: true,
				});
			}

			pi.sendMessage(
				{
					content,
					customType: "nested-prompt-expanded",
					details: { commandName, mode: visibilityMode },
					display: visibilityMode === "verbose",
				},
				{ triggerTurn: true }
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const registered = new Set<string>();
	let promptVisibilityMode: PromptVisibilityMode = "compact";

	/**
	 * Persists prompt visibility mode for session resume.
	 */
	function persistPromptVisibilityMode(): void {
		pi.appendEntry(PROMPT_VISIBILITY_ENTRY_TYPE, { mode: promptVisibilityMode });
	}

	/**
	 * Shows current prompt visibility mode in a concise status notification.
	 * @param ctx - Extension context used for UI notifications
	 */
	function notifyPromptVisibility(ctx: ExtensionContext): void {
		ctx.ui.notify(
			`Prompt view: ${promptVisibilityMode === "compact" ? "compact" : "verbose"}`,
			"info"
		);
	}

	/**
	 * Sets prompt visibility mode, persists it, and notifies the user.
	 * @param mode - New mode to apply
	 * @param ctx - Extension context used for UI notifications
	 */
	function setPromptVisibilityMode(mode: PromptVisibilityMode, ctx: ExtensionContext): void {
		promptVisibilityMode = mode;
		persistPromptVisibilityMode();
		notifyPromptVisibility(ctx);
	}

	/**
	 * Toggles prompt visibility between compact and verbose modes.
	 * @param ctx - Extension context used for UI notifications
	 */
	function togglePromptVisibilityMode(ctx: ExtensionContext): void {
		const nextMode: PromptVisibilityMode =
			promptVisibilityMode === "compact" ? "verbose" : "compact";
		setPromptVisibilityMode(nextMode, ctx);
	}

	pi.registerCommand("prompt", {
		description: "Toggle expanded prompt visibility (compact/verbose)",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();

			if (value === "" || value === "toggle") {
				togglePromptVisibilityMode(ctx);
				return;
			}

			if (value === "status") {
				notifyPromptVisibility(ctx);
				return;
			}

			if (value === "compact" || value === "verbose") {
				setPromptVisibilityMode(value, ctx);
				return;
			}

			ctx.ui.notify("Usage: /prompt [compact|verbose|toggle|status]", "warning");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("o"), {
		description: "Toggle expanded prompt visibility",
		handler: async (ctx) => {
			togglePromptVisibilityMode(ctx);
		},
	});

	// Paired prompts/ and commands/ directories per scope
	const projectPromptsDir = path.join(process.cwd(), ".tallow", "prompts");
	const projectCommandsDir = path.join(process.cwd(), ".tallow", "commands");
	const projectClaudeCommandsDir = path.join(process.cwd(), ".claude", "commands");
	const globalPromptsDir = path.join(agentDir, "prompts");
	const globalCommandsDir = path.join(agentDir, "commands");
	const globalClaudeCommandsDir = path.join(os.homedir(), ".claude", "commands");

	// ----- Local top-level: commands/ files not already in prompts/ -----
	// Pi built-in handles prompts/ top-level; we cover commands/ top-level.
	// .tallow/ dirs first so they win on first-seen collision; .claude/ after.
	for (const cmd of discoverLocalTopLevelCommands(
		[projectCommandsDir, projectClaudeCommandsDir, globalCommandsDir, globalClaudeCommandsDir],
		[projectPromptsDir, globalPromptsDir]
	)) {
		registerPrompt(pi, cmd.name, cmd.filePath, registered, () => promptVisibilityMode);
	}

	// ----- Local nested: subfolder:command (merged from prompts/ + commands/) -----
	// Project-local first so it wins on collisions with global.
	// Within each scope, prompts/ first, .tallow/commands/ second, .claude/commands/ last
	// (first-seen wins in discoverLocalNestedPrompts).
	for (const dirs of [
		[projectPromptsDir, projectCommandsDir, projectClaudeCommandsDir],
		[globalPromptsDir, globalCommandsDir, globalClaudeCommandsDir],
	]) {
		for (const prompt of discoverLocalNestedPrompts(dirs)) {
			const commandName = `${prompt.dir}:${prompt.name}`;
			registerPrompt(pi, commandName, prompt.filePath, registered, () => promptVisibilityMode);
		}
	}

	// ----- Package prompts: namespace:command  or  namespace:folder:command -----
	const globalSettings = path.join(agentDir, "settings.json");
	const projectSettings = path.join(process.cwd(), ".tallow", "settings.json");

	// Project settings first so they win on collisions.
	// Each source merges prompts/ + commands/ for that package.
	const packageSources = [
		...discoverPackagePromptSources(projectSettings),
		...discoverPackagePromptSources(globalSettings),
	];

	for (const { namespace, promptsDirs } of packageSources) {
		for (const prompt of discoverPackagePrompts(promptsDirs)) {
			// Always register the fully-qualified name
			const fullName = prompt.dir
				? `${namespace}:${prompt.dir}:${prompt.name}`
				: `${namespace}:${prompt.name}`;
			registerPrompt(pi, fullName, prompt.filePath, registered, () => promptVisibilityMode);

			// Short aliases removed — only the fully-qualified namespace:name is registered
			// to avoid duplicate entries in the command palette.
		}
	}

	// Inject slash command design constraints into agent context
	pi.on("before_agent_start", async (event) => {
		const hint = [
			"\n## Slash Command Design Constraints\n",
			"Slash commands (`/command`) do not support space-separated subcommands — autocomplete can't handle spaces.",
			"`/debug on` won't work; it must be `/debug-on` or `/debug_on`. Design commands as either:",
			"- Separate commands: `/debug`, `/debug-on`, `/debug-off`, `/debug-tail`",
			"- Single command with no arguments: `/debug` (toggles or shows status)\n",
		].join("\n");
		return { systemPrompt: event.systemPrompt + hint };
	});

	// Restore persisted mode and log registered command diagnostics on session start.
	pi.on("session_start", async (_event, ctx) => {
		const visibilityEntry = ctx.sessionManager
			.getEntries()
			.filter(
				(entry: { type: string; customType?: string }) =>
					entry.type === "custom" && entry.customType === PROMPT_VISIBILITY_ENTRY_TYPE
			)
			.pop() as { data?: PromptVisibilityEntry } | undefined;

		if (visibilityEntry?.data?.mode === "compact" || visibilityEntry?.data?.mode === "verbose") {
			promptVisibilityMode = visibilityEntry.data.mode;
		}

		const commands = pi.getCommands();
		const ours = commands.filter(
			(c) => c.source === "extension" && (c.name.includes(":") || registered.has(c.name))
		);
		const total = registered.size;
		const found = ours.length;
		if (total > 0) {
			ctx.ui.notify(`nested-prompts: ${found}/${total} commands registered`, "info");
		}
		if (total > 0 && found === 0) {
			ctx.ui.notify(
				`nested-prompts: 0 commands visible! Registered: ${[...registered].slice(0, 5).join(", ")}...`,
				"error"
			);
		}
	});
}
