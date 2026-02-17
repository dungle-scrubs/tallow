/**
 * Permission engine — Claude Code-compatible `Tool(specifier)` rule system.
 *
 * Stateless, standalone module that parses permission rules from config,
 * matches them against tool invocations, and returns verdicts.
 *
 * Rule format: `Tool(specifier)` or bare `Tool` (matches all uses).
 * Three-tier evaluation: deny → ask → allow → default.
 *
 * Supports Claude Code's gitignore-style path conventions (`//`, `~/`, `/`, `./`)
 * and tallow's `{cwd}`, `{home}`, `{project}` variable expansion.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { stripQuotedContent } from "./shell-policy.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A raw string from config, e.g. `"Bash(npm *)"`. */
export type PermissionRuleEntry = string;

/** Parsed representation of a permission rule. */
export interface ParsedRule {
	/** Normalized tool name (lowercase/snake_case). */
	readonly tool: string;
	/** Content inside parens, or null for bare tool names. */
	readonly specifier: string | null;
	/** Original raw rule string for diagnostics. */
	readonly raw: string;
}

/** Merged permission config with parsed rules in each tier. */
export interface PermissionConfig {
	readonly allow: readonly ParsedRule[];
	readonly deny: readonly ParsedRule[];
	readonly ask: readonly ParsedRule[];
}

/** Verdict actions for permission evaluation. */
export type PermissionAction = "allow" | "deny" | "ask" | "default";

/** Result of evaluating a tool invocation against permission rules. */
export interface PermissionVerdict {
	/** Whether the tool invocation is permitted. */
	readonly allowed: boolean;
	/** Which tier produced the verdict. */
	readonly action: PermissionAction;
	/** Human-readable reason for the verdict. */
	readonly reason?: string;
	/** The raw rule string that matched, if any. */
	readonly matchedRule?: string;
}

/** Variables for expanding `{cwd}`, `{home}`, `{project}` in patterns. */
export interface ExpansionVars {
	readonly cwd: string;
	readonly home: string;
	readonly project: string;
}

/** Source metadata for a loaded permission config tier. */
export interface PermissionSource {
	readonly path: string;
	readonly tier: "cli" | "project-local" | "project-shared" | "user";
	readonly config: PermissionConfig;
}

/** Complete loaded permission state from all sources. */
export interface LoadedPermissions {
	/** Merged config across all tiers (deny → ask → allow → default). */
	readonly merged: PermissionConfig;
	/** Individual sources for diagnostics. */
	readonly sources: readonly PermissionSource[];
}

// ── Tool Name Mapping ────────────────────────────────────────────────────────

/**
 * Claude Code PascalCase → tallow snake_case tool name mapping.
 * Keys are lowercase for case-insensitive lookup.
 */
const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
	bash: "bash",
	read: "read",
	edit: "edit",
	write: "write",
	webfetch: "web_fetch",
	web_fetch: "web_fetch",
	task: "subagent",
	subagent: "subagent",
	cd: "cd",
	ls: "ls",
	find: "find",
	grep: "grep",
};

/**
 * Normalize a tool name from Claude Code or tallow casing to canonical form.
 *
 * @param name - Tool name in any casing (e.g. `Bash`, `WebFetch`, `bash`)
 * @returns Canonical snake_case name
 */
export function normalizeToolName(name: string): string {
	const lower = name.toLowerCase();
	return TOOL_NAME_MAP[lower] ?? lower;
}

// ── Rule Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a raw rule string like `"Bash(npm *)"` into a structured `ParsedRule`.
 *
 * @param raw - Raw rule string from config
 * @returns Parsed rule with normalized tool name and specifier
 * @throws {Error} When rule format is invalid (empty, missing tool name, unclosed paren)
 */
