import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginSpec } from "../plugins.js";
import {
	detectPluginFormat,
	extractClaudePluginResources,
	getCachePath,
	isCacheValid,
	isImmutableRef,
	normalizePluginSubpath,
	parsePluginSpec,
	readPluginManifest,
	resolveContainedSubpath,
	resolvePlugin,
	resolvePlugins,
} from "../plugins.js";

// ─── parsePluginSpec ─────────────────────────────────────────────────────────

describe("parsePluginSpec", () => {
	it("should parse a local relative path", () => {
		const spec = parsePluginSpec("./my-plugin");
		expect(spec.isLocal).toBe(true);
		expect(spec.localPath).toContain("my-plugin");
		expect(spec.owner).toBeUndefined();
	});

	it("should parse a local absolute path", () => {
		const spec = parsePluginSpec("/usr/local/plugins/foo");
		expect(spec.isLocal).toBe(true);
		expect(spec.localPath).toBe("/usr/local/plugins/foo");
	});

	it("should parse a tilde path", () => {
		const spec = parsePluginSpec("~/my-plugins/bar");
		expect(spec.isLocal).toBe(true);
		expect(spec.localPath).toBe(path.join(os.homedir(), "my-plugins/bar"));
	});

	it("should parse a parent-relative path", () => {
		const spec = parsePluginSpec("../sibling-project/plugin");
		expect(spec.isLocal).toBe(true);
		expect(spec.localPath).toContain("sibling-project");
	});

	it("should parse github:owner/repo", () => {
		const spec = parsePluginSpec("github:anthropics/claude-code");
		expect(spec.isLocal).toBe(false);
		expect(spec.owner).toBe("anthropics");
		expect(spec.repo).toBe("claude-code");
		expect(spec.subpath).toBe("");
		expect(spec.ref).toBeUndefined();
	});

	it("should parse github:owner/repo@version", () => {
		const spec = parsePluginSpec("github:anthropics/claude-code@v1.0.0");
		expect(spec.isLocal).toBe(false);
		expect(spec.owner).toBe("anthropics");
		expect(spec.repo).toBe("claude-code");
		expect(spec.ref).toBe("v1.0.0");
		expect(spec.subpath).toBe("");
	});

	it("should parse github:owner/repo/subpath@version", () => {
		const spec = parsePluginSpec("github:anthropics/claude-code/plugins/hookify@v0.1.0");
		expect(spec.isLocal).toBe(false);
		expect(spec.owner).toBe("anthropics");
		expect(spec.repo).toBe("claude-code");
		expect(spec.subpath).toBe("plugins/hookify");
		expect(spec.ref).toBe("v0.1.0");
	});

	it("should parse github:owner/repo/subpath without version", () => {
		const spec = parsePluginSpec("github:anthropics/claude-code/plugins/hookify");
		expect(spec.isLocal).toBe(false);
		expect(spec.owner).toBe("anthropics");
		expect(spec.repo).toBe("claude-code");
		expect(spec.subpath).toBe("plugins/hookify");
		expect(spec.ref).toBeUndefined();
	});

	it("should parse a full GitHub URL", () => {
		const spec = parsePluginSpec("https://github.com/anthropics/claude-code");
		expect(spec.isLocal).toBe(false);
		expect(spec.owner).toBe("anthropics");
		expect(spec.repo).toBe("claude-code");
		expect(spec.subpath).toBe("");
		expect(spec.ref).toBeUndefined();
	});

	it("should parse a full GitHub URL with .git suffix", () => {
		const spec = parsePluginSpec("https://github.com/anthropics/claude-code.git");
		expect(spec.isLocal).toBe(false);
		expect(spec.owner).toBe("anthropics");
		expect(spec.repo).toBe("claude-code");
	});

	it("should parse a GitHub URL with tree/ref/subpath", () => {
		const spec = parsePluginSpec(
			"https://github.com/anthropics/claude-code/tree/main/plugins/hookify"
		);
		expect(spec.isLocal).toBe(false);
		expect(spec.owner).toBe("anthropics");
		expect(spec.repo).toBe("claude-code");
		expect(spec.ref).toBe("main");
		expect(spec.subpath).toBe("plugins/hookify");
	});

	it("should reject traversal subpaths in github specs", () => {
		expect(() => parsePluginSpec("github:owner/repo/../../outside@main")).toThrow(
			"path traversal is not allowed"
		);
	});

	it("should reject normalized escape variants", () => {
		expect(() => parsePluginSpec("github:owner/repo/plugins//..//../outside@main")).toThrow(
			"path traversal is not allowed"
		);
	});

	it("should reject absolute subpaths", () => {
		expect(() => parsePluginSpec("github:owner/repo/C:\\windows\\system32@main")).toThrow(
			"absolute paths are not allowed"
		);
	});

	it("should throw on invalid spec", () => {
		expect(() => parsePluginSpec("just-a-name")).toThrow("Invalid plugin spec");
	});

	it("should throw on incomplete github spec", () => {
		expect(() => parsePluginSpec("github:owner")).toThrow("Invalid GitHub plugin spec");
	});

	it("should trim whitespace", () => {
		const spec = parsePluginSpec("  github:owner/repo@v1.0.0  ");
		expect(spec.owner).toBe("owner");
		expect(spec.repo).toBe("repo");
	});
});

