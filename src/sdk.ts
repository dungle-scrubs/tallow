import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	AuthStorage,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	ModelRegistry,
	type PromptTemplate,
	SessionManager,
	SettingsManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { BUNDLED, bootstrap, TALLOW_HOME, TALLOW_VERSION } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TallowSessionOptions {
	/** Working directory. Default: process.cwd() */
	cwd?: string;

	/** Model provider/id to use. If omitted, uses default from settings or first available. */
	model?: CreateAgentSessionOptions["model"];

	/** Thinking level. Default: from settings or "off" */
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];

	/** Session management strategy */
	session?:
		| { type: "memory" }
		| { type: "new" }
		| { type: "continue" }
		| { type: "open"; path: string };

	/** Additional extension paths (on top of bundled + user) */
	additionalExtensions?: string[];

	/** Additional extension factories (inline extensions) */
	extensionFactories?: ExtensionFactory[];

	/** Additional skills (on top of bundled + user) */
	additionalSkills?: Skill[];

	/** Additional prompt templates */
	additionalPrompts?: PromptTemplate[];

	/** Override the system prompt entirely */
	systemPrompt?: string;

	/** Append to the system prompt */
	appendSystemPrompt?: string;

	/** Disable bundled extensions */
	noBundledExtensions?: boolean;

	/** Disable bundled skills */
	noBundledSkills?: boolean;

	/** Custom tools (in addition to built-in coding tools) */
	customTools?: CreateAgentSessionOptions["customTools"];

	/** Override built-in tools */
	tools?: CreateAgentSessionOptions["tools"];

	/** Settings overrides */
	settings?: Record<string, unknown>;
}

export interface TallowSession {
	/** The underlying AgentSession */
	session: CreateAgentSessionResult["session"];

	/** Extension loading results */
	extensions: CreateAgentSessionResult["extensionsResult"];

	/** Model fallback message (if session model couldn't be restored) */
	modelFallbackMessage?: string;

	/** Tallow version */
	version: string;