export function parseRule(raw: string): ParsedRule {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		throw new Error(`Invalid permission rule: empty or non-string value`);
	}

	const trimmed = raw.trim();

	// Check for missing tool name: starts with `(`
	if (trimmed.startsWith("(")) {
		throw new Error(`Invalid permission rule: missing tool name in "${trimmed}"`);
	}

	// Check for unclosed paren
	const openParen = trimmed.indexOf("(");
	if (openParen !== -1) {
		const closeParen = trimmed.lastIndexOf(")");
		if (closeParen === -1 || closeParen < openParen) {
			throw new Error(`Invalid permission rule: unclosed parenthesis in "${trimmed}"`);
		}

		const toolName = trimmed.slice(0, openParen);
		const specifier = trimmed.slice(openParen + 1, closeParen);

		// Empty parens = match all (same as bare tool name)
		const normalizedSpecifier = specifier.length === 0 ? null : specifier;

		return {
			tool: normalizeToolName(toolName),
			specifier: normalizedSpecifier,
			raw: trimmed,
		};
	}

	// Bare tool name (no parens) — matches all uses
	return {
		tool: normalizeToolName(trimmed),
		specifier: null,
		raw: trimmed,
	};
}

/**
 * Safely parse an array of rule entries, skipping invalid entries with warnings.
 *
 * @param entries - Raw rule entries from config (may contain non-strings)
 * @param warnings - Array to append warning messages to
 * @returns Array of successfully parsed rules
 */
export function parseRules(entries: unknown[], warnings: string[]): ParsedRule[] {
	const rules: ParsedRule[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") {
			warnings.push(`Skipping non-string permission rule: ${JSON.stringify(entry)}`);
			continue;
		}
		try {
			rules.push(parseRule(entry));
		} catch (err) {
			warnings.push(err instanceof Error ? err.message : String(err));
		}
	}
	return rules;
}

// ── Variable Expansion ───────────────────────────────────────────────────────

/**
 * Expand `{cwd}`, `{home}`, `{project}` placeholders in a pattern string.
 * Unknown variables are left as-is (no expansion, no crash).
 *
 * @param pattern - Pattern string with possible `{var}` placeholders
 * @param vars - Variable values to substitute
 * @returns Pattern with known variables expanded
 */
export function expandVariables(pattern: string, vars: ExpansionVars): string {
	return pattern
		.replace(/\{cwd\}/g, vars.cwd)
		.replace(/\{home\}/g, vars.home)
		.replace(/\{project\}/g, vars.project);
}

// ── Path Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve gitignore-style path prefixes and variable expansion to absolute glob patterns.
 *
 * | Prefix | Meaning |
 * |--------|---------|
 * | `//`   | Absolute from filesystem root |
 * | `~/`   | Relative to home directory |
 * | `/`    | Relative to settings file directory |
 * | `./` or bare | Relative to cwd |
 *
 * Prefix conventions are checked on the **original** specifier before variable
 * expansion. This prevents ambiguity: `/src/**` always means "settings-relative",
 * while `{cwd}/src/**` expands to an absolute path that's used as-is.
 *
 * @param specifier - Path specifier from a rule
 * @param settingsDir - Directory containing the settings file that defined this rule
 * @param vars - Variable expansion context
 * @returns Absolute glob pattern
 */
export function resolvePathSpecifier(
	specifier: string,
	settingsDir: string,
	vars: ExpansionVars
): string {
	// Check prefix conventions on the ORIGINAL specifier (before variable expansion)
	// to avoid ambiguity between `/path` (settings-relative) and expanded absolute paths.

	// // = absolute from filesystem root
	if (specifier.startsWith("//")) {
		return expandVariables(specifier.slice(1), vars);
	}

	// ~/ = relative to home
	if (specifier.startsWith("~/")) {
		return join(vars.home, expandVariables(specifier.slice(2), vars));
	}

	// ./ = relative to cwd
	if (specifier.startsWith("./")) {
		return join(vars.cwd, expandVariables(specifier.slice(2), vars));
	}

	// / = relative to settings file directory (NOT filesystem root)
	if (specifier.startsWith("/")) {
		return join(settingsDir, expandVariables(specifier.slice(1), vars));
	}

	// Variable expansion for remaining patterns
	const expanded = expandVariables(specifier, vars);

	// If expansion produced an absolute path (e.g. {cwd}/src/**), use as-is
	if (isAbsolute(expanded)) {
		return expanded;
	}

	// Bare path = relative to cwd
	return join(vars.cwd, expanded);
}

