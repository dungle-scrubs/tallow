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
| Core source | `src/` (config.ts, sdk.ts, cli.ts, install.ts, index.ts, session-utils.ts, session-migration.ts, extensions-global.d.ts) |
| Extensions | `extensions/` — extension.json + index.ts each (42 bundled) |
| Skills | `skills/` — subdirs with SKILL.md |
| Agents | `agents/` — markdown with YAML frontmatter |
| Themes | `themes/` — JSON files (34 dark-only themes) |
| Forked TUI | `packages/tallow-tui/` — forked `@mariozechner/pi-tui` |
| Pi framework types | `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` |
| User config | `~/.tallow/` (settings.json, auth.json, keybindings.json) |
| User extensions | `~/.tallow/extensions/` |
| User agents | `~/.tallow/agents/`, `~/.claude/agents/` |
| User skills | `~/.tallow/skills/`, `~/.claude/skills/` |
| User commands | `~/.tallow/commands/`, `~/.claude/commands/` |
| Project agents | `.tallow/agents/`, `.claude/agents/` |
| Project skills | `.tallow/skills/`, `.claude/skills/` |
| Project commands | `.tallow/commands/`, `.claude/commands/` |
| Sessions | `~/.tallow/sessions/` — per-cwd subdirs |
| Docs site | `docs/` — Astro Starlight site |

**Agent frontmatter fields**: `tools`, `disallowedTools`, `maxTurns`, `mcpServers`, `context: fork`, `agent`, `model`

### Extension API Surface

Extensions export a default function receiving `ExtensionAPI` (conventionally named `pi`):

#### Registration

- `registerTool<TParams, TDetails>(tool: ToolDefinition)` — LLM-callable tools
- `registerCommand(name, { description, handler, getArgumentCompletions? })` — slash commands
- `registerShortcut(shortcut: KeyId, { description?, handler })` — keyboard shortcuts
- `registerFlag(name, { description?, type, default? })` — CLI flags
- `registerMessageRenderer<T>(customType, renderer)` — custom message display
- `registerProvider(name, config: ProviderConfig)` — model providers (with optional OAuth)

#### Messaging

- `sendMessage<T>(message, options?)` — emit custom messages (options: `triggerTurn`, `deliverAs`)
- `sendUserMessage(content, options?)` — send user message to agent (always triggers turn)
- `appendEntry<T>(customType, data?)` — persist custom data to session (not sent to LLM)

#### Session

- `setSessionName(name)` / `getSessionName()` — session display name
- `setLabel(entryId, label)` — set/clear labels on entries

#### Tools & Model

- `getActiveTools()` / `setActiveTools(toolNames)` — active tool set
- `getAllTools()` — all registered tools with name, description, parameters
- `getCommands()` — available slash commands
- `setModel(model)` — switch model (returns false if no API key)
- `getThinkingLevel()` / `setThinkingLevel(level)` — thinking level control
- `getFlag(name)` — read CLI flag value

#### Shell

- `exec(command, args, options?)` — execute shell commands

#### Events

- `events: EventBus` — shared event bus for inter-extension communication

### Events (`pi.on(event, handler)`)

#### Session lifecycle

| Event | Payload | Can return |
|-------|---------|------------|
| `session_start` | `{}` | — |
| `session_before_switch` | `{ reason, targetSessionFile? }` | `{ cancel? }` |
| `session_switch` | `{ reason, previousSessionFile }` | — |
| `session_before_fork` | `{ entryId }` | `{ cancel?, skipConversationRestore? }` |
| `session_fork` | `{ previousSessionFile }` | — |
| `session_before_compact` | `{ preparation, branchEntries, signal }` | `{ cancel?, compaction? }` |
| `session_compact` | `{ compactionEntry, fromExtension }` | — |
| `session_before_tree` | `{ preparation, signal }` | `{ cancel?, summary?, customInstructions? }` |
| `session_tree` | `{ newLeafId, oldLeafId, summaryEntry? }` | — |
| `session_shutdown` | `{}` | — |

#### Agent lifecycle

| Event | Payload | Can return |
|-------|---------|------------|
| `before_agent_start` | `{ prompt, images?, systemPrompt }` | `{ message?, systemPrompt? }` |
| `agent_start` | `{}` | — |
| `agent_end` | `{ messages }` | — |
| `turn_start` | `{ turnIndex, timestamp }` | — |
| `turn_end` | `{ turnIndex, message, toolResults }` | — |
| `model_select` | `{ model, previousModel, source }` | — |

#### Tool events

| Event | Payload | Can return |
|-------|---------|------------|
| `tool_call` | `{ toolCallId, toolName, input }` | `{ block?, reason? }` |
| `tool_result` | `{ toolCallId, toolName, input, content, isError, details }` | `{ content?, details?, isError? }` |

#### Input & resources

| Event | Payload | Can return |
|-------|---------|------------|
| `input` | `{ text, images?, source }` | `{ action: "continue" \| "transform" \| "handled" }` |
| `user_bash` | `{ command, excludeFromContext, cwd }` | `{ operations?, result? }` |
| `context` | `{ messages }` | `{ messages? }` |
| `resources_discover` | `{ cwd, reason }` | `{ skillPaths?, promptPaths?, themePaths? }` |

### ExtensionContext (`ctx` in event handlers)

- `ui: ExtensionUIContext` — UI methods (see below)
- `hasUI: boolean` — false in print/RPC mode
- `cwd: string` — current working directory
- `sessionManager: ReadonlySessionManager` — session state
- `modelRegistry: ModelRegistry` — API key resolution
- `model: Model | undefined` — current model
- `isIdle()` / `abort()` / `hasPendingMessages()`
- `shutdown()` — graceful exit
- `getContextUsage()` — token counts and context window info
- `compact(options?)` — trigger context compaction
- `getSystemPrompt()` — current effective system prompt

### ExtensionCommandContext (`ctx` in command handlers, extends ExtensionContext)

- `waitForIdle()` — wait for agent to finish streaming
- `newSession(options?)` — start a new session
- `fork(entryId)` — fork from a specific entry
- `navigateTree(targetId, options?)` — navigate session tree
- `switchSession(sessionPath)` — switch to a different session
- `reload()` — reload extensions, skills, prompts, themes

### ExtensionUIContext (`ctx.ui`)

- `select(title, options, opts?)` — selector dialog
- `confirm(title, message, opts?)` — confirmation dialog
- `input(title, placeholder?, opts?)` — text input dialog
- `editor(title, prefill?)` — multi-line editor
- `notify(message, type?)` — notification (info/warning/error)
- `setStatus(key, text)` — footer status text
- `setWorkingMessage(message?)` — loading/streaming message
- `setWidget(key, content, options?)` — above/below editor widgets
- `setFooter(factory)` / `setHeader(factory)` — custom header/footer components
- `setTitle(title)` — terminal window title
- `setEditorComponent(factory)` — custom editor component
- `setEditorText(text)` / `getEditorText()` — editor content
- `pasteToEditor(text)` — paste with collapse handling
- `custom<T>(factory, options?)` — render custom TUI component with focus
- `theme` — current theme (readonly)
- `getAllThemes()` / `getTheme(name)` / `setTheme(name)` — theme management
- `getToolsExpanded()` / `setToolsExpanded(expanded)` — tool output expansion
