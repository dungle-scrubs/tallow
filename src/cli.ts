#!/usr/bin/env node

/**
 * Tallow CLI — an opinionated coding agent built on the pi framework.
 *
 * Usage:
 *   tallow                          Interactive mode
 *   tallow -p "Fix the tests"       Print mode (single-shot)
 *   tallow --mode rpc               RPC mode (for OpenClaw, etc.)
 *   tallow --continue               Continue most recent session
 *   tallow --list                   List available sessions
 */

// Bootstrap MUST happen before any framework imports resolve config
import {
	APP_NAME,
	bootstrap,
	isDemoMode,
	sanitizePath,
	TALLOW_HOME,
	TALLOW_VERSION,
} from "./config.js";

bootstrap();

// Unconditional fatal error handlers — must register before any session
// or extension setup so crashes are always visible to the user.
import { registerFatalErrorHandlers } from "./fatal-errors.js";
import { registerProcessCleanup } from "./process-cleanup.js";

registerFatalErrorHandlers();

// Signal + EIO/EPIPE handlers — fires session_shutdown on abnormal exit.
// Session ref is populated once createTallowSession() succeeds.
const cleanupSessionRef = registerProcessCleanup();

import {
	InteractiveMode,
	runPrintMode,
	runRpcMode,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Command, Option } from "commander";
import { createTallowSession, parseToolFlag, type TallowSessionOptions } from "./sdk.js";

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();

program
	.name(APP_NAME)
	.description("An opinionated coding agent. Built on pi.")
	.version(TALLOW_VERSION)
	.option("-p, --print <prompt>", "Single-shot: run prompt and print result")
	.option("-c, --continue", "Continue most recent session")
	.option("-m, --model <model>", "Model to use (provider/model-id)")
	.option("--provider <provider>", "Provider to use (anthropic, openai, google, etc.)")
	// --api-key removed: leaks secrets in `ps` output. Use TALLOW_API_KEY/TALLOW_API_KEY_REF.
	.option("--mode <mode>", "Run mode: interactive, rpc, json", "interactive")
	.option("--thinking <level>", "Thinking level: off, minimal, low, medium, high, xhigh")
	.option("--no-session", "Don't persist session (in-memory only)")
	.addOption(
		new Option("--session-id <id>", "Start or continue a named session by ID").conflicts([
			"continue",
			"resume",
			"forkSession",
		])
	)
	.addOption(
		new Option("--resume <id>", "Resume a specific session by ID (fails if not found)").conflicts([
			"continue",
			"sessionId",
			"forkSession",
		])
	)
	.addOption(
		new Option("--fork-session <id>", "Fork from an existing session into a new one").conflicts([
			"continue",
			"sessionId",
			"resume",
		])
	)
	.option(
		"--tools <names>",
		"Restrict available tools (comma-separated: read,bash,edit,write,grep,find,ls or presets: readonly,coding,none)"
	)
	.option(
		"--allowedTools <rules...>",
		'Permission allow rules in Tool(specifier) format (e.g. "Bash(npm *)" "Read")'
	)
	.option(
		"--disallowedTools <rules...>",
		'Permission deny rules in Tool(specifier) format (e.g. "Bash(ssh *)" "WebFetch")'
	)
	.option("-e, --extension <path...>", "Additional extension paths")
	.option(
		"--plugin-dir <path...>",
		"Load plugins from local directories (Claude Code or tallow format)"
	)
	.option("--no-extensions", "Disable all extensions (bundled + user)")
	.option("--list", "List available sessions")
	.option("--home", "Print Tallow home directory")
	.option("--demo", "Demo mode: hide sensitive info (paths, session IDs) for recordings")
	.option("--debug", "Enable debug diagnostic logging")
	.addOption(new Option("--init").hideHelp())
	.addOption(new Option("--init-only").hideHelp())
	.addOption(new Option("--maintenance").hideHelp())
	.action(run);

program
	.command("install")
	.description("Interactive installer — choose extensions, themes, and set up tallow")
	.option("-y, --yes", "Non-interactive: keep all settings, update templates")
	.option("--default-provider <provider>", "Set default provider (anthropic, openai, google)")
	.option("--default-model <model>", "Set default model ID (e.g., claude-sonnet-4)")
	// --api-key removed: leaks secrets in `ps` output. Use TALLOW_API_KEY/TALLOW_API_KEY_REF.
	.option("--theme <name>", "Set default theme")
	.option(
		"--thinking <level>",
		"Set default thinking level (off, minimal, low, medium, high, xhigh)"
	)
	.action(async () => {
		// Dynamically import so the main CLI stays lightweight
		await import("./install.js");
	});

program.parse();

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Run the CLI entrypoint with parsed commander options.
 *
 * @param opts - Parsed top-level CLI options
 * @returns Promise that resolves when execution completes
 */