/**
 * Canonicalize a file path for permission matching.
 * Resolves symlinks via realpathSync, falling back to normalize+resolve for
 * nonexistent files (common for write operations).
 *
 * @param filePath - Path to canonicalize
 * @param cwd - Working directory for relative path resolution
 * @returns Canonicalized absolute path
 */
export function canonicalizePath(filePath: string, cwd: string): string {
	const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	try {
		return realpathSync(absolute);
	} catch {
		// File doesn't exist yet (common for write) — normalize only
		return normalize(absolute);
	}
}

// ── Glob Matching ────────────────────────────────────────────────────────────

/**
 * Convert a glob pattern with `*` and `**` to a regular expression.
 *
 * - `*` matches any character except `/` (single directory level)
 * - `**` matches any character including `/` (recursive)
 * - `?` matches a single non-`/` character
 * - All other characters are escaped for literal matching
 *
 * @param pattern - Glob pattern
 * @returns Regular expression that implements the glob semantics
 */
export function globToRegExp(pattern: string): RegExp {
	let result = "";
	let i = 0;

	while (i < pattern.length) {
		const char = pattern[i];

		if (char === "*") {
			if (pattern[i + 1] === "*") {
				// ** — match anything including path separators
				// Handle **/ at start or middle (match zero or more path segments)
				if (pattern[i + 2] === "/") {
					result += "(?:.*/)?";
					i += 3;
				} else {
					result += ".*";
					i += 2;
				}
			} else {
				// * — match anything except path separator
				result += "[^/]*";
				i++;
			}
		} else if (char === "?") {
			result += "[^/]";
			i++;
		} else if ("\\^$.|+()[]{}".includes(char ?? "")) {
			result += `\\${char}`;
			i++;
		} else {
			result += char;
			i++;
		}
	}

	return new RegExp(`^${result}$`);
}

/**
 * Match a file path against a resolved glob pattern.
 *
 * @param filePath - Canonicalized absolute file path
 * @param resolvedPattern - Absolute glob pattern (after resolvePathSpecifier)
 * @returns True when the path matches the pattern
 */
export function matchPathRule(filePath: string, resolvedPattern: string): boolean {
	const regex = globToRegExp(resolvedPattern);
	return regex.test(filePath);
}

// ── Shell Command Matching ───────────────────────────────────────────────────

/** Shell operators that delimit independent command segments. */
const SHELL_OPERATORS = /&&|\|\||[;\n|]/;

/** Characters that indicate shell grouping (stripped from segment edges). */
const SHELL_GROUPING = /^[({}\s]+|[)}\s]+$/g;

/**
 * Strip null bytes and control characters from command text.
 *
 * @param command - Raw command text
 * @returns Cleaned command text
 */
function stripControlChars(command: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
	return command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/**
 * Strip only single and double quotes, preserving backtick content.
 * Used for deny/ask matching where command substitution content must remain
 * visible for pattern matching.
 *
 * @param command - Raw command text
 * @returns Command with single/double quoted content replaced by spaces
 */
function stripSingleDoubleQuotes(command: string): string {
	let activeQuote: "'" | '"' | undefined;
	let escaped = false;
	let output = "";

	for (const char of command) {
		if (activeQuote) {
			if (activeQuote !== "'" && char === "\\" && !escaped) {
				escaped = true;
				output += " ";
				continue;
			}
			if (char === activeQuote && !escaped) {
				activeQuote = undefined;
				output += " ";
				continue;
			}
			escaped = false;
			output += " ";
			continue;
		}

		if (char === "'" || char === '"') {
			activeQuote = char;
			output += " ";
			continue;
		}

		output += char;
	}

	return output;
}

/**
 * Extract commands from command substitution constructs (`$()` and backticks).
 * Returns the main command with substitutions removed, plus extracted inner commands.
 *
 * @param command - Command text (after single/double quote stripping)
 * @returns Object with main text and extracted inner command segments
 */
function extractCommandSubstitutions(command: string): {
	main: string;
	extracted: string[];
} {
	const extracted: string[] = [];
	let main = command;

	// Extract $(...) content
	const dollarParenRegex = /\$\(([^)]*)\)/g;
	for (const m of command.matchAll(dollarParenRegex)) {
		if (m[1].trim()) extracted.push(m[1].trim());
	}
	main = main.replace(/\$\([^)]*\)/g, " ");

	// Extract `...` content
	const backtickRegex = /`([^`]*)`/g;
	for (const m of command.matchAll(backtickRegex)) {
		if (m[1].trim()) extracted.push(m[1].trim());
	}
	main = main.replace(/`[^`]*`/g, " ");

	return { main, extracted };
}

