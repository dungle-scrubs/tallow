/**
 * Interactive-path regressions for `/clear` reset safety.
 *
 * Runs the real InteractiveMode in a child process under a pseudo-TTY so the
 * tests exercise the same interactive reset path as the TUI instead of a
 * headless harness-only approximation.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PYTHON_BIN = "python3";
const repoRoot = resolve(import.meta.dir, "../..");
const clearExtensionPath = join(repoRoot, "extensions/clear/index.js");
const contextForkPath = join(repoRoot, "extensions/context-fork/index.js");
const slashCommandBridgePath = join(repoRoot, "extensions/slash-command-bridge/index.js");
const sdkPath = join(repoRoot, "src/sdk.js");
const mockModelPath = join(repoRoot, "test-utils/mock-model.js");
const tempDirs: string[] = [];

interface InteractiveScenarioResult {
	readonly code: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

interface RunnerAction {
	readonly afterMarker?: string;
	readonly afterMs?: number;
	readonly data: string;
}

/**
 * Allocate a tracked temp directory.
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
 * Run one interactive scenario inside a child pseudo-terminal.
 *
 * @param scenarioName - Human-readable scenario name
 * @param scenarioSource - TypeScript scenario source code
 * @param actions - Timed or marker-driven terminal input actions
 * @returns Exit code with captured stdout/stderr
 */
function runInteractiveScenario(
	scenarioName: string,
	scenarioSource: string,
	actions: readonly RunnerAction[]
): Promise<InteractiveScenarioResult> {
	const tallowHome = makeTempDir(`tallow-${scenarioName}-home-`);
	const scriptDir = join(
		repoRoot,
		".tmp-tests",
		`${scenarioName}-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	tempDirs.push(scriptDir);
	const scenarioPath = join(scriptDir, `${scenarioName}.ts`);
	const runnerPath = join(scriptDir, `${scenarioName}.py`);

	const runnerSource = `
import json
import os
import pty
import select
import subprocess
import sys
import time

repo_root = ${JSON.stringify(repoRoot)}
scenario_path = ${JSON.stringify(scenarioPath)}
tallow_home = ${JSON.stringify(tallowHome)}
actions = json.loads(${JSON.stringify(JSON.stringify(actions))})
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
start = time.time()
sent = [False] * len(actions)
deadline = start + 20
while True:
    now = time.time()
    if now > deadline:
        proc.kill()
        break

    for index, action in enumerate(actions):
        if sent[index]:
            continue
        marker = action.get("afterMarker")
        after_ms = action.get("afterMs")
        if marker is not None:
            if marker.encode() in out:
                os.write(master, action["data"].encode())
                sent[index] = True
        elif after_ms is not None and (now - start) * 1000 >= after_ms:
            os.write(master, action["data"].encode())
            sent[index] = True

    ready, _, _ = select.select([master], [], [], 0.05)
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

	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(PYTHON_BIN, [runnerPath], {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", rejectPromise);
		child.on("close", (code) => {
			resolvePromise({ code, stderr, stdout });
		});
	});
}

/**
 * Build a common scenario prelude for interactive reset tests.
 *
 * @param body - Scenario-specific body
 * @returns Complete TypeScript scenario source
 */
function buildScenarioSource(body: string): string {
	return `
		import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { InteractiveMode } from "@mariozechner/pi-coding-agent";
		import clearExtension from ${JSON.stringify(clearExtensionPath)};
		import { registerContextForkExtension } from ${JSON.stringify(contextForkPath)};
		import slashCommandBridge from ${JSON.stringify(slashCommandBridgePath)};
		import { createTallowSession } from ${JSON.stringify(sdkPath)};
		import { createEchoStreamFn, createMockModel, createScriptedStreamFn } from ${JSON.stringify(mockModelPath)};

		const cwd = mkdtempSync(join(tmpdir(), "tallow-clear-ui-"));
		const cleanup = () => {
			rmSync(cwd, { force: true, recursive: true });
		};
		const log = (message) => {
			process.stdout.write(message + "\\n");
		};
		const fail = (code, message) => {
			log(message);
			cleanup();
			mode.stop();
			process.exit(code);
		};
		let clearStarted = false;
		let startupCount = 0;
		let exitTimer = null;

		${body}
	`;
}

/**
 * Assert the child scenario succeeded and emitted the expected marker.
 *
 * @param result - Captured child-process result
 * @param marker - Success marker expected in stdout
 * @returns Nothing
 */
function expectScenarioSuccess(result: InteractiveScenarioResult, marker: string): void {
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	expect(result.stdout).toContain(marker);
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
	tempDirs.length = 0;
});