	/** Bundled extensions overridden by user extensions (name → user path) */
	extensionOverrides: Array<{ name: string; userPath: string }>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Tallow session with all bundled extensions, skills, prompts,
 * and agents pre-loaded. This is the main SDK entry point.
 *
 * ```typescript
 * import { createTallowSession } from "tallow";
 *
 * const { session } = await createTallowSession();
 *
 * session.subscribe((event) => {
 *   if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
 *     process.stdout.write(event.assistantMessageEvent.delta);
 *   }
 * });
 *
 * await session.prompt("Fix the failing tests");
 * ```
 */
export async function createTallowSession(
	options: TallowSessionOptions = {}
): Promise<TallowSession> {
	// Ensure env is configured before any framework internals resolve paths
	bootstrap();
	ensureTallowHome();

	const cwd = options.cwd ?? process.cwd();
	const eventBus = createEventBus();

	// ── Auth & Models ────────────────────────────────────────────────────────

	const authStorage = new AuthStorage(join(TALLOW_HOME, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, join(TALLOW_HOME, "models.json"));

	// ── Settings ─────────────────────────────────────────────────────────────

	const settingsManager = SettingsManager.create(cwd, TALLOW_HOME);
	if (options.settings) {
		settingsManager.applyOverrides(options.settings);
	}

	// ── Resource Loader ──────────────────────────────────────────────────────

	const additionalExtensionPaths: string[] = [];
	const additionalSkillPaths: string[] = [];
	const additionalPromptPaths: string[] = [];
	const additionalThemePaths: string[] = [];

	// Track bundled extensions overridden by user extensions
	const extensionOverrides: Array<{ name: string; userPath: string }> = [];

	// Bundled resources from the package
	if (!options.noBundledExtensions && existsSync(BUNDLED.extensions)) {
		// Discover user extensions that might override bundled ones
		const userExtDir = join(TALLOW_HOME, "extensions");
		const userExtNames = new Set<string>();
		const userExtPaths = new Map<string, string>();
		if (existsSync(userExtDir)) {
			for (const name of discoverExtensionDirs(userExtDir)) {
				const extName = basename(name);
				userExtNames.add(extName);
				userExtPaths.set(extName, name);
			}
		}

		// Add bundled extensions, skipping any overridden by user versions
		for (const bundledPath of discoverExtensionDirs(BUNDLED.extensions)) {
			const name = basename(bundledPath);
			if (userExtNames.has(name)) {
				extensionOverrides.push({ name, userPath: userExtPaths.get(name) ?? name });
			} else {
				additionalExtensionPaths.push(bundledPath);
			}
		}
	}
	if (!options.noBundledSkills && existsSync(BUNDLED.skills)) {
		additionalSkillPaths.push(BUNDLED.skills);
	}
	if (existsSync(BUNDLED.themes)) {
		additionalThemePaths.push(BUNDLED.themes);
	}

	// User-provided additional paths
	if (options.additionalExtensions) {
		additionalExtensionPaths.push(...options.additionalExtensions);
	}

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: TALLOW_HOME,
		settingsManager,
		eventBus,
		additionalExtensionPaths,
		additionalSkillPaths,
		additionalPromptTemplatePaths: additionalPromptPaths,
		additionalThemePaths,
		extensionFactories: [rebrandSystemPrompt, ...(options.extensionFactories ?? [])],
		systemPromptOverride: options.systemPrompt ? () => options.systemPrompt : undefined,
		appendSystemPromptOverride: options.appendSystemPrompt
			? (base) => {
					const append = options.appendSystemPrompt;
					return append ? [...base, append] : base;
				}
			: undefined,
		skillsOverride: options.additionalSkills
			? (base) => {
					const extra = options.additionalSkills;
					return {
						skills: extra ? [...base.skills, ...extra] : base.skills,
						diagnostics: base.diagnostics,
					};
				}
			: undefined,
		promptsOverride: options.additionalPrompts
			? (base) => {
					const extra = options.additionalPrompts;
					return {
						prompts: extra ? [...base.prompts, ...extra] : base.prompts,
						diagnostics: base.diagnostics,
					};
				}
			: undefined,
	});

	await loader.reload();

	// ── Session Manager ──────────────────────────────────────────────────────

	let sessionManager: SessionManager;
	const sessionOpt = options.session ?? { type: "new" };

	switch (sessionOpt.type) {
		case "memory":
			sessionManager = SessionManager.inMemory();
			break;
		case "new":
			sessionManager = SessionManager.create(cwd, join(TALLOW_HOME, "sessions"));
			break;
		case "continue": {
			const sessionsDir = join(TALLOW_HOME, "sessions");
			const recentPath = findMostRecentSessionForCwd(sessionsDir, cwd);
			if (recentPath) {
				sessionManager = SessionManager.open(recentPath, sessionsDir);
			} else {
				// No session for this cwd — fall back to creating a new one
				sessionManager = SessionManager.create(cwd, sessionsDir);
			}
			break;
		}
		case "open":
			sessionManager = SessionManager.open(sessionOpt.path);
			break;
	}

	// ── Create Session ───────────────────────────────────────────────────────

	const result = await createAgentSession({
		cwd,
		agentDir: TALLOW_HOME,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		authStorage,
		modelRegistry,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
		tools: options.tools,
		customTools: options.customTools,
	});