/**
 * Split a command string on shell operators into independent segments.
 *
 * @param command - Command string (already stripped of quoted content)
 * @returns Array of cleaned command segments
 */
function splitShellSegments(command: string): string[] {
	return command
		.split(SHELL_OPERATORS)
		.map((seg) => seg.replace(SHELL_GROUPING, "").replace(/&$/, "").trim())
		.filter((seg) => seg.length > 0);
}

/**
 * Convert a shell command glob pattern to a regex where `*` matches any character.
 * Unlike path globs, shell command globs treat `*` as matching everything
 * (including `/` and spaces) since there's no directory hierarchy concept.
 *
 * @param pattern - Shell glob pattern (e.g. `npm *`, `git commit *`)
 * @returns Regular expression anchored to start and end
 */
function shellGlobToRegExp(pattern: string): RegExp {
	let result = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			result += ".*";
			// Skip consecutive stars
			while (pattern[i + 1] === "*") i++;
		} else if (char === "?") {
			result += ".";
		} else if ("\\^$.|+()[]{}".includes(char ?? "")) {
			result += `\\${char}`;
		} else {
			result += char;
		}
	}
	return new RegExp(`^${result}$`);
}

/**
 * Match a shell command glob pattern against a single command segment.
 *
 * @param segment - Cleaned command segment
 * @param specifier - Glob specifier from rule (e.g. `npm *`, `git commit *`)
 * @returns True when the segment matches
 */
function matchSegment(segment: string, specifier: string): boolean {
	return shellGlobToRegExp(specifier).test(segment);
}

/**
 * Match a bash command against a rule specifier with shell operator awareness.
 *
 * For **deny/ask** rules: any segment matching → match the whole command.
 * For **allow** rules: all segments must match → allow the command.
 *
 * Command substitution (`` ` `` and `$()`) content is extracted and checked
 * as additional segments for deny/ask rules. For allow rules, the presence
 * of command substitution fails-closed (returns false).
 *
 * @param command - Raw command text from tool input
 * @param specifier - Glob pattern from rule specifier
 * @param mode - Whether this is an allow or deny/ask evaluation
 * @returns True when the command matches according to the mode semantics
 */
export function matchBashRule(
	command: string,
	specifier: string,
	mode: "allow" | "deny" | "ask"
): boolean {
	// Strip control chars first
	const cleaned = stripControlChars(command.trim());

	if (mode === "allow") {
		// For allow: strip all quoted content including backticks
		const unquoted = stripQuotedContent(cleaned);

		// Fail-closed on command substitution
		if (unquoted.includes("$(")) return false;

		const segments = splitShellSegments(unquoted);
		if (segments.length === 0) return false;

		// All segments must match for allow
		return segments.every((seg) => matchSegment(seg, specifier));
	}

	// Deny/ask mode: strip only single/double quotes, keep backtick/$() content
	const unquoted = stripSingleDoubleQuotes(cleaned);

	// Extract command substitution inner commands as extra segments
	const { main, extracted } = extractCommandSubstitutions(unquoted);

	// Split main text on operators
	const mainSegments = splitShellSegments(main);

	// Combine all segments
	const allSegments = [...mainSegments, ...extracted];

	if (allSegments.length === 0) return false;

	// Any segment matching → deny/ask the whole command
	return allSegments.some((seg) => matchSegment(seg, specifier));
}

// ── Domain Matching ──────────────────────────────────────────────────────────

/**
 * Extract hostname from a URL string, handling edge cases.
 *
 * @param url - URL string (may be missing protocol)
 * @returns Hostname or null if unparseable
 */
