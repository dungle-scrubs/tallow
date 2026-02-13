import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
import { setNextImageFilePath } from "@mariozechner/pi-tui";
import { BUNDLED, bootstrap, TALLOW_HOME, TALLOW_VERSION } from "./config.js";
import { migrateSessionsToPerCwdDirs } from "./session-migration.js";
import { createSessionWithId, findSessionById } from "./session-utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TallowSessionOptions {
	/** Working directory. Default: process.cwd() */
	cwd?: string;

	/** Pre-resolved Model object. Takes precedence over provider/modelId strings. */
	model?: CreateAgentSessionOptions["model"];

	/** Provider name (e.g., "anthropic"). Used with modelId for string-based resolution. */
	provider?: string;

	/** Model ID (e.g., "claude-sonnet-4"). Used with provider for string-based resolution. */
	modelId?: string;

	/** Runtime API key override (not persisted to auth.json). Requires provider to be set. */
	apiKey?: string;

	/** Thinking level. Default: from settings or "off" */
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];

	/** Session management strategy */
	session?:
		| { type: "memory" }
		| { type: "new" }
		| { type: "continue" }
		| { type: "open"; path: string }
		| { type: "open-or-create"; sessionId: string }
		| { type: "resume"; sessionId: string }
		| { type: "fork"; sourceSessionId: string };

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

	/** Session ID (UUID or user-provided) for programmatic chaining */
	sessionId: string;
}

// ─── Skill Name Normalization ────────────────────────────────────────────────

/**
 * Normalize all skill names to their parent directory name.
 *
 * The directory name is the canonical skill identifier — Claude Code works
 * the same way. The frontmatter `name` field is treated as a display hint,
 * not an identifier. This strips name-related diagnostics from the framework
 * which validates frontmatter `name` against the Agent Skills spec.
 *
 * @param result - Skills and diagnostics from loadSkills
 * @returns Skills with directory-based names and filtered diagnostics
 */
function normalizeSkillNames<D extends { message: string }>(result: {
	skills: Skill[];
	diagnostics: D[];
}): { skills: Skill[]; diagnostics: D[] } {
	const skills = result.skills.map((skill) => {
		const dirName = basename(dirname(skill.filePath));
		if (skill.name === dirName) return skill;
		return { ...skill, name: dirName };
	});

	const diagnostics = result.diagnostics.filter(
		(d) =>
			!d.message.includes("does not match parent directory") &&
			!d.message.includes("invalid characters")
	);

	return { skills, diagnostics };
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

	// ── Runtime API key (not persisted) ──────────────────────────────────────

	if (options.apiKey) {
		const keyProvider = options.provider ?? options.model?.provider;
		if (!keyProvider) {
			throw new Error("--api-key requires --provider or --model to be specified");
		}
		authStorage.setRuntimeApiKey(keyProvider, options.apiKey);
	}

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
		extensionFactories: [
			rebrandSystemPrompt,
			injectImageFilePaths,
			...(options.extensionFactories ?? []),
		],
		systemPromptOverride: options.systemPrompt ? () => options.systemPrompt : undefined,
		appendSystemPromptOverride: options.appendSystemPrompt
			? (base) => {
					const append = options.appendSystemPrompt;
					return append ? [...base, append] : base;
				}
			: undefined,
		skillsOverride: (base) => {
			const normalized = normalizeSkillNames(base);
			const extra = options.additionalSkills;
			return {
				skills: extra ? [...normalized.skills, ...extra] : normalized.skills,
				diagnostics: normalized.diagnostics,
			};
		},
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
			sessionManager = SessionManager.create(cwd);
			break;
		case "continue":
			sessionManager = SessionManager.continueRecent(cwd);
			break;
		case "open":
			sessionManager = SessionManager.open(sessionOpt.path);
			break;
		case "open-or-create": {
			const existing = findSessionById(sessionOpt.sessionId, cwd);
			sessionManager = existing
				? SessionManager.open(existing)
				: createSessionWithId(sessionOpt.sessionId, cwd);
			break;
		}
		case "resume": {
			const existing = findSessionById(sessionOpt.sessionId, cwd);
			if (!existing) {
				throw new Error(`Session not found: ${sessionOpt.sessionId}`);
			}
			sessionManager = SessionManager.open(existing);
			break;
		}
		case "fork": {
			const source = findSessionById(sessionOpt.sourceSessionId, cwd);
			if (!source) {
				throw new Error(`Source session not found: ${sessionOpt.sourceSessionId}`);
			}
			sessionManager = SessionManager.forkFrom(source, cwd);
			break;
		}
	}

	// ── Model resolution (string → Model object) ────────────────────────────

	let resolvedModel = options.model;
	if (!resolvedModel && options.provider) {
		const modelId = options.modelId ?? settingsManager.getDefaultModel();
		if (modelId) {
			resolvedModel = modelRegistry.find(options.provider, modelId) ?? undefined;
			if (!resolvedModel) {
				throw new Error(`Model ${options.provider}/${modelId} not found`);
			}
		} else {
			// Provider without model: find any available model for this provider
			const available = modelRegistry.getAll().filter((m) => m.provider === options.provider);
			if (available.length === 0) {
				throw new Error(`No models found for provider "${options.provider}"`);
			}
			resolvedModel = available[0];
		}
	}

	// ── Create Session ───────────────────────────────────────────────────────

	const result = await createAgentSession({
		cwd,
		agentDir: TALLOW_HOME,
		model: resolvedModel,
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
		sessionId: sessionManager.getSessionId(),
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Injects file paths into Image components for clickable OSC 8 links.
 * When the read tool returns an image, sets the pending file path so
 * the next Image constructor picks it up automatically.
 *
 * @param pi - Extension API
 */
function injectImageFilePaths(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "read") return;
		const hasImage = event.content?.some((c: { type: string }) => c.type === "image");
		if (hasImage && event.input?.path) {
			const filePath = resolve(String(event.input.path));
			setNextImageFilePath(filePath);
		}
	});
}

function ensureTallowHome(): void {
	const dirs = [TALLOW_HOME, join(TALLOW_HOME, "sessions"), join(TALLOW_HOME, "extensions")];

	for (const dir of dirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	// Migrate flat session files to per-cwd subdirectories (one-time, idempotent)
	migrateSessionsToPerCwdDirs(join(TALLOW_HOME, "sessions"));

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
