import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiagnosticInput, runDiagnostics } from "../index.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `health-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a default DiagnosticInput with sensible defaults.
 * Override specific fields as needed.
 *
 * @param overrides - Partial overrides
 * @returns Complete DiagnosticInput
 */
function makeInput(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
	return {
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4",
			name: "Sonnet",
			contextWindow: 200000,
			maxTokens: 8192,
			reasoning: false,
			thinkingLevel: "off",
			input: ["text"],
		},
		context: { tokens: 5000, contextWindow: 200000, percent: 2.5, status: "OK" },
		tools: { activeCount: 10, totalCount: 15, activeNames: ["read", "bash", "edit"] },
		environment: {
			tallowVersion: "0.2.0",
			piVersion: "0.52.12",
			nodeVersion: "v22.0.0",
			platform: "darwin/arm64",
			tallowHome: tmpDir,
			packageDir: "/tmp/pkg",
		},
		tallowHome: tmpDir,
		cwd: tmpDir,
		...overrides,
	};
}

describe("runDiagnostics", () => {
	test("passes all checks for healthy configuration", () => {
		// Create auth.json and AGENTS.md
		writeFileSync(join(tmpDir, "auth.json"), JSON.stringify({ anthropic: { apiKey: "sk-..." } }));
		writeFileSync(join(tmpDir, "AGENTS.md"), "# Agents");

		const checks = runDiagnostics(makeInput());
		const statuses = checks.map((c) => c.status);
		expect(statuses.every((s) => s === "pass")).toBe(true);
	});

	test("fails model check when provider is unknown", () => {
		const checks = runDiagnostics(
			makeInput({
				model: {
					provider: "unknown",
					id: "unknown",
					name: "unknown",
					contextWindow: 0,
					maxTokens: 0,
					reasoning: false,
					thinkingLevel: "off",
					input: ["text"],
				},
			})
		);
		const modelCheck = checks.find((c) => c.name === "Model");
		expect(modelCheck?.status).toBe("fail");
	});

	test("warns on missing auth for provider", () => {
		// No auth.json at all
		const checks = runDiagnostics(makeInput());
		const authCheck = checks.find((c) => c.name === "Auth");
		expect(authCheck?.status).toBe("warn");
	});

	test("warns on corrupt auth.json", () => {
		writeFileSync(join(tmpDir, "auth.json"), "NOT JSON{{{");
		const checks = runDiagnostics(makeInput());
		const authCheck = checks.find((c) => c.name === "Auth");
		expect(authCheck?.status).toBe("warn");
		expect(authCheck?.message).toContain("corrupt");
	});

	test("fails context check when critical", () => {
		const checks = runDiagnostics(
			makeInput({
				context: { tokens: 170000, contextWindow: 200000, percent: 85, status: "Critical" },
			})
		);
		const ctxCheck = checks.find((c) => c.name === "Context");
		expect(ctxCheck?.status).toBe("fail");
	});

	test("warns context when in warning range", () => {
		const checks = runDiagnostics(
			makeInput({
				context: { tokens: 120000, contextWindow: 200000, percent: 60, status: "Warning" },
			})
		);
		const ctxCheck = checks.find((c) => c.name === "Context");
		expect(ctxCheck?.status).toBe("warn");
	});

	test("fails when no tools are active", () => {
		const checks = runDiagnostics(
			makeInput({ tools: { activeCount: 0, totalCount: 15, activeNames: [] } })
		);
		const toolsCheck = checks.find((c) => c.name === "Tools");
		expect(toolsCheck?.status).toBe("fail");
	});

	test("fails settings check when JSON is invalid", () => {
		writeFileSync(join(tmpDir, "settings.json"), "BROKEN{{{");
		const checks = runDiagnostics(makeInput());
		const settingsCheck = checks.find((c) => c.name === "Settings");
		expect(settingsCheck?.status).toBe("fail");
	});

	test("warns when no project context files exist", () => {
		const checks = runDiagnostics(makeInput());
		const ctxCheck = checks.find((c) => c.name === "Project context");
		expect(ctxCheck?.status).toBe("warn");
	});

	test("passes project context when CLAUDE.md exists", () => {
		writeFileSync(join(tmpDir, "CLAUDE.md"), "# Project");
		const checks = runDiagnostics(makeInput());
		const ctxCheck = checks.find((c) => c.name === "Project context");
		expect(ctxCheck?.status).toBe("pass");
	});
});
