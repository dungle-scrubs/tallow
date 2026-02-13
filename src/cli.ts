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
import { APP_NAME, bootstrap, TALLOW_HOME, TALLOW_VERSION } from "./config.js";

bootstrap();

import {
	InteractiveMode,
	runPrintMode,
	runRpcMode,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Command, Option } from "commander";
import { createTallowSession, type TallowSessionOptions } from "./sdk.js";

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
	.option("--api-key <key>", "Runtime API key (not persisted). Requires --provider or -m")
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
	.option("-e, --extension <path...>", "Additional extension paths")
	.option("--no-extensions", "Disable all extensions (bundled + user)")
	.option("--list", "List available sessions")
	.option("--home", "Print Tallow home directory")
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
	.option("--api-key <key>", "Set API key for the default provider")
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

async function run(opts: {
	apiKey?: string;
	continue?: boolean;
	extension?: string[];
	extensions?: boolean;
	forkSession?: string;
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
}): Promise<void> {
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
			const label = s.name ?? s.firstMessage?.slice(0, 60) ?? "(empty)";
			console.log(`  ${date}  ${s.messageCount} msgs  ${label}`);
		}
		return;
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
		apiKey: opts.apiKey,
		modelId,
		noBundledExtensions: opts.extensions === false,
		noBundledSkills: opts.extensions === false,
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

	// Guard: block nested interactive sessions (two TUIs on one terminal)
	// Do this before session setup so it fails fast without requiring model/auth resolution.
	if (opts.mode === "interactive" && !opts.print && process.env.TALLOW_INTERACTIVE === "1") {
		console.error(
			"Error: Cannot start interactive tallow inside an existing interactive session.\n" +
				'Use `tallow -p "..."` for single-shot prompts, or exit the current session first.'
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

	// ── init-only: bind extensions (fires session_start → setup hooks), then exit ─

	if (opts.initOnly) {
		await tallow.session.bindExtensions({});
		return;
	}

	// ── Run in the requested mode ────────────────────────────────────────────

	switch (opts.mode) {
		case "interactive": {
			if (opts.print) {
				// Print mode: single-shot
				await runPrintMode(tallow.session, {
					mode: "text",
					initialMessage: opts.print,
				});
				emitSessionId(tallow.sessionId);
			} else {
				// Interactive TUI
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
			if (!opts.print) {
				console.error("JSON mode requires -p <prompt>");
				process.exit(1);
			}
			await runPrintMode(tallow.session, {
				mode: "json",
				initialMessage: opts.print,
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
 * Emit the session ID to stderr for programmatic chaining.
 * Keeps stdout clean for piping while exposing the ID via stderr.
 *
 * @param sessionId - Session ID to emit
 */
function emitSessionId(sessionId: string): void {
	if (sessionId) {
		process.stderr.write(`Session: ${sessionId}\n`);
	}
}
