/**
 * Interactive-path regression for model-invoked `/compact`.
 *
 * Runs the real InteractiveMode in a child process under a pseudo-TTY so the
 * test exercises the same compaction path as the TUI instead of the headless
 * SessionRunner path.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PYTHON_BIN = "python3";
const tempDirs: string[] = [];

const repoRoot = resolve(import.meta.dir, "../..");
const slashCommandBridgePath = join(repoRoot, "extensions/slash-command-bridge/index.js");
const sdkPath = join(repoRoot, "src/sdk.js");
const mockModelPath = join(repoRoot, "test-utils/mock-model.js");

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
	tempDirs.length = 0;
});

interface InteractiveScenarioResult {
	readonly code: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

/**
 * Allocates an isolated temp directory tracked for cleanup.
 *
 * @param prefix - Temp directory prefix
 * @returns Absolute temp directory path
 */
function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * Runs the real interactive compact scenario in a pseudo-terminal child process.
 *
 * @returns Exit code with captured stdout/stderr
 */
function runInteractiveCompactScenario(): Promise<InteractiveScenarioResult> {
	const tallowHome = makeTempDir("tallow-plan191-home-");
	const scriptDir = join(
		repoRoot,
		".tmp-tests",
		`interactive-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	tempDirs.push(scriptDir);
	const scenarioPath = join(scriptDir, "interactive-compact-check.ts");
	const scenarioSource = `
		import { mkdtempSync, rmSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { InteractiveMode } from "@mariozechner/pi-coding-agent";
		import slashCommandBridge from ${JSON.stringify(slashCommandBridgePath)};
		import { createTallowSession } from ${JSON.stringify(sdkPath)};
		import { createMockModel, createScriptedStreamFn } from ${JSON.stringify(mockModelPath)};

		const cwd = mkdtempSync(join(tmpdir(), "tallow-plan191-ui-"));
		let sawResumed = false;
		let sawCompact = false;

		const cleanup = () => {
			rmSync(cwd, { recursive: true, force: true });
		};

		const log = (message) => {
			process.stdout.write(message + "\\n");
		};

		const tracker = (pi) => {
			pi.on("tool_result", async (event) => {
				if (event.toolName !== "run_slash_command") return;
				if (event.details?.command !== "compact") return;
				log("MARKER: tool_result");
			});

			pi.on("agent_start", async () => {
				if (sawCompact) {
					log("MARKER: agent_start_after_compact");
				}
			});

			pi.on("turn_start", async () => {
				if (sawCompact) {
					log("MARKER: turn_start_after_compact");
				}
			});

			pi.on("session_before_compact", async () => {
				log("MARKER: session_before_compact");
				return {
					compaction: {
						summary: "MARKER_SUMMARY",
						firstKeptEntryId: undefined,
						tokensBefore: 123,
						details: { modifiedFiles: [], readFiles: [] },
					},
				};
			});

			pi.on("session_compact", async () => {
				sawCompact = true;
				log("MARKER: session_compact");
			});
		};

		const { session } = await createTallowSession({
			cwd,
			startupProfile: "interactive",
			model: createMockModel(),
			provider: "mock",
			apiKey: "mock-api-key",
			session: { type: "memory" },
			noBundledExtensions: true,
			noBundledSkills: true,
			extensionFactories: [slashCommandBridge, tracker],
			settings: {
				compaction: {
					enabled: true,
					keepRecentTokens: 1,
					reserveTokens: 10,
				},
			},
		});

		session.agent.streamFn = createScriptedStreamFn([
			{ text: "warmup complete" },
			{ toolCalls: [{ name: "run_slash_command", arguments: { command: "compact" } }] },
			{ text: "finishing response before compaction" },
			{ text: "resumed after compact" },
		]);

		const mode = new InteractiveMode(session, {
			initialMessages: ["warm up the session", "compact the session"],
			verbose: false,
		});

		const timeout = setTimeout(() => {
			log("MARKER: timeout");
			cleanup();
			mode.stop();
			process.exit(2);
		}, 10000);

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end") {
				const text =
					typeof event.message.content === "string"
						? event.message.content
						: event.message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\\n");

				if (event.message.role === "custom" && text.includes("Session compaction is complete")) {
					log("MARKER: continuation_message");
				}

				if (
					event.message.role === "assistant" &&
					text.includes("finishing response before compaction")
				) {
					log("MARKER: post_tool_response");
				}

				if (event.message.role === "assistant" && text.includes("resumed after compact")) {
					sawResumed = true;
					log("MARKER: resumed_once");
					clearTimeout(timeout);
					unsubscribe();
					setTimeout(() => {
						cleanup();
						mode.stop();
						process.exit(0);
					}, 300);
				}
			}
		});

		await mode.run();
		clearTimeout(timeout);
		unsubscribe();
		cleanup();
		if (!sawResumed) {
			log("MARKER: mode_run_returned");
			process.exit(3);
		}
	`;

	const runnerPath = join(scriptDir, "pty-runner.py");
	const runnerSource = `