// ─── normalizePluginSubpath ─────────────────────────────────────────────────

describe("normalizePluginSubpath", () => {
	it("should normalize nested subpaths", () => {
		expect(normalizePluginSubpath("plugins/hookify")).toBe("plugins/hookify");
		expect(normalizePluginSubpath("plugins\\hookify")).toBe("plugins/hookify");
	});

	it("should reject traversal segments after normalization", () => {
		expect(() => normalizePluginSubpath("plugins/../../outside")).toThrow(
			"path traversal is not allowed"
		);
	});

	it("should reject absolute paths", () => {
		expect(() => normalizePluginSubpath("/etc/passwd")).toThrow("absolute paths are not allowed");
		expect(() => normalizePluginSubpath("C:\\Windows\\System32")).toThrow(
			"absolute paths are not allowed"
		);
	});
});

// ─── resolveContainedSubpath ────────────────────────────────────────────────

describe("resolveContainedSubpath", () => {
	let tmpDir: string;
	let cloneRoot: string;
	let outsideDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-subpath-containment-"));
		cloneRoot = path.join(tmpDir, "clone");
		outsideDir = path.join(tmpDir, "outside");
		fs.mkdirSync(path.join(cloneRoot, "plugins", "hookify"), { recursive: true });
		fs.mkdirSync(outsideDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should resolve valid nested subpaths inside clone root", () => {
		const resolved = resolveContainedSubpath(cloneRoot, "plugins/hookify");
		expect(resolved).toBe(fs.realpathSync(path.join(cloneRoot, "plugins", "hookify")));
	});

	it("should reject lexical traversal escapes", () => {
		expect(() => resolveContainedSubpath(cloneRoot, "../outside")).toThrow(
			"path traversal is not allowed"
		);
	});

	it("should reject symlink-based escapes", () => {
		fs.symlinkSync(outsideDir, path.join(cloneRoot, "plugins", "escape"));
		expect(() => resolveContainedSubpath(cloneRoot, "plugins/escape")).toThrow(
			"escapes repository root"
		);
	});
});

// ─── isImmutableRef ──────────────────────────────────────────────────────────

describe("isImmutableRef", () => {
	it("should identify semver tags", () => {
		expect(isImmutableRef("v1.0.0")).toBe(true);
		expect(isImmutableRef("1.0.0")).toBe(true);
		expect(isImmutableRef("v0.1.0")).toBe(true);
		expect(isImmutableRef("v2.3.4-beta.1")).toBe(true);
	});

	it("should reject non-semver refs", () => {
		expect(isImmutableRef("main")).toBe(false);
		expect(isImmutableRef("develop")).toBe(false);
		expect(isImmutableRef("abc123")).toBe(false);
		expect(isImmutableRef(undefined)).toBe(false);
	});
});

// ─── getCachePath ────────────────────────────────────────────────────────────

describe("getCachePath", () => {
	it("should generate a cache path for repo root", () => {
		const spec = parsePluginSpec("github:owner/repo@v1.0.0");
		const cachePath = getCachePath(spec);
		expect(cachePath).toContain("owner--repo");
		expect(cachePath).toContain("@v1.0.0");
	});

	it("should include subpath in cache path", () => {
		const spec = parsePluginSpec("github:owner/repo/plugins/foo@v1.0.0");
		const cachePath = getCachePath(spec);
		expect(cachePath).toContain("owner--repo--plugins--foo");
		expect(cachePath).toContain("@v1.0.0");
	});

	it("should use @default for specs without ref", () => {
		const spec = parsePluginSpec("github:owner/repo");
		const cachePath = getCachePath(spec);
		expect(cachePath).toContain("@default");
	});

	it("should throw for local specs", () => {
		const spec = parsePluginSpec("./local-plugin");
		expect(() => getCachePath(spec)).toThrow("Local plugins are not cached");
	});

	it("should reject traversal in pre-parsed remote specs", () => {
		const spec: PluginSpec = {
			raw: "github:owner/repo/../../outside@main",
			isLocal: false,
			owner: "owner",
			repo: "repo",
			subpath: "../../outside",
			ref: "main",
		};

		expect(() => getCachePath(spec)).toThrow("path traversal is not allowed");
	});
});

