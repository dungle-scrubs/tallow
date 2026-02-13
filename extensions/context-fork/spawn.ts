/**
 * Fork Subprocess Spawner
 *
 * Spawns an ephemeral pi subprocess in JSON mode, collects the final
 * assistant output, and returns it. Minimal version of subagent-tool's
 * runSingleAgent — no event emission, abort handling, or streaming updates.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandFileReferences } from "../file-reference/index.js";

/** Configuration for spawning a forked subprocess. */
export interface ForkOptions {
	/** Expanded command/skill content to send as the task. */
	content: string;
	/** Working directory for the subprocess. */
	cwd: string;
	/** Tool names to restrict the subprocess to (from agent config). */
	tools?: string[];
	/** Skill paths to load in the subprocess. */
	skills?: string[];
	/** Full model ID (already resolved). */
	model?: string;
	/** Agent system prompt body. */
	systemPrompt?: string;
}

/** Result from a forked subprocess execution. */
export interface ForkResult {
	/** Final assistant text output. */
	output: string;
	/** Process exit code. */
	exitCode: number;
	/** Execution duration in milliseconds. */
	duration: number;
	/** Model used by the subprocess (if detected from output). */
	model?: string;
}

/** Subprocess timeout (5 minutes). */
const TIMEOUT_MS = 5 * 60 * 1000;

/** JSON event shape from pi --mode json. */
interface PiJsonEvent {
	type: string;
	message?: {
		role?: string;
		model?: string;
		content?: Array<{ type: string; text?: string }>;
	};
}

/**
 * Writes a system prompt to a temporary file.
 *
 * @param content - System prompt content
 * @returns Object with temp dir and file path (both need cleanup)
 */
function writeTempPrompt(content: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-"));
	const filePath = path.join(tmpDir, "prompt-fork.md");
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

/**
 * Extracts the final assistant text from collected pi JSON events.
 *
 * @param events - Parsed JSON events from subprocess stdout
 * @returns Final assistant text and model, or empty string if none found
 */
function extractFinalOutput(events: PiJsonEvent[]): { text: string; model?: string } {
	let text = "";
	let model: string | undefined;

	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type === "message_end" && event.message?.role === "assistant") {
			if (event.message.model) model = event.message.model;
			for (const part of event.message.content ?? []) {
				if (part.type === "text" && part.text) {
					text = part.text;
					break;
				}
			}
			if (text) break;
		}
	}

	return { text, model };
}

/**
 * Builds the pi subprocess argument list from fork options.
 *
 * @param options - Fork configuration
 * @param systemPromptPath - Path to temp system prompt file, if any
 * @returns Argument array for the pi command
 */
export async function buildForkArgs(
	options: ForkOptions,
	systemPromptPath?: string
): Promise<string[]> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	if (options.model) {
		args.push("--models", options.model);
	}
	if (options.tools && options.tools.length > 0) {
		args.push("--tools", options.tools.join(","));
	}
	if (options.skills && options.skills.length > 0) {
		for (const skill of options.skills) {
			args.push("--skill", skill);
		}
	}
	if (systemPromptPath) {
		args.push("--append-system-prompt", systemPromptPath);
	}

	// Expand file references (shell commands already expanded at template boundary)
	const expandedContent = await expandFileReferences(options.content, options.cwd);
	args.push(`Task: ${expandedContent}`);

	return args;
}

/**
 * Spawns a pi subprocess with the given options and collects the result.
 *
 * @param options - Fork configuration
 * @returns Result with output text, exit code, duration, and model
 */
export async function spawnForkSubprocess(options: ForkOptions): Promise<ForkResult> {
	const start = Date.now();
	let tmpDir: string | null = null;
	let tmpPath: string | null = null;

	try {
		let systemPromptPath: string | undefined;
		if (options.systemPrompt?.trim()) {
			const tmp = writeTempPrompt(options.systemPrompt);
			tmpDir = tmp.dir;
			tmpPath = tmp.filePath;
			systemPromptPath = tmpPath;
		}

		const args = await buildForkArgs(options, systemPromptPath);
		const events: PiJsonEvent[] = [];

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_IS_SUBAGENT: "1" } as Record<string, string>,
			});

			let buffer = "";

			const processLine = (line: string): void => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as PiJsonEvent;
					if (event.type === "message_end") {
						events.push(event);
					}
				} catch {
					/* skip non-JSON lines */
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			// Discard stderr (pi debug output)
			proc.stderr.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 1);
			});

			proc.on("error", () => {
				resolve(1);
			});

			// Timeout with SIGTERM → SIGKILL escalation
			const timeout = setTimeout(() => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}, TIMEOUT_MS);

			proc.on("close", () => clearTimeout(timeout));
		});

		const { text, model } = extractFinalOutput(events);

		return {
			output: text,
			exitCode,
			duration: Date.now() - start,
			model,
		};
	} finally {
		if (tmpPath) {
			try {
				fs.unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpDir) {
			try {
				fs.rmdirSync(tmpDir);
			} catch {
				/* ignore */
			}
		}
	}
}
