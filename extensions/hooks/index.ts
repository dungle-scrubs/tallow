/**
 * Hooks Extension - Claude Code-style hooks for Pi events
 *
 * Supports three hook types:
 *   - command: Run a shell command
 *   - prompt: Single LLM call for evaluation (not yet implemented)
 *   - agent: Spawn a subagent with tool access
 *
 * Hooks can be sync (blocking, can return decisions) or async (background).
 *
 * Configuration in settings.json:
 * {
 *   "hooks": {
 *     "tool_result": [{
 *       "matcher": "write|edit",
 *       "hooks": [{
 *         "type": "agent",
 *         "agent": "reviewer",
 *         "prompt": "Verify changes: $ARGUMENTS",
 *         "async": false,
 *         "timeout": 60
 *       }]
 *     }]
 *   }
 * }
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/** Hook execution strategy: shell command, LLM prompt, or agent subprocess. */
type HookType = "command" | "prompt" | "agent";

/** Configuration for a single hook action triggered by an event. */
interface HookHandler {
	type: HookType;
	command?: string; // For type: "command"
	agent?: string; // For type: "agent" - agent name from agents dir
	prompt?: string; // For type: "agent" or "prompt" - use $ARGUMENTS for event data
	model?: string; // Model override
	timeout?: number; // Seconds, default: 60 for agent, 30 for prompt, 600 for command
	async?: boolean; // Run in background (command/agent only)
	statusMessage?: string; // Custom spinner message
}

/** Event matcher with associated hooks — runs hooks when matcher regex matches. */
interface HookMatcher {
	matcher?: string; // Regex pattern, empty = match all
	hooks: HookHandler[];
}

/** Top-level hooks configuration keyed by event name. */
interface HooksConfig {
	[eventName: string]: HookMatcher[];
}

/** Result from executing a hook — may block, allow, or provide additional context. */
interface HookResult {
	ok: boolean;
	reason?: string;
	additionalContext?: string;
	decision?: "block" | "allow";
}

// Events that support blocking via hook decisions
const BLOCKABLE_EVENTS = new Set([
	"tool_call", // Can block before tool executes
	"input", // Can block user input
]);

/** Track prompt-type hooks that have already been warned about (once per command) */
const warnedPromptHooks = new Set<string>();

// Map Pi events to what field the matcher filters on
const MATCHER_FIELDS: Record<string, string> = {
	tool_call: "toolName",
	tool_result: "toolName",
	teammate_idle: "teammate",
	task_completed: "assignee",
	setup: "trigger",
};

/**
 * Merges hooks from a source into the target config.
 * Matchers are concatenated per event — no replacement.
 */
function mergeHooks(target: HooksConfig, source: HooksConfig): void {
	for (const [event, matchers] of Object.entries(source)) {
		if (!target[event]) {
			target[event] = [];
		}
		target[event].push(...matchers);
	}
}

/**
 * Reads hooks from a JSON file (standalone hooks.json or settings.json with hooks key).
 * Returns null if the file doesn't exist or can't be parsed.
 */
function readHooksFile(filePath: string): HooksConfig | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		// Standalone hooks.json has event keys at top level.
		// settings.json wraps them under a "hooks" key.
		return (
			content.hooks ??
			(content.tool_call || content.tool_result || content.agent_end ? content : null)
		);
	} catch {
		return null;
	}
}

/**
 * Scans a directory for extension hooks.json files.
 * Looks for <dir>/<ext>/hooks.json in each subdirectory.
 */
function scanExtensionHooks(extensionsDir: string): HooksConfig {
	const merged: HooksConfig = {};
	try {
		if (!fs.existsSync(extensionsDir)) return merged;
		const entries = fs.readdirSync(extensionsDir);
		for (const entry of entries) {
			const hooksPath = path.join(extensionsDir, entry, "hooks.json");
			const hooks = readHooksFile(hooksPath);
			if (hooks) {
				mergeHooks(merged, hooks);
			}
		}
	} catch {
		// Ignore scan errors
	}
	return merged;
}

