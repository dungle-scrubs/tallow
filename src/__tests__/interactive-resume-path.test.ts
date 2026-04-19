import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PYTHON_BIN = "python3";
const repoRoot = resolve(import.meta.dir, "../..");
const sdkDistPath = join(repoRoot, "dist/sdk.js");
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

type ScenarioRuntime = "bun" | "node";

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function runInteractiveScenario(
	scenarioName: string,
	scenarioSource: string,
	actions: readonly RunnerAction[],
	runtime: ScenarioRuntime = "bun"
): Promise<InteractiveScenarioResult> {
	const tallowHome = makeTempDir(`tallow-${scenarioName}-home-`);
	const scriptDir = join(
		repoRoot,
		".tmp-tests",
		`${scenarioName}-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	tempDirs.push(scriptDir);
	const scenarioExtension = runtime === "node" ? "mjs" : "ts";
	const scenarioPath = join(scriptDir, `${scenarioName}.${scenarioExtension}`);
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
runtime = ${JSON.stringify(runtime)}
master, slave = pty.openpty()
env = os.environ.copy()
env["TALLOW_HOME"] = tallow_home
proc = subprocess.Popen(
    [runtime, scenario_path],
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
deadline = start + 25
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

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
	tempDirs.length = 0;
});

describe("interactive resume rendering", () => {
	it("does not replay transcript lines during startup continue", async () => {
		const scenarioSource = `
			import { mkdtempSync, rmSync } from "node:fs";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			import { InteractiveMode } from "@mariozechner/pi-coding-agent";
			import { createTallowSession } from ${JSON.stringify(sdkPath)};
			import { createEchoStreamFn, createMockModel } from ${JSON.stringify(mockModelPath)};

			const cwd = mkdtempSync(join(tmpdir(), "continue-repro-cwd-"));
			const first = await createTallowSession({
				cwd,
				startupProfile: "interactive",
				model: createMockModel(),
				provider: "mock",
				apiKey: "mock-api-key",
				session: { type: "new" },
				noBundledExtensions: true,
				noBundledSkills: true,
			});
			first.session.agent.streamFn = createEchoStreamFn();
			for (let index = 0; index < 18; index += 1) {
				await first.session.prompt("prompt-" + String(index).padStart(2, "0"));
			}
			first.session.dispose();
			const continued = await createTallowSession({
				cwd,
				startupProfile: "interactive",
				model: createMockModel(),
				provider: "mock",
				apiKey: "mock-api-key",
				session: { type: "continue" },
				noBundledExtensions: true,
				noBundledSkills: true,
			});
			const mode = new InteractiveMode(continued.runtime, { verbose: false });
			const writes = [];
			const originalWrite = mode.ui.terminal.write.bind(mode.ui.terminal);
			mode.ui.terminal.write = (data) => {
				writes.push(data);
				return originalWrite(data);
			};
			setTimeout(() => {
				const joined = writes.join("");
				process.stdout.write("HAS_PROMPT_00 " + joined.includes("prompt-00") + "\\n");
				process.stdout.write("HAS_PROMPT_05 " + joined.includes("prompt-05") + "\\n");
				process.stdout.write("HAS_PROMPT_16 " + joined.includes("prompt-16") + "\\n");
				process.stdout.write("HAS_PROMPT_17 " + joined.includes("prompt-17") + "\\n");
				process.stdout.write("HAS_CLEAR_SCREEN " + joined.includes("\\x1b[2J\\x1b[H") + "\\n");
				mode.stop();
				continued.session.dispose();
				rmSync(cwd, { recursive: true, force: true });
				process.exit(0);
			}, 1600);
			await mode.run();
		`;

		const result = await runInteractiveScenario("interactive-continue", scenarioSource, []);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("HAS_PROMPT_00 false");
		expect(result.stdout).toContain("HAS_PROMPT_05 false");
		expect(result.stdout).toContain("HAS_PROMPT_16 false");
		expect(result.stdout).toContain("HAS_PROMPT_17 false");
		expect(result.stdout).toContain("HAS_CLEAR_SCREEN true");
	}, 20_000);

	it("does not replay clipboard transcript lines during startup continue in node runtime", async () => {
		const scenarioSource = `
			import { mkdtempSync, rmSync } from "node:fs";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			import { InteractiveMode } from "@mariozechner/pi-coding-agent";
			import { createTallowSession } from ${JSON.stringify(sdkDistPath)};

			const cwd = mkdtempSync(join(tmpdir(), "node-continue-clipboard-"));
			const first = await createTallowSession({
				cwd,
				startupProfile: "interactive",
				session: { type: "new" },
				noBundledExtensions: true,
				noBundledSkills: true,
			});
			const sessionManager = first.session.sessionManager;
			sessionManager.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: "there's a tallow bug /var/folders/x/T/pi-clipboard-test.png" },
				],
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call1",
						name: "read",
						arguments: { path: "/var/folders/x/T/pi-clipboard-test.png" },
					},
				],
				model: "mock",
				provider: "mock",
				stopReason: "toolUse",
				timestamp: new Date().toISOString(),
				usage: {
					cacheRead: 0,
					cacheWrite: 0,
					cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
					input: 1,
					output: 1,
					totalTokens: 2,
				},
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "call1",
				toolName: "read",
				content: [
					{ type: "text", text: "/var/folders/x/T/pi-clipboard-test.png (PNG, 100x100)" },
				],
				isError: false,
				timestamp: Date.now(),
			});
			first.session.dispose();

			const continued = await createTallowSession({
				cwd,
				startupProfile: "interactive",
				session: { type: "continue" },
				noBundledExtensions: true,
				noBundledSkills: true,
			});
			const mode = new InteractiveMode(continued.runtime, { verbose: false });
			const writes = [];
			const originalWrite = mode.ui.terminal.write.bind(mode.ui.terminal);
			mode.ui.terminal.write = (data) => {
				writes.push(data);
				return originalWrite(data);
			};
			setTimeout(() => {
				const joined = writes.join("");
				process.stdout.write(
					"PATCHED " + (InteractiveMode.prototype.__tallow_stale_ui_patch_applied__ === true) + "\\n"
				);
				process.stdout.write(
					"HAS_CLIPBOARD " + joined.includes("pi-clipboard-test.png") + "\\n"
				);
				mode.stop();
				continued.session.dispose();
				rmSync(cwd, { recursive: true, force: true });
				process.exit(0);
			}, 1800);
			await mode.run();
		`;

		const result = await runInteractiveScenario(
			"interactive-continue-node-clipboard",
			scenarioSource,
			[],
			"node"
		);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("PATCHED true");
		expect(result.stdout).toContain("HAS_CLIPBOARD false");
	}, 20_000);

	it("does not replay transcript lines during resume redraw", async () => {
		const scenarioSource = `
				import { mkdtempSync, rmSync } from "node:fs";
				import { tmpdir } from "node:os";
				import { join } from "node:path";
				import { InteractiveMode } from "@mariozechner/pi-coding-agent";
				import { createTallowSession } from ${JSON.stringify(sdkPath)};
				import { createEchoStreamFn, createMockModel } from ${JSON.stringify(mockModelPath)};

				const cwd = mkdtempSync(join(tmpdir(), "resume-repro-cwd-"));
				const first = await createTallowSession({
					cwd,
					startupProfile: "interactive",
					model: createMockModel(),
					provider: "mock",
					apiKey: "mock-api-key",
					session: { type: "new" },
					noBundledExtensions: true,
					noBundledSkills: true,
				});
				first.session.agent.streamFn = createEchoStreamFn();
				for (let index = 0; index < 18; index += 1) {
					await first.session.prompt("prompt-" + String(index).padStart(2, "0"));
				}
				const sessionPath = first.session.sessionFile;
				if (!sessionPath) throw new Error("missing session file");

				const second = await createTallowSession({
					cwd,
					startupProfile: "interactive",
					model: createMockModel(),
					provider: "mock",
					apiKey: "mock-api-key",
					session: { type: "new" },
					noBundledExtensions: true,
					noBundledSkills: true,
				});
				const mode = new InteractiveMode(second.runtime, { verbose: false });
				const writes = [];
				const originalWrite = mode.ui.terminal.write.bind(mode.ui.terminal);
				mode.ui.terminal.write = (data) => {
					writes.push(data);
					return originalWrite(data);
				};

				setTimeout(async () => {
					process.stdout.write("MARKER: startup_ready\\n");
					writes.length = 0;
					await mode.handleResumeSession(sessionPath);
					setTimeout(() => {
						const joined = writes.join("");
						process.stdout.write("WRITE_COUNT " + writes.length + "\\n");
						process.stdout.write("HAS_PROMPT_00 " + joined.includes("prompt-00") + "\\n");
						process.stdout.write("HAS_PROMPT_05 " + joined.includes("prompt-05") + "\\n");
						process.stdout.write("HAS_PROMPT_16 " + joined.includes("prompt-16") + "\\n");
						process.stdout.write("HAS_PROMPT_17 " + joined.includes("prompt-17") + "\\n");
						process.stdout.write(
							"CRLF_COUNT " + (joined.match(/\\r\\n/g) || []).length + "\\n"
						);
						mode.stop();
						first.session.dispose();
						second.session.dispose();
						rmSync(cwd, { recursive: true, force: true });
						process.exit(0);
					}, 1200);
				}, 800);
				await mode.run();
			`;

		const result = await runInteractiveScenario("interactive-resume", scenarioSource, []);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("HAS_PROMPT_00 false");
		expect(result.stdout).toContain("HAS_PROMPT_05 false");
		expect(result.stdout).toContain("HAS_PROMPT_16 true");
		expect(result.stdout).toContain("HAS_PROMPT_17 true");
	}, 20_000);

	it("does not replay transcript lines when typing after resume", async () => {
		const scenarioSource = `
			import { mkdtempSync, rmSync } from "node:fs";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			import { InteractiveMode } from "@mariozechner/pi-coding-agent";
			import { createTallowSession } from ${JSON.stringify(sdkPath)};
			import { createEchoStreamFn, createMockModel } from ${JSON.stringify(mockModelPath)};

			const cwd = mkdtempSync(join(tmpdir(), "type-after-resume-"));
			const first = await createTallowSession({
				cwd,
				startupProfile: "interactive",
				model: createMockModel(),
				provider: "mock",
				apiKey: "k",
				session: { type: "new" },
				noBundledExtensions: true,
				noBundledSkills: true,
			});
			first.session.agent.streamFn = createEchoStreamFn();
			for (let index = 0; index < 18; index += 1) {
				await first.session.prompt("prompt-" + String(index).padStart(2, "0"));
			}
			const sessionPath = first.session.sessionFile;
			if (!sessionPath) throw new Error("missing session file");

			const second = await createTallowSession({
				cwd,
				startupProfile: "interactive",
				model: createMockModel(),
				provider: "mock",
				apiKey: "k",
				session: { type: "new" },
				noBundledExtensions: true,
				noBundledSkills: true,
			});
			const mode = new InteractiveMode(second.runtime, { verbose: false });
			const writes = [];
			const originalWrite = mode.ui.terminal.write.bind(mode.ui.terminal);
			mode.ui.terminal.write = (data) => {
				writes.push(data);
				return originalWrite(data);
			};
			setTimeout(async () => {
				process.stdout.write("MARKER: startup_ready\\n");
				await mode.handleResumeSession(sessionPath);
				setTimeout(() => {
					writes.length = 0;
					process.stdout.write("MARKER: type_now\\n");
				}, 700);
				setTimeout(() => {
					const joined = writes.join("");
					process.stdout.write("HAS_PROMPT_16 " + joined.includes("prompt-16") + "\\n");
					process.stdout.write("HAS_PROMPT_17 " + joined.includes("prompt-17") + "\\n");
					process.stdout.write("OUTPUT_LEN " + joined.length + "\\n");
					mode.stop();
					first.session.dispose();
					second.session.dispose();
					rmSync(cwd, { recursive: true, force: true });
					process.exit(0);
				}, 2000);
			}, 800);
			await mode.run();
		`;

		const result = await runInteractiveScenario("interactive-resume-type", scenarioSource, [
			{ afterMarker: "MARKER: type_now", data: "x" },
		]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("HAS_PROMPT_16 false");
		expect(result.stdout).toContain("HAS_PROMPT_17 false");
	}, 20_000);
});