function extractHostname(url: string): string | null {
	try {
		// Add protocol if missing
		const normalized = url.includes("://") ? url : `https://${url}`;
		return new URL(normalized).hostname;
	} catch {
		return null;
	}
}

/**
 * Match a URL against a `domain:host` specifier.
 *
 * Supports exact match and wildcard subdomain matching (`*.example.com`).
 * Port and protocol are ignored.
 *
 * @param url - URL from tool input
 * @param specifier - Domain specifier (e.g. `domain:example.com`, `domain:*.example.com`)
 * @returns True when the URL's host matches the specifier
 */
export function matchDomainRule(url: string, specifier: string): boolean {
	// Extract the domain pattern from "domain:host" format
	const domainPrefix = "domain:";
	if (!specifier.startsWith(domainPrefix)) return false;
	const domainPattern = specifier.slice(domainPrefix.length);

	const hostname = extractHostname(url);
	if (!hostname) return false;

	// Wildcard subdomain matching
	if (domainPattern.startsWith("*.")) {
		const baseDomain = domainPattern.slice(2);
		return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
	}

	return hostname === domainPattern;
}

// ── MCP Tool Matching ────────────────────────────────────────────────────────

/**
 * Match an MCP tool name against a glob pattern.
 *
 * @param toolName - Actual tool name (e.g. `mcp__puppeteer__navigate`)
 * @param pattern - Glob pattern (e.g. `mcp__puppeteer__*`, `mcp__*`)
 * @returns True when the tool name matches the pattern
 */
export function matchMcpRule(toolName: string, pattern: string): boolean {
	return globToRegExp(pattern).test(toolName);
}

// ── Subagent Matching ────────────────────────────────────────────────────────

/**
 * Match a subagent name against a Task specifier.
 * Agent names are case-sensitive. Supports glob patterns.
 *
 * @param agentName - Actual agent name
 * @param specifier - Specifier from `Task(name)` rule
 * @returns True when the agent name matches
 */
export function matchSubagentRule(agentName: string, specifier: string): boolean {
	return globToRegExp(specifier).test(agentName);
}

// ── Input Extraction ─────────────────────────────────────────────────────────

/**
 * Extract the relevant matching input from a tool call based on tool type.
 *
 * @param toolName - Canonical tool name
 * @param input - Tool input object
 * @returns The value to match against specifiers, or null if not applicable
 */
export function extractToolInput(
	toolName: string,
	input: Record<string, unknown>
): { kind: "command" | "path" | "domain" | "agent" | "mcp"; value: string } | null {
	switch (toolName) {
		case "bash":
		case "bg_bash":
			if (typeof input.command === "string") {
				return { kind: "command", value: input.command };
			}
			break;
		case "read":
		case "write":
		case "edit":
		case "cd":
			if (typeof input.path === "string") {
				return { kind: "path", value: input.path };
			}
			break;
		case "ls":
			if (typeof input.path === "string") {
				return { kind: "path", value: input.path };
			}
			// ls defaults to cwd if no path — no restriction needed
			break;
		case "find":
			if (typeof input.path === "string") {
				return { kind: "path", value: input.path };
			}
			break;
		case "grep":
			if (typeof input.path === "string") {
				return { kind: "path", value: input.path };
			}
			break;
		case "web_fetch":
			if (typeof input.url === "string") {
				return { kind: "domain", value: input.url };
			}
			break;
		case "subagent":
			if (typeof input.agent === "string") {
				return { kind: "agent", value: input.agent };
			}
			// Check parallel tasks for agent names
			if (Array.isArray(input.tasks)) {
				const agents = (input.tasks as Array<{ agent?: string }>)
					.map((t) => t.agent)
					.filter((a): a is string => typeof a === "string");
				if (agents.length > 0) {
					// Return the first agent — caller should check all agents
					return { kind: "agent", value: agents[0] };
				}
			}
			// Centipede mode
			if (Array.isArray(input.centipede)) {
				const agents = (input.centipede as Array<{ agent?: string }>)
					.map((t) => t.agent)
					.filter((a): a is string => typeof a === "string");
				if (agents.length > 0) {
					return { kind: "agent", value: agents[0] };
				}
			}
			break;
	}

	// MCP tools
	if (toolName.startsWith("mcp__")) {
		return { kind: "mcp", value: toolName };
	}

	return null;
}