/**
 * Resolves a path that may start with ~ to an absolute path.
 * @param p - Path that may contain ~ prefix
 * @returns Resolved absolute path
 */
function resolvePath(p: string): string {
	const trimmed = p.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	return path.resolve(trimmed);
}

/**
 * Reads settings.json and returns hooks.json paths from installed packages.
 * Scans each local package path for a hooks.json file.
 * @param settingsPath - Path to settings.json
 * @returns Array of HooksConfig objects found in packages
 */
function getPackageHooks(settingsPath: string): HooksConfig[] {
	const results: HooksConfig[] = [];
	if (!fs.existsSync(settingsPath)) return results;

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { packages?: Array<string | { source: string }> };
		if (!Array.isArray(settings.packages)) return results;

		const settingsDir = path.dirname(settingsPath);

		for (const pkg of settings.packages) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			// Only handle local paths (not npm: or git:)
			if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("https://"))
				continue;

			const resolved = resolvePath(
				source.startsWith("./") || source.startsWith("../")
					? path.resolve(settingsDir, source)
					: source
			);

			const hooksFile = path.join(resolved, "hooks.json");
			const hooks = readHooksFile(hooksFile);
			if (hooks) {
				results.push(hooks);
			}
		}
	} catch {
		// Ignore parse errors
	}

	return results;
}

/**
 * Loads and merges hooks from all sources.
 *
 * Scan order:
 *   1. hooks.json from packages in settings.json  (lowest priority)
 *   2. ~/.tallow/hooks.json                     (global standalone)
 *   3. ~/.tallow/settings.json                  (global settings)
 *   4. .tallow/hooks.json                             (project standalone)
 *   5. .tallow/settings.json                          (project settings)
 *   6. ~/.tallow/extensions/∗/hooks.json        (global extension hooks)
 *   7. .tallow/extensions/∗/hooks.json                (project extension hooks)
 *
 * All sources are merged additively — matchers are concatenated per event.
 * Runtime hooks from other extensions are merged later via the hooks:merge
 * event bus.
 *
 * @param cwd - Current working directory for project-local paths
 * @returns Merged hooks configuration
 */
function loadHooksConfig(cwd: string): HooksConfig {
	const home = process.env.HOME || "";
	const merged: HooksConfig = {};

	// 1. Package hooks (lowest priority)
	const globalSettingsPath = path.join(home, ".tallow", "settings.json");
	const projectSettingsPath = path.join(cwd, ".tallow", "settings.json");
	for (const hooks of getPackageHooks(globalSettingsPath)) {
		mergeHooks(merged, hooks);
	}
	for (const hooks of getPackageHooks(projectSettingsPath)) {
		mergeHooks(merged, hooks);
	}

	// 2–3. Global hooks (standalone + settings)
	const globalHooks = readHooksFile(path.join(home, ".tallow", "hooks.json"));
	if (globalHooks) mergeHooks(merged, globalHooks);

	const globalSettings = readHooksFile(globalSettingsPath);
	if (globalSettings) mergeHooks(merged, globalSettings);

	// 4–5. Project hooks (standalone + settings)
	const projectHooks = readHooksFile(path.join(cwd, ".tallow", "hooks.json"));
	if (projectHooks) mergeHooks(merged, projectHooks);

	const projectSettings = readHooksFile(projectSettingsPath);
	if (projectSettings) mergeHooks(merged, projectSettings);

	// 6. Global extension hooks
	const globalExtHooks = scanExtensionHooks(path.join(home, ".tallow", "extensions"));
	mergeHooks(merged, globalExtHooks);

	// 7. Project extension hooks
	const projectExtHooks = scanExtensionHooks(path.join(cwd, ".tallow", "extensions"));
	mergeHooks(merged, projectExtHooks);

	return merged;
}

/**
 * Checks if a value matches a regex pattern.
 * @param value - Value to test
 * @param pattern - Regex pattern (empty/undefined matches all)
 * @returns True if value matches pattern
 */