import os
import pty
import select
import shutil
import subprocess
import sys
import time

repo_root = ${JSON.stringify(repoRoot)}
scenario_path = ${JSON.stringify(scenarioPath)}
tallow_home = ${JSON.stringify(tallowHome)}
master, slave = pty.openpty()
env = os.environ.copy()
env["TALLOW_HOME"] = tallow_home
proc = subprocess.Popen(
    ["bun", scenario_path],
    cwd=repo_root,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)
out = bytearray()
deadline = time.time() + 15
while True:
    if time.time() > deadline:
        proc.kill()
        break
    ready, _, _ = select.select([master], [], [], 0.2)
    if master in ready:
        try:
            chunk = os.read(master, 65536)
            if chunk:
                out.extend(chunk)
        except OSError:
            pass
    if proc.poll() is not None:
        while True:
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                out.extend(chunk)
            except OSError:
                break
        break
os.close(master)
sys.stdout.write(out.decode(errors="ignore"))
sys.exit(0 if proc.returncode is None else proc.returncode)
`;

	mkdirSync(scriptDir, { recursive: true });
	writeFileSync(scenarioPath, scenarioSource, "utf-8");
	writeFileSync(runnerPath, runnerSource, "utf-8");

	return new Promise((resolveResult) => {
		const child = spawn(PYTHON_BIN, [runnerPath], {
			cwd: repoRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		const killTimer = setTimeout(() => {
			child.kill("SIGKILL");
		}, 20000);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			clearTimeout(killTimer);
			resolveResult({ code, stderr, stdout });
		});
	});
}

/**
 * Returns the index of a marker inside captured child output.
 *
 * @param output - Captured stdout from the interactive child process
 * @param marker - Marker text to locate
 * @returns First marker position in the output string
 */
function markerIndex(output: string, marker: string): number {
	return output.indexOf(marker);
}

describe("interactive compact path", () => {
	it("shows the real TUI compaction summary and resumes exactly once", async () => {
		const result = await runInteractiveCompactScenario();
		const output = `${result.stdout}\n${result.stderr}`;

		expect(result.code).toBe(0);
		expect(output).not.toContain("MARKER: timeout");
		expect(output).not.toContain("MARKER: mode_run_returned");
		expect(output).toContain("MARKER: tool_result");
		expect(output).toContain("MARKER: post_tool_response");
		expect(output).toContain("MARKER: session_before_compact");
		expect(output).toContain("MARKER: session_compact");
		expect(output).toContain("[compaction]");
		expect(output).toContain("Compacted from 123 tokens");
		expect(output).toContain("MARKER: continuation_message");
		expect(output).toContain("MARKER: agent_start_after_compact");
		expect(output).toContain("MARKER: turn_start_after_compact");
		expect(output).toContain("MARKER: resumed_once");

		const toolResultIndex = markerIndex(output, "MARKER: tool_result");
		const postToolIndex = markerIndex(output, "MARKER: post_tool_response");
		const beforeCompactIndex = markerIndex(output, "MARKER: session_before_compact");
		const compactIndex = markerIndex(output, "MARKER: session_compact");
		const summaryLabelIndex = markerIndex(output, "[compaction]");
		const summaryBodyIndex = markerIndex(output, "Compacted from 123 tokens");
		const continuationIndex = markerIndex(output, "MARKER: continuation_message");
		const agentStartIndex = markerIndex(output, "MARKER: agent_start_after_compact");
		const turnStartIndex = markerIndex(output, "MARKER: turn_start_after_compact");
		const resumedIndex = markerIndex(output, "MARKER: resumed_once");

		expect(toolResultIndex).toBeGreaterThanOrEqual(0);
		expect(postToolIndex).toBeGreaterThan(toolResultIndex);
		expect(beforeCompactIndex).toBeGreaterThan(postToolIndex);
		expect(compactIndex).toBeGreaterThan(beforeCompactIndex);
		expect(summaryLabelIndex).toBeGreaterThan(compactIndex);
		expect(summaryBodyIndex).toBeGreaterThan(summaryLabelIndex);
		expect(agentStartIndex).toBeGreaterThan(summaryBodyIndex);
		expect(turnStartIndex).toBeGreaterThan(agentStartIndex);
		expect(continuationIndex).toBeGreaterThan(turnStartIndex);
		expect(resumedIndex).toBeGreaterThan(continuationIndex);
	}, 20000);
});