/**
 * Extract all agent names from a subagent tool input.
 * Handles single, parallel, and centipede modes.
 *
 * @param input - Subagent tool input
 * @returns Array of agent names to check
 */
export function extractAllAgentNames(input: Record<string, unknown>): string[] {
	const agents: string[] = [];

	if (typeof input.agent === "string") {
		agents.push(input.agent);
	}
	if (Array.isArray(input.tasks)) {
		for (const task of input.tasks as Array<{ agent?: string }>) {
			if (typeof task.agent === "string") agents.push(task.agent);
		}
	}
	if (Array.isArray(input.centipede)) {
		for (const step of input.centipede as Array<{ agent?: string }>) {
			if (typeof step.agent === "string") agents.push(step.agent);
		}
	}

	return agents;
}

// ── Core Evaluation ──────────────────────────────────────────────────────────

/**
 * Check whether a single rule matches a tool invocation.
 *
 * @param rule - Parsed permission rule
 * @param toolName - Canonical tool name being invoked
 * @param input - Tool input object
 * @param mode - Evaluation mode (affects bash allow vs deny semantics)
 * @param vars - Variable expansion context
 * @param settingsDir - Directory of the settings file containing this rule
 * @returns True when the rule matches this invocation
 */
function ruleMatches(
	rule: ParsedRule,
	toolName: string,
	input: Record<string, unknown>,
	mode: "allow" | "deny" | "ask",
	vars: ExpansionVars,
	settingsDir: string
): boolean {
	// Tool name must match (or rule targets MCP glob that matches)
	if (rule.tool !== toolName) {
		// Check if this is an MCP glob rule that matches the tool
		if (rule.tool.startsWith("mcp__") && toolName.startsWith("mcp__")) {
			if (!matchMcpRule(toolName, rule.tool)) return false;
			// MCP glob rule matched the tool name — continue to specifier check
		} else {
			return false;
		}
	}

	// Bare tool name (no specifier) matches all uses of that tool
	if (rule.specifier === null) return true;

	// Expand variables in specifier
	const expandedSpecifier = expandVariables(rule.specifier, vars);

	// Match based on tool type
	switch (toolName) {
		case "bash":
		case "bg_bash": {
			const command = typeof input.command === "string" ? input.command : "";
			return matchBashRule(command, expandedSpecifier, mode);
		}
		case "read":
		case "write":
		case "edit":
		case "cd":
		case "ls":
		case "find":
		case "grep": {
			const filePath = typeof input.path === "string" ? input.path : "";
			if (!filePath) return false;
			const canonical = canonicalizePath(filePath, vars.cwd);
			const resolvedPattern = resolvePathSpecifier(expandedSpecifier, settingsDir, vars);
			return matchPathRule(canonical, resolvedPattern);
		}
		case "web_fetch": {
			const url = typeof input.url === "string" ? input.url : "";
			return matchDomainRule(url, expandedSpecifier);
		}
		case "subagent": {
			// Check all agent names in the input
			const agents = extractAllAgentNames(input);
			if (agents.length === 0) return false;

			if (mode === "deny" || mode === "ask") {
				// Any agent matching → match (deny/ask the whole invocation)
				return agents.some((a) => matchSubagentRule(a, expandedSpecifier));
			}
			// Allow: all agents must match
			return agents.every((a) => matchSubagentRule(a, expandedSpecifier));
		}
		default: {
			// MCP tools or unknown tools with specifiers — try glob match
			if (toolName.startsWith("mcp__")) {
				return matchMcpRule(toolName, expandedSpecifier);
			}
			return false;
		}
	}
}

/**
 * Evaluate a tool invocation against a permission config.
 *
 * Resolution order: deny → ask → allow → default.
 * - Deny always wins.
 * - Ask beats allow.
 * - If allow list is non-empty and no rule matches, returns "default" (prompt in allowlist mode).
 * - If allow list is empty, returns "default" (fully permissive).
 *
 * @param toolName - Tool name (canonical snake_case or raw — will be normalized)
 * @param input - Tool input object
 * @param config - Permission configuration
 * @param vars - Variable expansion context
 * @param settingsDir - Directory of the settings file (for path resolution)
 * @returns Permission verdict with action and optional matched rule
 */