function matchesPattern(value: string | undefined, pattern: string | undefined): boolean {
	if (!pattern || pattern === "" || pattern === "*") return true;
	if (!value) return false;
	try {
		return new RegExp(pattern).test(value);
	} catch {
		return value === pattern;
	}
}

/**
 * Runs a command-type hook as a subprocess.
 * @param handler - Hook handler configuration
 * @param eventData - Event data to pass to the command
 * @param cwd - Working directory for the command
 * @param signal - Optional abort signal
 * @returns Hook result with ok status and optional context
 */
async function runCommandHook(
	handler: HookHandler,
	eventData: Record<string, unknown>,
	cwd: string,
	signal?: AbortSignal
): Promise<HookResult> {
	if (!handler.command) return { ok: true };

	const timeout = (handler.timeout ?? 600) * 1000;

	return new Promise((resolve) => {
		if (!handler.command) {
			resolve({ ok: true });
			return;
		}
		const proc = spawn(handler.command, {
			cwd,
			shell: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_HOOK_EVENT: JSON.stringify(eventData) },
		});

		let stdout = "";
		let stderr = "";
		let killed = false;

		const timeoutId = setTimeout(() => {
			killed = true;
			proc.kill("SIGTERM");
		}, timeout);

		proc.stdin.write(JSON.stringify(eventData));
		proc.stdin.end();

		proc.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});

		if (signal) {
			signal.addEventListener("abort", () => {
				killed = true;
				proc.kill("SIGTERM");
			});
		}

		proc.on("close", (code) => {
			clearTimeout(timeoutId);

			if (killed) {
				resolve({ ok: false, reason: "Hook timed out or was aborted" });
				return;
			}

			// Exit code 2 = blocking error
			if (code === 2) {
				resolve({ ok: false, reason: stderr || "Blocked by hook", decision: "block" });
				return;
			}

			// Exit code 0 = success, parse JSON output
			if (code === 0 && stdout.trim()) {
				try {
					const result = JSON.parse(stdout.trim());
					resolve({
						ok: result.ok ?? true,
						reason: result.reason,
						additionalContext: result.additionalContext,
						decision: result.decision,
					});
					return;
				} catch {
					// Not JSON, treat as additional context
					resolve({ ok: true, additionalContext: stdout.trim() });
					return;
				}
			}

			resolve({ ok: true });
		});
	});
}

/**
 * Runs an agent-type hook by spawning a pi subprocess.
 * @param handler - Hook handler configuration
 * @param eventData - Event data to include in prompt
 * @param cwd - Working directory for the agent
 * @param agentsDir - Directory containing agent definitions
 * @param signal - Optional abort signal
 * @returns Hook result with ok status and optional context
 */
async function runAgentHook(
	handler: HookHandler,
	eventData: Record<string, unknown>,
	cwd: string,
	agentsDir: string,
	signal?: AbortSignal
): Promise<HookResult> {
	const timeout = (handler.timeout ?? 60) * 1000;

	// Build the prompt
	let prompt =
		handler.prompt ||
		"Evaluate the following event and return JSON: { ok: true/false, reason: '...' }";
	prompt = prompt.replace(/\$ARGUMENTS/g, JSON.stringify(eventData, null, 2));

	// Build pi args
	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	if (handler.model) {
		args.push("--model", handler.model);
	}

	// If agent is specified, load its config
	if (handler.agent) {
		const agentPath = path.join(agentsDir, `${handler.agent}.md`);
		if (fs.existsSync(agentPath)) {
			args.push("--append-system-prompt", agentPath);
		}
	}

	args.push(prompt);

	return new Promise((resolve) => {
		const proc = spawn("pi", args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_IS_HOOK_AGENT: "1" },
		});

		let output = "";
		let killed = false;

		const timeoutId = setTimeout(() => {
			killed = true;
			proc.kill("SIGTERM");
		}, timeout);

		proc.stdout.on("data", (d) => {
			output += d.toString();
		});

		if (signal) {
			signal.addEventListener("abort", () => {
				killed = true;
				proc.kill("SIGTERM");
			});
		}

		proc.on("close", (code) => {
			clearTimeout(timeoutId);

			if (killed) {
				resolve({ ok: false, reason: "Hook agent timed out or was aborted" });
				return;
			}

			// Parse the last assistant message for the decision
			const lines = output.trim().split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					const event = JSON.parse(lines[i]);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						// Look for JSON in the response
						for (const part of event.message.content) {
							if (part.type === "text") {
								// Try to extract JSON from the text
								const jsonMatch = part.text.match(/\{[\s\S]*"ok"\s*:\s*(true|false)[\s\S]*\}/);
								if (jsonMatch) {
									try {
										const result = JSON.parse(jsonMatch[0]);
										resolve({
											ok: result.ok ?? true,
											reason: result.reason,
											additionalContext: result.additionalContext,
										});
										return;
									} catch {
										// Continue looking
									}
								}
							}
						}
					}
				} catch {
					// Not JSON, continue
				}
			}

			// Default to ok if no clear decision
			resolve({ ok: code === 0 });
		});
	});
}