async function run(opts: {
	allowedTools?: string[];
	continue?: boolean;
	debug?: boolean;
	demo?: boolean;
	disallowedTools?: string[];
	extension?: string[];
	extensions?: boolean;
	forkSession?: string;
	pluginDir?: string[];
	home?: boolean;
	init?: boolean;
	initOnly?: boolean;
	list?: boolean;
	maintenance?: boolean;
	mode: string;
	model?: string;
	print?: string;
	provider?: string;
	resume?: string;
	session?: boolean;
	sessionId?: string;
	thinking?: string;
	tools?: string;
}): Promise<void> {
	// Demo mode (set early — before --list and other output commands)
	if (opts.demo) {
		process.env.IS_DEMO = "1";
	}

	// Quick info commands
	if (opts.home) {
		console.log(TALLOW_HOME);
		return;
	}

	if (opts.list) {
		const sessions = await SessionManager.list(process.cwd());
		if (sessions.length === 0) {
			console.log("No sessions found.");
			return;
		}
		for (const s of sessions) {
			const date = s.modified.toLocaleDateString();
			let label = s.name ?? s.firstMessage?.slice(0, 60) ?? "(empty)";
			if (isDemoMode()) label = sanitizePath(label);
			console.log(`  ${date}  ${s.messageCount} msgs  ${label}`);
		}
		return;
	}

	// ── Debug flag (env var consumed by debug extension on session_start) ────

	if (opts.debug) {
		process.env.TALLOW_DEBUG = "1";
	}

	// ── Setup trigger (env var consumed by hooks extension on session_start) ─

	if (opts.init || opts.initOnly) {
		process.env.TALLOW_SETUP_TRIGGER = "init";
	} else if (opts.maintenance) {
		process.env.TALLOW_SETUP_TRIGGER = "maintenance";
	}

	// ── Build session options ────────────────────────────────────────────────

	// ── Parse model string (provider/model-id) ──────────────────────────────

	let provider = opts.provider;
	let modelId: string | undefined;

	if (opts.model) {
		const slashIdx = opts.model.indexOf("/");
		if (slashIdx !== -1) {
			provider = opts.model.slice(0, slashIdx);
			modelId = opts.model.slice(slashIdx + 1);
		} else {
			// Bare model name — use as modelId, provider from --provider or settings
			modelId = opts.model;
		}
	}

	const sessionOpts: TallowSessionOptions = {
		additionalExtensions: opts.extension,
		// apiKey resolved from TALLOW_API_KEY env var inside createTallowSession
		modelId,
		noBundledExtensions: opts.extensions === false,
		noBundledSkills: opts.extensions === false,
		plugins: opts.pluginDir,
		provider,
	};

	// Session strategy (--no-session takes highest priority)
	if (opts.session === false) {
		sessionOpts.session = { type: "memory" };
	} else if (opts.sessionId) {
		sessionOpts.session = { type: "open-or-create", sessionId: opts.sessionId };
	} else if (opts.resume) {
		sessionOpts.session = { type: "resume", sessionId: opts.resume };
	} else if (opts.forkSession) {
		sessionOpts.session = { type: "fork", sourceSessionId: opts.forkSession };
	} else if (opts.continue) {
		sessionOpts.session = { type: "continue" };
	} else {
		sessionOpts.session = { type: "new" };
	}

	// Thinking level
	if (opts.thinking) {
		sessionOpts.thinkingLevel = opts.thinking as TallowSessionOptions["thinkingLevel"];
	}

	// Tool restriction
	if (opts.tools) {
		try {
			sessionOpts.tools = parseToolFlag(opts.tools);
		} catch (err) {
			console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
	}

	// Permission rules via CLI flags — pass as env vars for extension pickup.
	// Extensions live in a separate tsconfig so CLI can't import them directly.
	if (opts.allowedTools?.length) {
		process.env.TALLOW_ALLOWED_TOOLS = JSON.stringify(opts.allowedTools);
	}
	if (opts.disallowedTools?.length) {
		process.env.TALLOW_DISALLOWED_TOOLS = JSON.stringify(opts.disallowedTools);
	}

	// ── Read piped stdin early (before the nested-session guard) ─────────────
	// Stdin must be consumed before the guard so piped input triggers print
	// mode instead of being blocked by the interactive nesting check.

	let stdinContent: string | undefined;
	try {
		stdinContent = await readStdin();
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	// Will this invocation produce output (print mode) rather than start a TUI?
	const hasPrintInput = Boolean(opts.print || stdinContent);

	// Guard: block nested interactive sessions (two TUIs on one terminal)
	// Do this before session setup so it fails fast without requiring model/auth resolution.
	if (opts.mode === "interactive" && !hasPrintInput && process.env.TALLOW_INTERACTIVE === "1") {
		console.error(
			"Error: Cannot start interactive tallow inside an existing interactive session.\n" +
				'Use `tallow -p "..."` or pipe input for single-shot prompts, or exit the current session first.'
		);
		process.exit(1);
	}

	// ── Create session ───────────────────────────────────────────────────────

	let tallow: Awaited<ReturnType<typeof createTallowSession>>;
	try {
		tallow = await createTallowSession(sessionOpts);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Session not found:")) {
			console.error(`Error: ${error.message}`);
			process.exit(1);
		}
		if (error instanceof Error && error.message.startsWith("Source session not found:")) {
			console.error(`Error: ${error.message}`);
			process.exit(1);
		}
		throw error;
	}

	// ── Register session for process-level cleanup ──────────────────────────

	cleanupSessionRef.current = tallow.session;

	// ── init-only: bind extensions (fires session_start → setup hooks), then exit ─

	if (opts.initOnly) {
		await tallow.session.bindExtensions({});
		return;
	}

	// ── Run in the requested mode ────────────────────────────────────────────

	switch (opts.mode) {
		case "interactive": {
			// Compose the initial message from stdin and/or -p flag
			const initialMessage = composeMessage(stdinContent, opts.print);

			if (initialMessage) {
				// Print mode: single-shot (explicit -p, piped stdin, or both)
				await runPrintMode(tallow.session, {
					mode: "text",
					initialMessage,
				});
				emitSessionId(tallow.sessionId);
			} else if (!process.stdin.isTTY) {
				// Stdin is piped/redirected but empty — can't start a TUI without a real TTY.
				console.error(
					"Error: stdin is piped but empty. Provide input via pipe or use -p <prompt>.\n" +
						"Example: echo 'hello' | tallow"
				);
				process.exit(1);
			} else {
				// Interactive TUI — stdin is a real TTY
				if (tallow.extensionOverrides.length > 0) {
					const names = tallow.extensionOverrides.map((o) => o.name).join(", ");
					console.log(`\x1b[33mℹ User extensions overriding bundled: ${names}\x1b[0m`);
					console.log(
						"\x1b[2m  To use bundled versions, rename yours or remove from ~/.tallow/extensions/\x1b[0m"
					);
				}
				// Sentinel so child processes (bash tool, subagents) know they're inside
				// an interactive session. Print/RPC mode intentionally skips this.
				process.env.TALLOW_INTERACTIVE = "1";
				const mode = new InteractiveMode(tallow.session, {
					modelFallbackMessage: tallow.modelFallbackMessage,
				});
				await mode.run();
			}
			break;
		}

		case "rpc": {
			await runRpcMode(tallow.session);
			break;
		}

		case "json": {
			const jsonMessage = composeMessage(stdinContent, opts.print);
			if (!jsonMessage) {
				console.error("JSON mode requires -p <prompt> or piped stdin");
				process.exit(1);
			}
			await runPrintMode(tallow.session, {
				mode: "json",
				initialMessage: jsonMessage,
			});
			emitSessionId(tallow.sessionId);
			break;
		}

		default:
			console.error(`Unknown mode: ${opts.mode}`);
			process.exit(1);
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compose the initial message from piped stdin content and/or a -p prompt.
 * When both are provided, stdin is prepended as context before the prompt.
 *
 * @param stdinContent - Content read from piped stdin, or undefined
 * @param prompt - Explicit -p prompt string, or undefined
 * @returns Combined message string, or undefined if neither is present
 */
function composeMessage(
	stdinContent: string | undefined,
	prompt: string | undefined
): string | undefined {
	if (stdinContent && prompt) return `${stdinContent}\n\n${prompt}`;
	return stdinContent ?? prompt;
}

/** Maximum stdin size (10 MB) to prevent memory exhaustion from accidental binary pipes. */
const MAX_STDIN_BYTES = 10 * 1024 * 1024;

/**
 * Read all content from stdin when it's a pipe or redirected stream.
 * Returns `undefined` when stdin is a TTY (interactive terminal).
 *
 * @returns The full stdin content as a string, or undefined if stdin is a TTY
 * @throws {Error} When stdin exceeds MAX_STDIN_BYTES
 */
async function readStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) return undefined;

	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalBytes = 0;

		process.stdin.on("data", (chunk: Buffer) => {
			totalBytes += chunk.byteLength;
			if (totalBytes > MAX_STDIN_BYTES) {
				process.stdin.destroy();
				reject(
					new Error(
						`Piped input exceeds ${MAX_STDIN_BYTES / 1024 / 1024} MB limit. ` +
							"Use @file.md syntax for very large files."
					)
				);
				return;
			}
			chunks.push(chunk);
		});

		process.stdin.on("end", () => {
			const content = Buffer.concat(chunks).toString("utf-8").trim();
			resolve(content.length > 0 ? content : undefined);
		});

		process.stdin.on("error", reject);
	});
}

/** Counter for demo-mode session IDs. */
let demoSessionCounter = 0;

/**
 * Emit the session ID to stderr for programmatic chaining.
 * Keeps stdout clean for piping while exposing the ID via stderr.
 * In demo mode, replaces the real UUID with a sequential label.
 *
 * @param sessionId - Session ID to emit
 */
function emitSessionId(sessionId: string): void {
	if (sessionId) {
		const displayId = isDemoMode() ? `session-${++demoSessionCounter}` : sessionId;
		process.stderr.write(`Session: ${displayId}\n`);
	}
}
