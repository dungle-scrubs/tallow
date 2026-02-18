#!/usr/bin/env node

/**
 * Regenerate the reference section of skills/tallow-expert/SKILL.md.
 *
 * Reads the codebase (directories, types.d.ts) and replaces everything
 * between <!-- BEGIN GENERATED --> and <!-- END GENERATED --> markers.
 * The procedural header above the markers is never touched.
 *
 * Run: node scripts/update-tallow-expert.mjs
 * Wired into pre-commit via .husky/pre-commit.
 *
 * @returns Exit 0 always. Writes updates if content changed.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_PATH = join(ROOT, "skills", "tallow-expert", "SKILL.md");
const TYPES_PATH = join(
	ROOT,
	"node_modules",
	"@mariozechner",
	"pi-coding-agent",
	"dist",
	"core",
	"extensions",
	"types.d.ts"
);

const BEGIN = "<!-- BEGIN GENERATED -->";
const END = "<!-- END GENERATED -->";

// ─── Directory scanning ──────────────────────────────────────────────────────

/**
 * List non-internal subdirectories in a directory.
 * Filters out dirs starting with _ or .
 *
 * @param {string} dir - Absolute path
 * @returns {string[]} Sorted directory names
 */
function listDirs(dir) {
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
		.map((d) => d.name)
		.sort();
}

/**
 * List files in a directory matching a pattern.
 *
 * @param {string} dir - Absolute path
 * @param {RegExp} [pattern] - Optional filter regex
 * @returns {string[]} Sorted file names
 */
function listFiles(dir, pattern) {
	return readdirSync(dir)
		.filter((f) => !pattern || pattern.test(f))
		.sort();
}

// ─── Types extraction ────────────────────────────────────────────────────────

/**
 * Extract the body of a named interface from source text.
 * Returns only top-level content (brace depth 0 within the interface).
 *
 * @param {string} src - types.d.ts content
 * @param {string} name - Interface name
 * @returns {string | null} Interface body or null if not found
 */
function findInterfaceBlock(src, name) {
	const re = new RegExp(`export interface ${name}(?:\\s+extends\\s+[\\w\\s,<>]+)?\\s*\\{`);
	const match = re.exec(src);
	if (!match) return null;

	let depth = 1;
	let i = match.index + match[0].length;
	while (i < src.length && depth > 0) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") depth--;
		i++;
	}
	return src.slice(match.index + match[0].length, i - 1);
}

/**
 * Collapse multi-line interface members into single-line statements.
 * A member starts at indent level 1 (4 spaces or 1 tab) and ends at
 * the next `;` at depth 0. JSDoc blocks are preserved separately.
 *
 * @param {string} block - Interface body text
 * @returns {Array<{doc: string, statement: string}>} Collapsed members
 */
function collapseMembers(block) {
	const lines = block.split("\n");
	const results = [];
	let pendingDoc = "";
	let accumulating = "";
	let depth = 0;
	let inDoc = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// JSDoc handling
		if (trimmed.startsWith("/**")) {
			inDoc = true;
			pendingDoc = "";
			const content = trimmed
				.replace(/^\/\*\*\s*/, "")
				.replace(/\s*\*\/\s*$/, "")
				.trim();
			if (content) pendingDoc = content;
			if (trimmed.endsWith("*/")) inDoc = false;
			continue;
		}
		if (inDoc) {
			if (trimmed.endsWith("*/")) {
				const content = trimmed
					.replace(/\*\/\s*$/, "")
					.replace(/^\*\s?/, "")
					.trim();
				if (content && !content.startsWith("@")) {
					pendingDoc += (pendingDoc ? " " : "") + content;
				}
				inDoc = false;
			} else {
				const content = trimmed.replace(/^\*\s?/, "").trim();
				if (content && !content.startsWith("@")) {
					pendingDoc += (pendingDoc ? " " : "") + content;
				}
			}
			continue;
		}

		// Skip blank lines
		if (trimmed === "") {
			if (!accumulating) pendingDoc = "";
			continue;
		}

		// Accumulate statement lines
		accumulating += (accumulating ? " " : "") + trimmed;

		// Track brace depth within the accumulated statement
		for (const ch of trimmed) {
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
		}

		// Statement complete when we hit `;` at depth 0
		if (depth <= 0 && trimmed.endsWith(";")) {
			results.push({ doc: pendingDoc, statement: accumulating });
			accumulating = "";
			pendingDoc = "";
			depth = 0;
		}
	}

	return results;
}

