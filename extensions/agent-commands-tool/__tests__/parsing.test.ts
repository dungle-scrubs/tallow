/**
 * Tests for agent-commands-tool pure functions:
 * parseAgent, computeEffectiveTools, resolvePath, and loadAgentsFromDir.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
	computeEffectiveTools,
	getPluginAgentDirsFromEnv,
	loadAgentsFromDir,
	PI_BUILTIN_TOOLS,
	parseAgent,
	resolvePath,
} from "../index.js";

// ── parseAgent ───────────────────────────────────────────────────────────────

describe("parseAgent", () => {
	it("extracts frontmatter and body from valid markdown", () => {
		const content = `---
name: planner
description: Plans things
model: claude-sonnet-4-5
---
You are a planning agent.`;

		const { frontmatter, body } = parseAgent(content);
		expect(frontmatter.name).toBe("planner");
		expect(frontmatter.description).toBe("Plans things");
		expect(frontmatter.model).toBe("claude-sonnet-4-5");
		expect(body).toBe("You are a planning agent.");
	});

	it("returns empty frontmatter when no frontmatter block", () => {
		const content = "Just a plain markdown body.";
		const { frontmatter, body } = parseAgent(content);
		expect(Object.keys(frontmatter)).toHaveLength(0);
		expect(body).toBe(content);
	});

	it("handles empty body after frontmatter", () => {
		const content = "---\nname: test\ndescription: desc\n---\n";
		const { frontmatter, body } = parseAgent(content);
		expect(frontmatter.name).toBe("test");
		expect(body).toBe("");
	});

	it("converts boolean-like string values", () => {
		const content = "---\nname: agent\ndescription: desc\nenabled: true\ndisabled: false\n---\n";
		const { frontmatter } = parseAgent(content);
		expect(frontmatter.enabled).toBe(true);
		expect(frontmatter.disabled).toBe(false);
	});

	it("handles comma-separated tools list", () => {
		const content = "---\nname: agent\ndescription: desc\ntools: read,bash,edit\n---\n";
		const { frontmatter } = parseAgent(content);
		expect(frontmatter.tools).toBe("read,bash,edit");
	});

	it("handles multi-line body content", () => {
		const content = "---\nname: test\ndescription: desc\n---\nLine 1\n\nLine 2\nLine 3";
		const { body } = parseAgent(content);
		expect(body).toContain("Line 1");
		expect(body).toContain("Line 2");
		expect(body).toContain("Line 3");
	});

	it("handles colons in frontmatter values", () => {
		const content = "---\nname: agent\ndescription: A: complex description\n---\n";
		const { frontmatter } = parseAgent(content);
		expect(frontmatter.description).toBe("A: complex description");
	});
});

// ── computeEffectiveTools ────────────────────────────────────────────────────

describe("computeEffectiveTools", () => {
	it("returns undefined when both are undefined", () => {
		expect(computeEffectiveTools(undefined, undefined)).toBeUndefined();
	});

	it("returns tools as-is when no disallowed tools", () => {
		const tools = ["read", "bash"];
		expect(computeEffectiveTools(tools, undefined)).toEqual(["read", "bash"]);
	});

	it("filters disallowed from built-in tools when no explicit tools", () => {
		const result = computeEffectiveTools(undefined, ["bash", "write"]);
		expect(result).toBeDefined();
		expect(result).not.toContain("bash");
		expect(result).not.toContain("write");
		expect(result).toContain("read");
		expect(result).toContain("edit");
	});

	it("filters disallowed from explicit tools when both provided", () => {
		const result = computeEffectiveTools(["read", "bash", "edit", "write"], ["bash", "write"]);
		expect(result).toEqual(["read", "edit"]);
	});

	it("returns empty array when all tools are disallowed", () => {
		const result = computeEffectiveTools(["bash"], ["bash"]);
		expect(result).toEqual([]);
	});

	it("handles empty arrays", () => {
		expect(computeEffectiveTools([], undefined)).toEqual([]);
		expect(computeEffectiveTools(undefined, [])).toEqual(PI_BUILTIN_TOOLS);
	});
});

// ── resolvePath ──────────────────────────────────────────────────────────────

describe("resolvePath", () => {
	it("resolves ~ to home directory", () => {
		expect(resolvePath("~")).toBe(homedir());
	});

	it("resolves ~/path to home + path", () => {
		expect(resolvePath("~/projects/test")).toBe(join(homedir(), "projects/test"));
	});

	it("keeps absolute paths unchanged", () => {
		expect(resolvePath("/usr/local/bin")).toBe("/usr/local/bin");
	});

	it("resolves relative paths against cwd", () => {
		const result = resolvePath("relative/path");
		expect(result).toBe(resolve("relative/path"));
	});

	it("trims whitespace", () => {
		expect(resolvePath("  ~  ")).toBe(homedir());
	});
});

// ── getPluginAgentDirsFromEnv ───────────────────────────────────────────────

describe("getPluginAgentDirsFromEnv", () => {
	it("returns empty array for empty input", () => {
		expect(getPluginAgentDirsFromEnv("")).toEqual([]);
		expect(getPluginAgentDirsFromEnv(undefined)).toEqual([]);
	});

	it("parses existing directories with platform delimiter", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-plugin-dirs-"));
		try {
			const a = join(root, "plugin-a", "agents");
			const b = join(root, "plugin-b", "agents");
			mkdirSync(a, { recursive: true });
			mkdirSync(b, { recursive: true });

			const dirs = getPluginAgentDirsFromEnv(`${a}${delimiter}${b}`);
			expect(dirs).toEqual([resolve(a), resolve(b)]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("deduplicates and skips missing directories", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-plugin-dirs-"));
		try {
			const a = join(root, "plugin-a", "agents");
			mkdirSync(a, { recursive: true });
			const missing = join(root, "missing", "agents");

			const dirs = getPluginAgentDirsFromEnv(`${a}${delimiter}${missing}${delimiter}${a}`);
			expect(dirs).toEqual([resolve(a)]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ── loadAgentsFromDir ────────────────────────────────────────────────────────

describe("loadAgentsFromDir", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	it("returns empty array for nonexistent directory", () => {
		expect(loadAgentsFromDir("/nonexistent/path/agents")).toEqual([]);
	});

	it("returns empty array for empty directory", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
		expect(loadAgentsFromDir(tmpDir)).toEqual([]);
	});

	it("ignores non-.md files", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
		writeFileSync(join(tmpDir, "notes.txt"), "not an agent");
		writeFileSync(join(tmpDir, "config.json"), "{}");
		expect(loadAgentsFromDir(tmpDir)).toEqual([]);
	});

	it("skips .md files without name and description", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
		writeFileSync(join(tmpDir, "incomplete.md"), "---\nname: only-name\n---\nBody");
		expect(loadAgentsFromDir(tmpDir)).toEqual([]);
	});

	it("loads valid agent from .md file", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
		const agentContent = `---
name: test-agent
description: A test agent
model: claude-sonnet-4-5
---
You are a test agent.`;
		writeFileSync(join(tmpDir, "test-agent.md"), agentContent);

		const agents = loadAgentsFromDir(tmpDir);
		expect(agents).toHaveLength(1);
		expect(agents[0].name).toBe("test-agent");
		expect(agents[0].description).toBe("A test agent");
		expect(agents[0].model).toBe("claude-sonnet-4-5");
		expect(agents[0].systemPrompt).toBe("You are a test agent.");
	});

	it("parses tools from comma-separated string", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
		const content = "---\nname: tooled\ndescription: Has tools\ntools: read,bash,edit\n---\n";
		writeFileSync(join(tmpDir, "tooled.md"), content);

		const agents = loadAgentsFromDir(tmpDir);
		expect(agents[0].tools).toEqual(["read", "bash", "edit"]);
	});

	it("parses disallowedTools from comma-separated string", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
		const content =
			"---\nname: restricted\ndescription: Restricted agent\ndisallowedTools: bash,write\n---\n";
		writeFileSync(join(tmpDir, "restricted.md"), content);

		const agents = loadAgentsFromDir(tmpDir);
		expect(agents[0].disallowedTools).toEqual(["bash", "write"]);
	});

	it("parses maxTurns as number", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
		const content = "---\nname: limited\ndescription: Limited turns\nmaxTurns: 5\n---\nDo things.";
		writeFileSync(join(tmpDir, "limited.md"), content);

		const agents = loadAgentsFromDir(tmpDir);
		expect(agents[0].maxTurns).toBe(5);
	});

	it("loads multiple agents from directory", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
		writeFileSync(join(tmpDir, "a.md"), "---\nname: alpha\ndescription: First\n---\nAlpha prompt");
		writeFileSync(join(tmpDir, "b.md"), "---\nname: beta\ndescription: Second\n---\nBeta prompt");

		const agents = loadAgentsFromDir(tmpDir);
		expect(agents).toHaveLength(2);
		const names = agents.map((a) => a.name);
		expect(names).toContain("alpha");
		expect(names).toContain("beta");
	});

	it("handles files with read errors gracefully", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
		// Create a subdirectory with .md extension — readFileSync will fail
		mkdirSync(join(tmpDir, "not-a-file.md"));
		writeFileSync(join(tmpDir, "valid.md"), "---\nname: works\ndescription: Valid\n---\nBody");

		const agents = loadAgentsFromDir(tmpDir);
		expect(agents).toHaveLength(1);
		expect(agents[0].name).toBe("works");
	});
});