/**
 * Registers Claude Code-style hooks for Pi events.
 * @param pi - Extension API for registering event handlers
 */
export default function (pi: ExtensionAPI) {
	let hooksConfig: HooksConfig = {};
	let agentsDir = "";
	let currentCwd = "";
	let ctx: ExtensionContext | null = null;

	// Pending async hook results to deliver on next turn
	const pendingAsyncResults: Array<{ event: string; result: HookResult }> = [];

	// ── Named event listener functions (removable on reload) ────

	/** Merge hook config from other extensions at runtime. */
	const onHooksMerge = (data: unknown) => {
		const matchers = data as Array<{
			piEvent: string;
			matcher?: string;
			hooks: Array<{ type: string; command?: string; [key: string]: unknown }>;
		}>;
		for (const m of matchers) {
			if (!hooksConfig[m.piEvent]) {
				hooksConfig[m.piEvent] = [];
			}
			hooksConfig[m.piEvent].push({
				matcher: m.matcher,
				hooks: m.hooks as HookHandler[],
			});
		}
	};

	/** Forward teammate_idle events to hook handlers. */
	const onTeammateIdle = (data: unknown) => {
		const event = data as { team: string; teammate: string; role: string };
		runHooks("teammate_idle", event);
	};

	/** Forward task_completed events to hook handlers. */
	const onTaskCompleted = (data: unknown) => {
		const event = data as {
			team: string;
			task_id: string;
			task_title: string;
			assignee: string;
			result: string;
		};
		runHooks("task_completed", event);
	};

	// ── Session lifecycle ────────────────────────────────────────

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		currentCwd = context.cwd;
		hooksConfig = loadHooksConfig(currentCwd);
		agentsDir = path.join(process.env.HOME || "", ".tallow", "agents");

		// Check for project-local agents dir
		const projectAgentsDir = path.join(currentCwd, ".tallow", "agents");
		if (fs.existsSync(projectAgentsDir)) {
			agentsDir = projectAgentsDir;
		}

		// Clean up previous event listeners on reload to prevent leaks.
		// pi.events persists across reloads — old listeners must be removed
		// before re-registering, otherwise each reload adds duplicates.
		const G = globalThis as Record<string, unknown>;
		if (G.__hooksEventCleanup) {
			(G.__hooksEventCleanup as () => void)();
		}

		// Register event listeners — on() returns unsubscribe functions
		const unsub1 = pi.events.on("hooks:merge", onHooksMerge);
		const unsub2 = pi.events.on("teammate_idle", onTeammateIdle);
		const unsub3 = pi.events.on("task_completed", onTaskCompleted);
		G.__hooksEventCleanup = () => {
			unsub1();
			unsub2();
			unsub3();
		};

		// Run setup hooks if triggered by --init, --init-only, or --maintenance CLI flags.
		// The env var is set by cli.ts before session creation and consumed here (one-shot).
		const setupTrigger = process.env.TALLOW_SETUP_TRIGGER;
		if (setupTrigger) {
			delete process.env.TALLOW_SETUP_TRIGGER;
			await runHooks("setup", {
				hook_event_name: "setup",
				trigger: setupTrigger,
				session_id: context.sessionManager.getSessionId(),
				cwd: currentCwd,
			});
		}
	});

	// Deliver pending async results at turn start
	pi.on("turn_start", async () => {
		if (pendingAsyncResults.length > 0 && ctx) {
			const results = pendingAsyncResults.splice(0);
			for (const { event, result } of results) {
				if (result.additionalContext || result.reason) {
					pi.sendMessage(
						{
							customType: "hook-result",
							content: result.additionalContext || result.reason || "",
							display: true,
							details: { event, ok: result.ok },
						},
						{ deliverAs: "nextTurn" }
					);
				}
			}
		}
	});

	// Helper to run hooks for an event
	async function runHooks(
		eventName: string,
		eventData: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<{ block: boolean; reason?: string; additionalContext?: string }> {
		const matchers = hooksConfig[eventName];
		if (!matchers || matchers.length === 0) {
			return { block: false };
		}

		const matcherField = MATCHER_FIELDS[eventName];
		const matchValue = matcherField ? (eventData[matcherField] as string) : undefined;

		const canBlock = BLOCKABLE_EVENTS.has(eventName);
		let shouldBlock = false;
		let blockReason: string | undefined;
		let additionalContext: string | undefined;

		for (const matcher of matchers) {
			if (!matchesPattern(matchValue, matcher.matcher)) {
				continue;
			}

			for (const handler of matcher.hooks) {
				// Async hooks run in background, cannot block
				if (handler.async) {
					// Fire and forget
					(async () => {
						let result: HookResult;
						if (handler.type === "command") {
							result = await runCommandHook(handler, eventData, currentCwd);
						} else if (handler.type === "agent") {
							result = await runAgentHook(handler, eventData, currentCwd, agentsDir);
						} else {
							return; // prompt type not yet supported async
						}

						// Queue result for next turn
						if (result.additionalContext || result.reason) {
							pendingAsyncResults.push({ event: eventName, result });
						}
					})();
					continue;
				}

				// Sync hooks - run and potentially block
				let result: HookResult;

				if (handler.type === "command") {
					result = await runCommandHook(handler, eventData, currentCwd, signal);
				} else if (handler.type === "agent") {
					result = await runAgentHook(handler, eventData, currentCwd, agentsDir, signal);
				} else if (handler.type === "prompt") {
					// TODO: implement single LLM call for prompt-type hooks
					if (!warnedPromptHooks.has(handler.command ?? "")) {
						warnedPromptHooks.add(handler.command ?? "");
						console.error(
							`Hook "${handler.command ?? "unknown"}" uses type "prompt" which is not yet implemented. Use type "command" or "agent" instead.`
						);
					}
					continue;
				} else {
					continue;
				}

				if (result.additionalContext) {
					additionalContext = `${(additionalContext || "") + result.additionalContext}\n`;
				}

				if (!result.ok && canBlock) {
					shouldBlock = true;
					blockReason = result.reason;
					break; // First blocking hook wins
				}
			}

			if (shouldBlock) break;
		}

		return {
			block: shouldBlock,
			reason: blockReason,
			additionalContext: additionalContext?.trim(),
		};
	}

	// Hook into tool_call events
	pi.on("tool_call", async (event, _ctx) => {
		const result = await runHooks("tool_call", {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			input: event.input,
		});

		if (result.block) {
			return { block: true, reason: result.reason || "Blocked by hook" };
		}
	});

	// Hook into tool_result events
	pi.on("tool_result", async (event) => {
		await runHooks("tool_result", {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			input: event.input,
			content: event.content,
			isError: event.isError,
		});
		// tool_result cannot block (tool already ran)
	});

	// Hook into agent_end events
	pi.on("agent_end", async (event) => {
		await runHooks("agent_end", {
			messages: event.messages,
		});
	});

	// Hook into input events
	pi.on("input", async (event) => {
		const result = await runHooks("input", {
			text: event.text,
			source: event.source,
		});

		if (result.block) {
			return { action: "handled" as const }; // Block the input
		}
	});
}