/**
 * Parse top-level members from an interface block.
 * Handles multi-line signatures by collapsing them first.
 *
 * @param {string} block - Interface body text
 * @param {Set<string>} [skip] - Member names to skip
 * @returns {Array<{name: string, signature: string, doc: string}>}
 */
function parseMembers(block, skip = new Set()) {
	const collapsed = collapseMembers(block);
	const members = [];
	const seen = new Set();

	for (const { doc, statement } of collapsed) {
		// Match method: name<generics>?(params...): ReturnType;
		const methodMatch = statement.match(
			/^(readonly\s+)?(\w+)(?:<[^>]*>)?\s*\(([^)]*)\)\s*:\s*(.+);$/
		);
		if (methodMatch) {
			const name = methodMatch[2];
			if (skip.has(name) || seen.has(name) || name.startsWith("_")) continue;
			seen.add(name);
			const readonly = methodMatch[1] ? "readonly " : "";
			const params = simplifyParams(methodMatch[3]);
			members.push({
				name,
				signature: `${readonly}${name}(${params})`,
				doc: cleanDoc(doc),
			});
			continue;
		}

		// Match property: name: Type;
		const propMatch = statement.match(/^(readonly\s+)?(\w+)\s*:\s*(.+);$/);
		if (propMatch) {
			const name = propMatch[2];
			if (skip.has(name) || seen.has(name) || name.startsWith("_")) continue;
			seen.add(name);
			const readonly = propMatch[1] ? "readonly " : "";
			members.push({
				name,
				signature: `${readonly}${name}`,
				doc: cleanDoc(doc),
			});
		}
	}

	return members;
}

/**
 * Simplify complex parameter strings for readability.
 * Strips inline object types down to their type name when possible.
 *
 * @param {string} params - Raw parameter string
 * @returns {string} Simplified version
 */
function simplifyParams(params) {
	// Collapse inline object types: { key: Type; ... } → simplified
	let result = params.replace(/\s{2,}/g, " ").replace(/\s*\|\s*undefined/g, "");

	// Replace verbose inline objects with a shorthand
	// e.g. options: { description?: string; handler: ... } → options?: object
	result = result.replace(
		/(\w+)(\??):\s*\{[^}]+\}/g,
		(_, name, optional) => `${name}${optional}: object`
	);

	return result.trim();
}

/**
 * Clean a doc string: take first sentence, trim.
 *
 * @param {string} doc - Raw doc text
 * @returns {string} Cleaned description
 */
function cleanDoc(doc) {
	if (!doc) return "";
	// Strip leading * from multi-line artifacts
	let cleaned = doc.replace(/^\*\s*/, "").trim();
	// Take first sentence
	const dot = cleaned.indexOf(". ");
	if (dot > 0) cleaned = cleaned.slice(0, dot + 1);
	// Remove trailing period-only artifacts
	if (cleaned === ".") return "";
	return cleaned;
}

/**
 * Extract event registrations from ExtensionAPI.on() overloads.
 *
 * @param {string} src - types.d.ts content
 * @returns {Array<{event: string, eventType: string, resultType: string | null}>}
 */
