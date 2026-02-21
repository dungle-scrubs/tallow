import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../cli.ts");

/**
 * Run the CLI entrypoint in a child process and capture outputs.
 *
 * @param args - CLI arguments (excluding executable)
 * @returns Process exit code with captured stdout/stderr
 */
function runCli(args: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
	return new Promise((resolve) => {
		const child = spawn("bun", [CLI, ...args], {
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("close", (code) => {
			resolve({ code, stderr, stdout });
		});
	});
}

describe("CLI extensions commands", () => {
	test("--extensions-only requires at least one --extension selector", async () => {
		const result = await runCli(["--extensions-only", "--no-session"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--extensions-only requires at least one --extension selector");
	});

	test("--extensions-only cannot be combined with --no-extensions", async () => {
		const result = await runCli([
			"--extensions-only",
			"--extension",
			"clear",
			"--no-extensions",
			"--no-session",
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--no-extensions cannot be combined with --extensions-only");
	});

	test("`tallow extensions` prints table-style catalog output", async () => {
		const result = await runCli(["extensions"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Bundled extensions");
		expect(result.stdout).toContain("ID");
		expect(result.stdout).toContain("CATEGORY");
		expect(result.stdout).toContain("DESCRIPTION");
	});

	test("`tallow extensions --json` prints a JSON catalog", async () => {
		const result = await runCli(["extensions", "--json"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.stdout) as Array<{ id: string }>;
		expect(parsed.length).toBeGreaterThan(0);
		expect(parsed.some((entry) => entry.id === "clear")).toBe(true);
	});

	test("`tallow extensions <id>` prints full detail output", async () => {
		const result = await runCli(["extensions", "clear"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("clear");
		expect(result.stdout).toContain("When to use:");
		expect(result.stdout).toContain("Permission filesystem:");
	});

	test("`tallow extensions <id> --json` prints a single extension entry", async () => {
		const result = await runCli(["extensions", "clear", "--json"]);

		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout) as { id: string; path: string };
		expect(parsed.id).toBe("clear");
		expect(parsed.path).toContain("/extensions/clear");
	});

	test("unknown extension IDs return a clear error", async () => {
		const result = await runCli(["extensions", "not-a-real-extension"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Unknown extension ID");
	});
});