// ─── detectPluginFormat ──────────────────────────────────────────────────────

describe("detectPluginFormat", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-format-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should detect Claude Code plugin format", () => {
		fs.mkdirSync(path.join(tmpDir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "test", version: "1.0.0" })
		);

		expect(detectPluginFormat(tmpDir)).toBe("claude-code");
	});

	it("should detect tallow extension format", () => {
		fs.writeFileSync(
			path.join(tmpDir, "extension.json"),
			JSON.stringify({ name: "test", version: "0.1.0" })
		);

		expect(detectPluginFormat(tmpDir)).toBe("tallow-extension");
	});

	it("should return unknown for unrecognized format", () => {
		expect(detectPluginFormat(tmpDir)).toBe("unknown");
	});

	it("should prefer claude-code if both formats present", () => {
		fs.mkdirSync(path.join(tmpDir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "test" })
		);
		fs.writeFileSync(path.join(tmpDir, "extension.json"), JSON.stringify({ name: "test" }));

		expect(detectPluginFormat(tmpDir)).toBe("claude-code");
	});
});

// ─── readPluginManifest ──────────────────────────────────────────────────────

describe("readPluginManifest", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-manifest-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should read a Claude Code plugin manifest", () => {
		fs.mkdirSync(path.join(tmpDir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".claude-plugin", "plugin.json"),
			JSON.stringify({
				name: "hookify",
				version: "0.1.0",
				description: "Custom hooks",
				author: { name: "Test Author" },
			})
		);

		const manifest = readPluginManifest(tmpDir, "claude-code");
		expect(manifest).not.toBeNull();
		expect(manifest?.name).toBe("hookify");
		expect(manifest?.version).toBe("0.1.0");
	});

	it("should read a tallow extension manifest", () => {
		fs.writeFileSync(
			path.join(tmpDir, "extension.json"),
			JSON.stringify({
				name: "my-tool",
				version: "0.2.0",
				description: "A custom tool",
				category: "tool",
			})
		);

		const manifest = readPluginManifest(tmpDir, "tallow-extension");
		expect(manifest).not.toBeNull();
		expect(manifest?.name).toBe("my-tool");
	});

	it("should return null for unknown format", () => {
		expect(readPluginManifest(tmpDir, "unknown")).toBeNull();
	});

	it("should return null for corrupt JSON", () => {
		fs.mkdirSync(path.join(tmpDir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, ".claude-plugin", "plugin.json"), "not json{{{");

		expect(readPluginManifest(tmpDir, "claude-code")).toBeNull();
	});
});

// ─── extractClaudePluginResources ────────────────────────────────────────────

describe("extractClaudePluginResources", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-resources-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should extract skill paths from skills/ directory", () => {
		fs.mkdirSync(path.join(tmpDir, "skills", "code-review"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "skills", "code-review", "SKILL.md"),
			"---\ndescription: Review code\n---\nReview the code."
		);

		const resources = extractClaudePluginResources(tmpDir);
		expect(resources.skillPaths).toHaveLength(1);
		expect(resources.skillPaths[0]).toContain("SKILL.md");
	});

	it("should fall back to directory path without SKILL.md", () => {
		fs.mkdirSync(path.join(tmpDir, "skills", "raw-skill"), { recursive: true });

		const resources = extractClaudePluginResources(tmpDir);
		expect(resources.skillPaths).toHaveLength(1);
		expect(resources.skillPaths[0]).toContain("raw-skill");
		expect(resources.skillPaths[0]).not.toContain("SKILL.md");
	});

	it("should detect commands/ directory", () => {
		fs.mkdirSync(path.join(tmpDir, "commands"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "commands", "hello.md"), "# Hello");

		const resources = extractClaudePluginResources(tmpDir);
		expect(resources.commandsDir).toBe(path.join(tmpDir, "commands"));
	});

	it("should detect agents/ directory", () => {
		fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "agents", "reviewer.md"), "# Reviewer");

		const resources = extractClaudePluginResources(tmpDir);
		expect(resources.agentsDir).toBe(path.join(tmpDir, "agents"));
	});

	it("should return empty when no resources exist", () => {
		const resources = extractClaudePluginResources(tmpDir);
		expect(resources.skillPaths).toHaveLength(0);
		expect(resources.commandsDir).toBeUndefined();
		expect(resources.agentsDir).toBeUndefined();
	});

	it("should skip dot-prefixed entries in skills/", () => {
		fs.mkdirSync(path.join(tmpDir, "skills", ".hidden"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "skills", "visible"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "skills", "visible", "SKILL.md"),
			"---\ndescription: v\n---\n"
		);

		const resources = extractClaudePluginResources(tmpDir);
		expect(resources.skillPaths).toHaveLength(1);
		expect(resources.skillPaths[0]).toContain("visible");
	});
});