	return {
		session: result.session,
		extensions: result.extensionsResult,
		modelFallbackMessage: result.modelFallbackMessage,
		version: TALLOW_VERSION,
		extensionOverrides,
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the most recent session file in sessionDir whose cwd matches the given directory.
 * Reads the first line (JSONL header) of each session to check the cwd field.
 * Returns the file path, or null if none match.
 *
 * @param sessionDir - Directory containing session .jsonl files
 * @param cwd - Working directory to filter by
 * @returns Path to the most recent matching session, or null
 */
function findMostRecentSessionForCwd(sessionDir: string, cwd: string): string | null {
	try {
		const resolvedCwd = resolve(cwd);
		const candidates = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => {
				const fullPath = join(sessionDir, f);
				return { path: fullPath, mtime: statSync(fullPath).mtime };
			})
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		for (const { path } of candidates) {
			try {
				const content = readFileSync(path, "utf-8");
				const firstNewline = content.indexOf("\n");
				const headerLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
				const header = JSON.parse(headerLine);
				if (header.type === "session" && resolve(header.cwd) === resolvedCwd) {
					return path;
				}
			} catch {
				// Corrupt or unreadable file — skip
			}
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Discover extension subdirectories — each dir with an index.ts is an extension.
 * Also picks up standalone .ts files.
 */
function discoverExtensionDirs(baseDir: string): string[] {
	const paths: string[] = [];
	try {
		for (const entry of readdirSync(baseDir)) {
			if (entry.startsWith(".")) continue;
			const full = join(baseDir, entry);
			const stat = statSync(full);
			if (stat.isDirectory() && existsSync(join(full, "index.ts"))) {
				paths.push(full);
			} else if (stat.isFile() && entry.endsWith(".ts")) {
				paths.push(full);
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}
	return paths;
}

/**
 * Built-in extension factory that rebrands the pi system prompt for tallow.
 * Registered as a factory so it cannot be overridden or removed by users.
 */
function rebrandSystemPrompt(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		const prompt = event.systemPrompt
			.replace(
				"You are an expert coding assistant operating inside pi, a coding agent harness.",
				"You are an expert coding assistant operating inside tallow, a coding agent harness."
			)
			.replace(/Pi documentation/g, "Tallow documentation")
			.replace(/When working on pi topics/g, "When working on tallow topics")
			.replace(/read pi \.md files/g, "read tallow .md files")
			.replace(/the user asks about pi itself/g, "the user asks about tallow itself");
		return { systemPrompt: prompt };
	});
}

function ensureTallowHome(): void {
	const dirs = [TALLOW_HOME, join(TALLOW_HOME, "sessions"), join(TALLOW_HOME, "extensions")];

	for (const dir of dirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	ensureKeybindings();
}

/**
 * Tallow keybinding overrides applied on top of framework defaults.
 * These free up ctrl+s and ctrl+p for the stash-prompt extension.
 *
 * IMPORTANT: ctrl+m is the same terminal byte as Enter (\r, char 13)
 * because terminals compute ctrl+letter as charCode & 0x1f.
 * Never bind anything to ctrl+m — it will intercept Enter.
 *
 * Remaps:
 *   cycleModelForward:  ctrl+p → unbound (use ctrl+l model selector instead)
 *   cycleModelBackward: shift+ctrl+p → unbound
 *   toggleSessionSort:  ctrl+s → unbound
 *   toggleSessionPath:  ctrl+p → unbound
 */
const TALLOW_KEYBINDINGS: Record<string, string | string[]> = {
	cycleModelForward: [],
	cycleModelBackward: [],
	toggleSessionSort: [],
	toggleSessionPath: [],
};

/**
 * Ensures keybindings.json contains tallow's mandatory overrides.
 * Merges with any existing user customizations — tallow keys take precedence.
 */
function ensureKeybindings(): void {
	const keybindingsPath = join(TALLOW_HOME, "keybindings.json");

	let existing: Record<string, unknown> = {};
	if (existsSync(keybindingsPath)) {
		try {
			existing = JSON.parse(readFileSync(keybindingsPath, "utf-8"));
		} catch {
			// Corrupt file — overwrite
		}
	}

	const merged = { ...existing, ...TALLOW_KEYBINDINGS };

	// Only write if something changed
	const currentJson = JSON.stringify(existing, null, "\t");
	const mergedJson = JSON.stringify(merged, null, "\t");
	if (currentJson !== mergedJson) {
		writeFileSync(keybindingsPath, `${mergedJson}\n`);
	}
}
