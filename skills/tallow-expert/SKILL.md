---
name: tallow-expert
icon: 🔧
description: "Auto-triggers on tallow internals, architecture, extensions, configuration, or the pi framework API. Spawns the tallow-expert agent for codebase discovery."
---

# Tallow Expert Skill

## When This Triggers

- User asks about tallow architecture, internals, or source code
- How extensions work, their API, or how to create them
- The pi framework (ExtensionAPI, tools, commands, events, types)
- Configuration (settings.json, themes, keybindings, packages)
- How skills, agents, or prompts are loaded and discovered
- Debugging or troubleshooting tallow itself
- How the TUI, session management, or model registry works

## Procedure

Invoke the `tallow-expert` agent via the subagent tool:

```json
{ "agent": "tallow-expert", "task": "<the user's question>" }
```

The agent explores the tallow source code and returns an answer.
Relay that answer to the user.

## Quick Reference

| Component | Location |
|-----------|----------|
| Core source | `src/` (config.ts, sdk.ts, cli.ts) |
| Extensions | `extensions/` — extension.json + index.ts each (39 bundled) |
| **Key extensions** | `context-fork` (subprocess isolation), `claude-bridge` (.claude/ compat), `session-namer` (auto-names sessions via Haiku, displayed in custom-footer) |
| Skills | `skills/` — subdirs with SKILL.md |
| Agents | `agents/` — markdown with YAML frontmatter |
| Themes | `themes/` — JSON files |
| Pi framework types | `node_modules/@mariozechner/pi-coding-agent/dist/` |
| User config | `~/.tallow/` (settings.json, auth.json, keybindings.json) |
| User extensions | `~/.tallow/extensions/` |
| User agents | `~/.tallow/agents/`, `~/.claude/agents/` |
| User skills | `~/.tallow/skills/`, `~/.claude/skills/` |
| User commands | `~/.tallow/commands/`, `~/.claude/commands/` |
| Project agents | `.tallow/agents/`, `.claude/agents/` |
| Project skills | `.tallow/skills/`, `.claude/skills/` |
| Project commands | `.tallow/commands/`, `.claude/commands/` |
| Sessions | `~/.tallow/sessions/` |

**Agent frontmatter fields**: `tools`, `disallowedTools`, `maxTurns`, `mcpServers`, `context: fork`, `agent`, `model`

### Extension API Surface

Extensions export a default function receiving `ExtensionAPI`:

- `registerCommand(name, { description, handler })` — slash commands
- `registerTool(definition)` — LLM-callable tools
- `registerShortcut(key, { handler })` — keyboard shortcuts
- `registerMessageRenderer(type, renderer)` — custom message display
- `sendMessage({ customType, content, display, details })` — emit messages
- `on(event, handler)` — lifecycle hooks (session_start, tool_call, resources_discover, etc.)
- `appendEntry(path)` — add skill/agent/command to discovery index
- `getCommands()`, `getActiveTools()`, `getAllTools()`

**Key hooks**: `session_start`, `before_agent_start`, `tool_call_start`, `tool_call_end`, `resources_discover`, `message_update`