// ─── isCacheValid ────────────────────────────────────────────────────────────

describe("isCacheValid", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-valid-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should return false when no metadata file exists", () => {
		const spec = parsePluginSpec("github:owner/repo@v1.0.0");
		expect(isCacheValid(tmpDir, spec)).toBe(false);
	});

	it("should return true for immutable cache entries", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".tallow-plugin-cache.json"),
			JSON.stringify({
				spec: "github:owner/repo@v1.0.0",
				cachedAt: new Date(2020, 0, 1).toISOString(),
				immutable: true,
			})
		);

		const spec = parsePluginSpec("github:owner/repo@v1.0.0");
		expect(isCacheValid(tmpDir, spec)).toBe(true);
	});

	it("should return true for fresh mutable cache entries", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".tallow-plugin-cache.json"),
			JSON.stringify({
				spec: "github:owner/repo",
				cachedAt: new Date().toISOString(),
				immutable: false,
			})
		);

		const spec = parsePluginSpec("github:owner/repo");
		expect(isCacheValid(tmpDir, spec)).toBe(true);
	});

	it("should return false for expired mutable cache entries", () => {
		const expired = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
		fs.writeFileSync(
			path.join(tmpDir, ".tallow-plugin-cache.json"),
			JSON.stringify({
				spec: "github:owner/repo",
				cachedAt: expired.toISOString(),
				immutable: false,
			})
		);

		const spec = parsePluginSpec("github:owner/repo");
		expect(isCacheValid(tmpDir, spec)).toBe(false);
	});

	it("should return false for corrupt metadata", () => {
		fs.writeFileSync(path.join(tmpDir, ".tallow-plugin-cache.json"), "not json");

		const spec = parsePluginSpec("github:owner/repo@v1.0.0");
		expect(isCacheValid(tmpDir, spec)).toBe(false);
	});
});

// ─── resolvePlugin (local) ──────────────────────────────────────────────────

describe("resolvePlugin (local)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-plugin-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should resolve a local Claude Code plugin", () => {
		fs.mkdirSync(path.join(tmpDir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "test-plugin", version: "1.0.0" })
		);

		const result = resolvePlugin(tmpDir);
		expect(result.format).toBe("claude-code");
		expect(result.path).toBe(tmpDir);
		expect(result.cached).toBe(false);
		expect(result.manifest?.name).toBe("test-plugin");
	});

	it("should resolve a local tallow extension", () => {
		fs.writeFileSync(
			path.join(tmpDir, "extension.json"),
			JSON.stringify({ name: "my-ext", version: "0.1.0" })
		);

		const result = resolvePlugin(tmpDir);
		expect(result.format).toBe("tallow-extension");
		expect(result.cached).toBe(false);
	});

	it("should throw for non-existent local path", () => {
		expect(() => resolvePlugin("/nonexistent/path/xyz")).toThrow("not found");
	});

	it("should throw if local path is a file, not directory", () => {
		const filePath = path.join(tmpDir, "not-a-dir");
		fs.writeFileSync(filePath, "");

		expect(() => resolvePlugin(filePath)).toThrow("not a directory");
	});
});

// ─── resolvePlugins (batch) ──────────────────────────────────────────────────

describe("resolvePlugins (batch)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-resolve-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should resolve multiple local plugins", () => {
		const dir1 = path.join(tmpDir, "plugin-a");
		const dir2 = path.join(tmpDir, "plugin-b");

		fs.mkdirSync(path.join(dir1, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(dir1, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "a" })
		);

		fs.mkdirSync(dir2, { recursive: true });
		fs.writeFileSync(path.join(dir2, "extension.json"), JSON.stringify({ name: "b" }));

		const result = resolvePlugins([dir1, dir2]);
		expect(result.resolved).toHaveLength(2);
		expect(result.errors).toHaveLength(0);
	});

	it("should continue past individual failures", () => {
		const validDir = path.join(tmpDir, "valid");
		fs.mkdirSync(path.join(validDir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(validDir, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "valid" })
		);

		const result = resolvePlugins(["/nonexistent", validDir]);
		expect(result.resolved).toHaveLength(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].spec).toBe("/nonexistent");
	});

	it("should handle empty spec array", () => {
		const result = resolvePlugins([]);
		expect(result.resolved).toHaveLength(0);
		expect(result.errors).toHaveLength(0);
	});
});