describe("interactive /clear reset path", () => {
	it("leaves the replacement session idle", async () => {
		const scenario = buildScenarioSource(`
			const tracker = (pi) => {
				pi.on("session_start", async (event) => {
					if (event.reason === "startup") {
						startupCount += 1;
						log("MARKER: startup_ready");
						return;
					}
					if (event.reason !== "new") return;
					clearStarted = true;
					log("MARKER: clear_started");
					exitTimer = setTimeout(() => {
						log("MARKER: clear_idle_ok");
						cleanup();
						mode.stop();
						process.exit(0);
					}, 500);
				});
				pi.on("agent_start", async () => {
					if (clearStarted) {
						fail(2, "MARKER: unexpected_agent_start_after_clear");
					}
				});
				pi.on("turn_start", async () => {
					if (clearStarted) {
						fail(3, "MARKER: unexpected_turn_start_after_clear");
					}
				});
			};

			const tallow = await createTallowSession({
				cwd,
				startupProfile: "interactive",
				model: createMockModel(),
				provider: "mock",
				apiKey: "mock-api-key",
				session: { type: "memory" },
				noBundledExtensions: true,
				noBundledSkills: true,
				extensionFactories: [clearExtension, tracker],
			});
			const { runtime, session } = tallow;
			session.agent.streamFn = createEchoStreamFn();
			const mode = new InteractiveMode(runtime, { verbose: false });
			const timeout = setTimeout(() => fail(4, "MARKER: timeout"), 10000);
			await mode.run();
			clearTimeout(timeout);
			if (exitTimer) clearTimeout(exitTimer);
			cleanup();
		`);

		const result = await runInteractiveScenario("interactive-clear-idle", scenario, [
			{ afterMarker: "MARKER: startup_ready", data: "/clear\r" },
		]);

		expectScenarioSuccess(result, "MARKER: clear_idle_ok");
		expect(result.stdout).not.toContain("unexpected_agent_start_after_clear");
		expect(result.stdout).not.toContain("unexpected_turn_start_after_clear");
	}, 20_000);

	it("drops late deferred fork completion after /clear", async () => {
		const scenario = buildScenarioSource(`
			const commandPath = join(cwd, "review.md");
			writeFileSync(commandPath, "Review the code.\\n", "utf-8");
			const delayedForkExtension = (pi) =>
				registerContextForkExtension(pi, {
					buildFrontmatterIndex: () =>
						new Map([["review", { context: "fork", filePath: commandPath }]]),
					loadAllAgents: () => new Map(),
					routeForkedModel: async () => undefined,
					spawnForkSubprocess: () => {
						log("MARKER: fork_started");
						return new Promise((resolve) => {
							setTimeout(() => {
								resolve({ duration: 50, exitCode: 0, output: "fork done" });
							}, 400);
						});
					},
				});
			const tracker = (pi) => {
				pi.on("session_start", async (event) => {
					if (event.reason === "startup") {
						startupCount += 1;
						log("MARKER: startup_ready");
						return;
					}
					if (event.reason !== "new") return;
					clearStarted = true;
					log("MARKER: clear_started");
					exitTimer = setTimeout(() => {
						log("MARKER: clear_after_fork_ok");
						cleanup();
						mode.stop();
						process.exit(0);
					}, 900);
				});
				pi.on("agent_start", async () => {
					if (clearStarted) {
						fail(2, "MARKER: unexpected_agent_start_after_clear");
					}
				});
				pi.on("turn_start", async () => {
					if (clearStarted) {
						fail(3, "MARKER: unexpected_turn_start_after_clear");
					}
				});
			};

			const tallow = await createTallowSession({
				cwd,
				startupProfile: "interactive",
				model: createMockModel(),
				provider: "mock",
				apiKey: "mock-api-key",
				session: { type: "memory" },
				noBundledExtensions: true,
				noBundledSkills: true,
				extensionFactories: [delayedForkExtension, clearExtension, tracker],
			});
			const { runtime, session } = tallow;
			session.agent.streamFn = createEchoStreamFn();
			const mode = new InteractiveMode(runtime, { verbose: false });
			const timeout = setTimeout(() => fail(4, "MARKER: timeout"), 12000);
			await mode.run();
			clearTimeout(timeout);
			if (exitTimer) clearTimeout(exitTimer);
			cleanup();
		`);

		const result = await runInteractiveScenario("interactive-clear-fork", scenario, [
			{ afterMarker: "MARKER: startup_ready", data: "/review\r" },
			{ afterMarker: "MARKER: fork_started", data: "/clear\r" },
		]);

		expectScenarioSuccess(result, "MARKER: clear_after_fork_ok");
		expect(result.stdout).not.toContain("unexpected_agent_start_after_clear");
		expect(result.stdout).not.toContain("unexpected_turn_start_after_clear");
	}, 20_000);

	it("cancels compact continuation when /clear fires before resume", async () => {
		const scenario = buildScenarioSource(`
			const tracker = (pi) => {
				pi.on("session_before_compact", async () => {
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
					log("MARKER: compact_ready_for_clear");
				});
				pi.on("session_start", async (event) => {
					if (event.reason === "startup") {
						startupCount += 1;
						log("MARKER: startup_ready");
						return;
					}
					if (event.reason !== "new") return;
					clearStarted = true;
					log("MARKER: clear_started");
					exitTimer = setTimeout(() => {
						log("MARKER: clear_after_compact_ok");
						cleanup();
						mode.stop();
						process.exit(0);
					}, 800);
				});
				pi.on("agent_start", async () => {
					if (clearStarted) {
						fail(2, "MARKER: unexpected_agent_start_after_clear");
					}
				});
				pi.on("turn_start", async () => {
					if (clearStarted) {
						fail(3, "MARKER: unexpected_turn_start_after_clear");
					}
				});
			};

			const tallow = await createTallowSession({
				cwd,
				startupProfile: "interactive",
				model: createMockModel(),
				provider: "mock",
				apiKey: "mock-api-key",
				session: { type: "memory" },
				noBundledExtensions: true,
				noBundledSkills: true,
				extensionFactories: [slashCommandBridge, clearExtension, tracker],
				settings: {
					compaction: {
						enabled: true,
						keepRecentTokens: 1,
						reserveTokens: 10,
					},
				},
			});
			const { runtime, session } = tallow;
			session.agent.streamFn = createScriptedStreamFn([
				{ toolCalls: [{ name: "run_slash_command", arguments: { command: "compact" } }] },
				{ text: "finishing response before compaction" },
				{ text: "unexpected resume after clear" },
			]);
			const mode = new InteractiveMode(runtime, { verbose: false });
			const timeout = setTimeout(() => fail(4, "MARKER: timeout"), 12000);
			await mode.run();
			clearTimeout(timeout);
			if (exitTimer) clearTimeout(exitTimer);
			cleanup();
		`);

		const result = await runInteractiveScenario("interactive-clear-compact", scenario, [
			{ afterMarker: "MARKER: startup_ready", data: "compact the session\r" },
			{ afterMarker: "MARKER: compact_ready_for_clear", data: "/clear\r" },
		]);

		expectScenarioSuccess(result, "MARKER: clear_after_compact_ok");
		expect(result.stdout).not.toContain("unexpected_agent_start_after_clear");
		expect(result.stdout).not.toContain("unexpected_turn_start_after_clear");
		expect(result.stdout).not.toContain("unexpected resume after clear");
	}, 20_000);
});