export function evaluate(
	toolName: string,
	input: Record<string, unknown>,
	config: PermissionConfig,
	vars: ExpansionVars,
	settingsDir: string
): PermissionVerdict {
	const canonical = normalizeToolName(toolName);

	// 1. Deny — any match blocks
	for (const rule of config.deny) {
		if (ruleMatches(rule, canonical, input, "deny", vars, settingsDir)) {
			return {
				allowed: false,
				action: "deny",
				reason: `Blocked by permission rule: ${rule.raw}`,
				matchedRule: rule.raw,
			};
		}
	}

	// 2. Ask — any match prompts
	for (const rule of config.ask) {
		if (ruleMatches(rule, canonical, input, "ask", vars, settingsDir)) {
			return {
				allowed: false,
				action: "ask",
				reason: `Requires confirmation per permission rule: ${rule.raw}`,
				matchedRule: rule.raw,
			};
		}
	}

	// 3. Allow — any match permits
	for (const rule of config.allow) {
		if (ruleMatches(rule, canonical, input, "allow", vars, settingsDir)) {
			return {
				allowed: true,
				action: "allow",
				reason: `Permitted by permission rule: ${rule.raw}`,
				matchedRule: rule.raw,
			};
		}
	}

	// 4. Default — if allow list has entries, the tool is unlisted (prompt)
	//    If allow list is empty, fully permissive (allow)
	if (config.allow.length > 0) {
		return {
			allowed: true,
			action: "default",
			reason: "No matching permission rule; allowlist mode — unlisted tool",
		};
	}

	return {
		allowed: true,
		action: "default",
		reason: "No permission rules configured",
	};
}

// ── Config Loading ───────────────────────────────────────────────────────────

/**
 * Read the `permissions` key from a JSON file.
 *
 * @param filePath - Path to a settings.json or settings.local.json
 * @param warnings - Array to append warning messages to
 * @returns Raw permissions object, or null if absent/invalid
 */
function readPermissionsFromFile(
	filePath: string,
	warnings: string[]
): { allow?: unknown[]; deny?: unknown[]; ask?: unknown[] } | null {
	if (!existsSync(filePath)) return null;

	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);

		if (typeof parsed !== "object" || parsed === null) return null;

		const permissions = parsed.permissions;
		if (permissions === undefined) return null;

		if (typeof permissions !== "object" || permissions === null) {
			warnings.push(
				`Invalid permissions in ${filePath}: expected object, got ${typeof permissions}`
			);
			return null;
		}

		const result: { allow?: unknown[]; deny?: unknown[]; ask?: unknown[] } = {};

		if ("allow" in permissions) {
			if (!Array.isArray(permissions.allow)) {
				warnings.push(`Invalid permissions.allow in ${filePath}: expected array`);
			} else {
				result.allow = permissions.allow;
			}
		}

		if ("deny" in permissions) {
			if (!Array.isArray(permissions.deny)) {
				warnings.push(`Invalid permissions.deny in ${filePath}: expected array`);
			} else {
				result.deny = permissions.deny;
			}
		}

		if ("ask" in permissions) {
			if (!Array.isArray(permissions.ask)) {
				warnings.push(`Invalid permissions.ask in ${filePath}: expected array`);
			} else {
				result.ask = permissions.ask;
			}
		}

		return result;
	} catch {
		warnings.push(`Failed to parse ${filePath}`);
		return null;
	}
}

/**
 * Parse a raw permissions object into a PermissionConfig.
 *
 * @param raw - Raw permissions with allow/deny/ask arrays
 * @param warnings - Array to append warning messages to
 * @returns Parsed permission config
 */
function parsePermissionsObject(
	raw: { allow?: unknown[]; deny?: unknown[]; ask?: unknown[] },
	warnings: string[]
): PermissionConfig {
	return {
		allow: parseRules(raw.allow ?? [], warnings),
		deny: parseRules(raw.deny ?? [], warnings),
		ask: parseRules(raw.ask ?? [], warnings),
	};
}

