/**
 * Tallow SDK
 *
 * An opinionated coding agent built on pi. Use createTallowSession() to
 * embed Tallow in your own applications, scripts, or orchestrators.
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
 * await session.prompt("What files are in this directory?");
 * session.dispose();
 * ```
 */

// ── Tallow SDK ───────────────────────────────────────────────────────────────

export {
	APP_NAME,
	BUNDLED,
	bootstrap,
	CONFIG_DIR,
	isDemoMode,
	sanitizePath,
	TALLOW_HOME,
	TALLOW_VERSION,
} from "./config.js";
export {
	type ClaudePluginManifest,
	type ClaudePluginResources,
	clearPluginCache,
	detectPluginFormat,
	extractClaudePluginResources,
	listCachedPlugins,
	type PluginFormat,
	type PluginResolutionResult,
	type PluginSpec,
	parsePluginSpec,
	type ResolvedPlugin,
	refreshPlugin,
	resolvePlugin,
	resolvePlugins,
	type TallowExtensionManifest,
} from "./plugins.js";
export { createTallowSession, type TallowSession, type TallowSessionOptions } from "./sdk.js";
export { createSessionWithId, findSessionById } from "./session-utils.js";

// ── Re-exports from pi (convenience) ─────────────────────────────────────────
//
// Users who need deeper pi access can import from @mariozechner/pi-coding-agent
// directly. These re-exports cover the most common SDK use cases.

export type {
	AgentSession,
	AgentSessionConfig,
	AgentSessionEvent,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	PromptTemplate,
	Skill,
	ToolCallEvent,
	ToolDefinition,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
export {
	AuthStorage,
	createEventBus,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

// Schema tools for custom tool definitions
export { Type } from "@sinclair/typebox";