function extractEvents(src) {
	const events = [];
	const re = /on\(event:\s*"(\w+)",\s*handler:\s*ExtensionHandler<(\w+)(?:,\s*(\w+))?>/g;
	let m = re.exec(src);
	while (m !== null) {
		events.push({
			event: m[1],
			eventType: m[2],
			resultType: m[3] || null,
		});
		m = re.exec(src);
	}
	return events;
}

/**
 * Group events by lifecycle category.
 *
 * @param {Array<{event: string, eventType: string, resultType: string | null}>} events
 * @returns {Record<string, typeof events>}
 */
function categorizeEvents(events) {
	const categories = {
		"Session lifecycle": [],
		"Agent lifecycle": [],
		"Tool events": [],
		"Input & resources": [],
		"Message streaming": [],
	};

	for (const e of events) {
		if (e.event.startsWith("session_") || e.event.startsWith("resources_")) {
			categories["Session lifecycle"].push(e);
		} else if (
			[
				"before_agent_start",
				"agent_start",
				"agent_end",
				"turn_start",
				"turn_end",
				"model_select",
			].includes(e.event)
		) {
			categories["Agent lifecycle"].push(e);
		} else if (e.event.startsWith("tool_")) {
			categories["Tool events"].push(e);
		} else if (["input", "user_bash", "context"].includes(e.event)) {
			categories["Input & resources"].push(e);
		} else if (e.event.startsWith("message_")) {
			categories["Message streaming"].push(e);
		}
	}

	return categories;
}

// ─── Markdown generation ─────────────────────────────────────────────────────

/**
 * Format a list of parsed members as markdown bullet list.
 *
 * @param {Array<{name: string, signature: string, doc: string}>} members
 * @returns {string[]} Markdown lines
 */
function formatMembers(members) {
	return members.map((m) => {
		const desc = m.doc ? ` — ${m.doc}` : "";
		return `- \`${m.signature}\`${desc}`;
	});
}

/**
 * Group ExtensionAPI methods by semantic category.
 *
 * @param {Array<{name: string, signature: string, doc: string}>} methods
 * @returns {Record<string, typeof methods>}
 */
function groupAPIMethods(methods) {
	const registrationNames = new Set([
		"registerTool",
		"registerCommand",
		"registerShortcut",
		"registerFlag",
		"registerMessageRenderer",
		"registerProvider",
	]);
	const messagingNames = new Set(["sendMessage", "sendUserMessage", "appendEntry"]);
	const sessionNames = new Set(["setSessionName", "getSessionName", "setLabel"]);

	const groups = { Registration: [], Messaging: [], Session: [], "Tools & Model": [] };

	for (const m of methods) {
		if (registrationNames.has(m.name)) groups.Registration.push(m);
		else if (messagingNames.has(m.name)) groups.Messaging.push(m);
		else if (sessionNames.has(m.name)) groups.Session.push(m);
		else groups["Tools & Model"].push(m);
	}

	return groups;
}

/**
 * Build the full generated reference section.
 *
 * @returns {string} Markdown content for between the markers
 */
function generateReference() {
	const extensions = listDirs(join(ROOT, "extensions"));
	const themes = listFiles(join(ROOT, "themes"), /\.json$/);
	const coreFiles = listFiles(join(ROOT, "src"), /\.ts$/);
	const typesSrc = readFileSync(TYPES_PATH, "utf-8");
	const events = extractEvents(typesSrc);
	const categorized = categorizeEvents(events);

	const lines = [];

	// ── Quick Reference table ──
	lines.push("## Quick Reference");
	lines.push("");
	lines.push("| Component | Location |");
	lines.push("|-----------|----------|");
	lines.push(`| Core source | \`src/\` (${coreFiles.join(", ")}) |`);
	lines.push(
		`| Extensions | \`extensions/\` — extension.json + index.ts each (${extensions.length} bundled) |`
	);
	lines.push("| Skills | `skills/` — subdirs with SKILL.md |");
	lines.push("| Agents | `agents/` — markdown with YAML frontmatter |");
	lines.push(`| Themes | \`themes/\` — JSON files (${themes.length} dark-only themes) |`);
	lines.push("| Forked TUI | `packages/tallow-tui/` — forked `@mariozechner/pi-tui` |");
	lines.push(
		"| Pi framework types | `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` |"
	);
	lines.push("| User config | `~/.tallow/` (settings.json, auth.json, keybindings.json) |");
	lines.push("| User extensions | `~/.tallow/extensions/` |");
	lines.push("| User agents | `~/.tallow/agents/`, `~/.claude/agents/` |");
	lines.push("| User skills | `~/.tallow/skills/`, `~/.claude/skills/` |");
	lines.push("| User commands | `~/.tallow/commands/`, `~/.claude/commands/` |");
	lines.push("| Project agents | `.tallow/agents/`, `.claude/agents/` |");
	lines.push("| Project skills | `.tallow/skills/`, `.claude/skills/` |");
	lines.push("| Project commands | `.tallow/commands/`, `.claude/commands/` |");
	lines.push("| Sessions | `~/.tallow/sessions/` — per-cwd subdirs |");
	lines.push("| Docs site | `docs/` — Astro Starlight site |");
	lines.push("");
	lines.push(
		"**Agent frontmatter fields**: `tools`, `disallowedTools`, `maxTurns`, `mcpServers`, `context: fork`, `agent`, `model`"
	);
	lines.push("");

	// ── Extension API Surface ──
	lines.push("### Extension API Surface");
	lines.push("");
	lines.push(
		"Extensions export a default function receiving `ExtensionAPI` (conventionally named `pi`):"
	);
	lines.push("");

	const apiBlock = findInterfaceBlock(typesSrc, "ExtensionAPI");
	const apiMembers = apiBlock ? parseMembers(apiBlock, new Set(["on"])) : [];
	const grouped = groupAPIMethods(apiMembers);

	for (const [heading, methods] of Object.entries(grouped)) {
		if (methods.length === 0) continue;
		lines.push(`#### ${heading}`);
		lines.push("");
		lines.push(...formatMembers(methods));
		lines.push("");
	}

	// ── Events ──
	lines.push("### Events (`pi.on(event, handler)`)");
	lines.push("");

	for (const [category, evts] of Object.entries(categorized)) {
		if (evts.length === 0) continue;
		lines.push(`#### ${category}`);
		lines.push("");
		lines.push("| Event | Payload | Can return |");
		lines.push("|-------|---------|------------|");
		for (const e of evts) {
			lines.push(
				`| \`${e.event}\` | \`${e.eventType}\` | ${e.resultType ? `\`${e.resultType}\`` : "—"} |`
			);
		}
		lines.push("");
	}

	// ── ExtensionContext ──
	lines.push("### ExtensionContext (`ctx` in event handlers)");
	lines.push("");
	const ctxBlock = findInterfaceBlock(typesSrc, "ExtensionContext");
	const ctxMembers = ctxBlock ? parseMembers(ctxBlock) : [];
	lines.push(...formatMembers(ctxMembers));
	lines.push("");

	// ── ExtensionCommandContext ──
	lines.push("### ExtensionCommandContext (`ctx` in command handlers, extends ExtensionContext)");
	lines.push("");
	const cmdBlock = findInterfaceBlock(typesSrc, "ExtensionCommandContext");
	const cmdMembers = cmdBlock ? parseMembers(cmdBlock) : [];
	lines.push(...formatMembers(cmdMembers));
	lines.push("");

	// ── ExtensionUIContext ──
	lines.push("### ExtensionUIContext (`ctx.ui`)");
	lines.push("");
	const uiBlock = findInterfaceBlock(typesSrc, "ExtensionUIContext");
	const uiMembers = uiBlock ? parseMembers(uiBlock) : [];
	lines.push(...formatMembers(uiMembers));

	return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

const skill = readFileSync(SKILL_PATH, "utf-8");
const beginIdx = skill.indexOf(BEGIN);
const endIdx = skill.indexOf(END);

if (beginIdx === -1 || endIdx === -1) {
	console.error("Missing <!-- BEGIN GENERATED --> or <!-- END GENERATED --> markers in SKILL.md");
	process.exit(1);
}

const header = skill.slice(0, beginIdx + BEGIN.length);
const footer = skill.slice(endIdx).replace(/^\n+/, ""); // strip leading newlines from footer
const generated = generateReference();
const updated = `${header}\n\n${generated}\n\n${footer}`;

if (skill === updated) {
	console.log("✓ skills/tallow-expert/SKILL.md is up to date");
} else {
	writeFileSync(SKILL_PATH, updated);
	console.log("✏ Updated skills/tallow-expert/SKILL.md");
}