/**
 * Merge multiple PermissionConfigs by concatenating their rule lists.
 *
 * @param configs - Array of configs to merge (earlier = higher precedence)
 * @returns Merged config with all rules combined
 */
export function mergePermissionConfigs(...configs: PermissionConfig[]): PermissionConfig {
	return {
		allow: configs.flatMap((c) => c.allow),
		deny: configs.flatMap((c) => c.deny),
		ask: configs.flatMap((c) => c.ask),
	};
}

/** Empty permission config constant. */
export const EMPTY_CONFIG: PermissionConfig = {
	allow: [],
	deny: [],
	ask: [],
};

/**
 * Load permission configuration from all settings files with proper precedence.
 *
 * Scan order (highest to lowest precedence):
 * 1. CLI flags (passed in, not loaded from file)
 * 2. Project local (`.tallow/settings.local.json`)
 * 3. Project shared (`.tallow/settings.json`)
 * 4. User (`~/.tallow/settings.json`)
 *
 * Also reads `.claude/settings.json` and `.claude/settings.local.json` at
 * their respective project tiers when present.
 *
 * @param cwd - Current working directory
 * @param cliConfig - CLI-provided permission config (highest precedence)
 * @returns Loaded permission state with merged config and individual sources
 */
export function loadPermissionConfig(
	cwd: string,
	cliConfig?: PermissionConfig
): { loaded: LoadedPermissions; warnings: string[] } {
	const warnings: string[] = [];
	const sources: PermissionSource[] = [];
	const home = homedir();
	const tallowHome = process.env.PI_CODING_AGENT_DIR ?? join(home, ".tallow");

	// CLI tier
	if (
		cliConfig &&
		(cliConfig.allow.length > 0 || cliConfig.deny.length > 0 || cliConfig.ask.length > 0)
	) {
		sources.push({ path: "<cli>", tier: "cli", config: cliConfig });
	}

	// Project local: .tallow/settings.local.json
	const projectLocalPath = join(cwd, ".tallow", "settings.local.json");
	const projectLocalRaw = readPermissionsFromFile(projectLocalPath, warnings);
	if (projectLocalRaw) {
		const config = parsePermissionsObject(projectLocalRaw, warnings);
		sources.push({ path: projectLocalPath, tier: "project-local", config });
	}

	// Claude local: .claude/settings.local.json (same precedence tier as project-local)
	const claudeLocalPath = join(cwd, ".claude", "settings.local.json");
	const claudeLocalRaw = readPermissionsFromFile(claudeLocalPath, warnings);
	if (claudeLocalRaw) {
		const config = parsePermissionsObject(claudeLocalRaw, warnings);
		sources.push({ path: claudeLocalPath, tier: "project-local", config });
	}

	// Project shared: .tallow/settings.json
	const projectSharedPath = join(cwd, ".tallow", "settings.json");
	const projectSharedRaw = readPermissionsFromFile(projectSharedPath, warnings);
	if (projectSharedRaw) {
		const config = parsePermissionsObject(projectSharedRaw, warnings);
		sources.push({ path: projectSharedPath, tier: "project-shared", config });
	}

	// Claude shared: .claude/settings.json (same tier as project-shared)
	const claudeSharedPath = join(cwd, ".claude", "settings.json");
	const claudeSharedRaw = readPermissionsFromFile(claudeSharedPath, warnings);
	if (claudeSharedRaw) {
		const config = parsePermissionsObject(claudeSharedRaw, warnings);
		sources.push({ path: claudeSharedPath, tier: "project-shared", config });
	}

	// User: ~/.tallow/settings.json
	const userPath = join(tallowHome, "settings.json");
	const userRaw = readPermissionsFromFile(userPath, warnings);
	if (userRaw) {
		const config = parsePermissionsObject(userRaw, warnings);
		sources.push({ path: userPath, tier: "user", config });
	}

	// Merge all configs (order matters — deny from any source blocks)
	const merged =
		sources.length > 0 ? mergePermissionConfigs(...sources.map((s) => s.config)) : EMPTY_CONFIG;

	return {
		loaded: { merged, sources },
		warnings,
	};
}
