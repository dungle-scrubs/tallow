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

<!-- BEGIN GENERATED -->

## Quick Reference

| Component | Location |
|-----------|----------|
| Core source | `src/` (agent-runner.ts, atomic-write.ts, auth-hardening.ts, cli.ts, config.ts, extensions-global.d.ts, fatal-errors.ts, index.ts, install.ts, interactive-mode-patch.ts, pid-manager.ts, plugins.ts, process-cleanup.ts, project-trust-banner.ts, project-trust.ts, runtime-path-provider.ts, sdk.ts, session-migration.ts, session-utils.ts, startup-profile.ts, startup-timing.ts) |
| Extensions | `extensions/` — extension.json + index.ts each (50 bundled) |
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

- `registerTool(tool: ToolDefinition<TParams, TDetails>)` — Register a tool that the LLM can call.
- `registerCommand(name: string, options: Omit<RegisteredCommand, "name">)` — Register a custom command.
- `registerFlag(name: string, options: object)` — Register a CLI flag.
- `registerMessageRenderer(customType: string, renderer: MessageRenderer<T>)` — Register a custom renderer for CustomMessageEntry.
- `registerProvider(name: string, config: ProviderConfig)` — Register or override a model provider.

#### Messaging

- `sendMessage(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: object)` — Send a custom message to the session.
- `appendEntry(customType: string, data?: T)` — Append a custom entry to the session for state persistence (not sent to LLM).

#### Session

- `setSessionName(name: string)` — Set the session display name (shown in session selector).
- `getSessionName()` — Get the current session name, if set.
- `setLabel(entryId: string, label: string)` — Set or clear a label on an entry.

#### Tools & Model

- `getFlag(name: string)` — Get the value of a registered CLI flag.
- `exec(command: string, args: string[], options?: ExecOptions)` — Execute a shell command.
- `getActiveTools()` — Get the list of currently active tool names.
- `getAllTools()` — Get all configured tools with name and description.
- `setActiveTools(toolNames: string[])` — Set the active tools by name.
- `getCommands()` — Get available slash commands in the current session.
- `setModel(model: Model<any>)` — Set the current model.
- `getThinkingLevel()` — Get current thinking level.
- `setThinkingLevel(level: ThinkingLevel)` — Set thinking level (clamped to model capabilities).
- `events` — Shared event bus for extension communication.

### Events (`pi.on(event, handler)`)

#### Session lifecycle

| Event | Payload | Can return |
|-------|---------|------------|
| `resources_discover` | `ResourcesDiscoverEvent` | `ResourcesDiscoverResult` |
| `session_start` | `SessionStartEvent` | — |
| `session_before_switch` | `SessionBeforeSwitchEvent` | `SessionBeforeSwitchResult` |
| `session_switch` | `SessionSwitchEvent` | — |
| `session_before_fork` | `SessionBeforeForkEvent` | `SessionBeforeForkResult` |
| `session_fork` | `SessionForkEvent` | — |
| `session_before_compact` | `SessionBeforeCompactEvent` | `SessionBeforeCompactResult` |
| `session_compact` | `SessionCompactEvent` | — |
| `session_shutdown` | `SessionShutdownEvent` | — |
| `session_before_tree` | `SessionBeforeTreeEvent` | `SessionBeforeTreeResult` |
| `session_tree` | `SessionTreeEvent` | — |

#### Agent lifecycle

| Event | Payload | Can return |
|-------|---------|------------|
| `before_agent_start` | `BeforeAgentStartEvent` | `BeforeAgentStartEventResult` |
| `agent_start` | `AgentStartEvent` | — |
| `agent_end` | `AgentEndEvent` | — |
| `turn_start` | `TurnStartEvent` | — |
| `turn_end` | `TurnEndEvent` | — |
| `model_select` | `ModelSelectEvent` | — |

#### Tool events

| Event | Payload | Can return |
|-------|---------|------------|
| `tool_execution_start` | `ToolExecutionStartEvent` | — |
| `tool_execution_update` | `ToolExecutionUpdateEvent` | — |
| `tool_execution_end` | `ToolExecutionEndEvent` | — |
| `tool_call` | `ToolCallEvent` | `ToolCallEventResult` |
| `tool_result` | `ToolResultEvent` | `ToolResultEventResult` |

#### Input & resources

| Event | Payload | Can return |
|-------|---------|------------|
| `context` | `ContextEvent` | `ContextEventResult` |
| `user_bash` | `UserBashEvent` | `UserBashEventResult` |
| `input` | `InputEvent` | `InputEventResult` |

#### Message streaming

| Event | Payload | Can return |
|-------|---------|------------|
| `message_start` | `MessageStartEvent` | — |
| `message_update` | `MessageUpdateEvent` | — |
| `message_end` | `MessageEndEvent` | — |

### ExtensionContext (`ctx` in event handlers)

- `ui` — UI methods for user interaction
- `hasUI` — Whether UI is available (false in print/RPC mode)
- `cwd` — Current working directory
- `sessionManager` — Session manager (read-only)
- `modelRegistry` — Model registry for API key resolution
- `model` — Current model (may be undefined)
- `isIdle()` — Whether the agent is idle (not streaming)
- `abort()` — Abort the current agent operation
- `hasPendingMessages()` — Whether there are queued messages waiting
- `shutdown()` — Gracefully shutdown pi and exit.
- `getContextUsage()` — Get current context usage for the active model.
- `compact(options?: CompactOptions)` — Trigger compaction without awaiting completion.
- `getSystemPrompt()` — Get the current effective system prompt.

### ExtensionCommandContext (`ctx` in command handlers, extends ExtensionContext)

- `waitForIdle()` — Wait for the agent to finish streaming
- `fork(entryId: string)` — Fork from a specific entry, creating a new session file.
- `navigateTree(targetId: string, options?: object)` — Navigate to a different point in the session tree.
- `switchSession(sessionPath: string)` — Switch to a different session file.
- `reload()` — Reload extensions, skills, prompts, and themes.

### ExtensionUIContext (`ctx.ui`)

- `select(title: string, options: string[], opts?: ExtensionUIDialogOptions)` — Show a selector and return the user's choice.
- `confirm(title: string, message: string, opts?: ExtensionUIDialogOptions)` — Show a confirmation dialog.
- `input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions)` — Show a text input dialog.
- `notify(message: string, type?: "info" | "warning" | "error")` — Show a notification to the user.
- `onTerminalInput(handler: TerminalInputHandler)` — Listen to raw terminal input (interactive mode only).
- `setStatus(key: string, text: string)` — Set status text in the footer/status bar.
- `setWorkingMessage(message?: string)` — Set the working/loading message shown during streaming.
- `setWidget(key: string, content: string[], options?: ExtensionWidgetOptions)` — Set a widget to display above or below the editor.
- `setTitle(title: string)` — Set the terminal window/tab title.
- `pasteToEditor(text: string)` — Paste text into the editor, triggering paste handling (collapse for large content).
- `setEditorText(text: string)` — Set the text in the core input editor.
- `getEditorText()` — Get the current text from the core input editor.
- `editor(title: string, prefill?: string)` — Show a multi-line editor for text editing.
- `readonly theme` — Get the current theme for styling.
- `getAllThemes()` — Get all available themes with their names and file paths.
- `getTheme(name: string)` — Load a theme by name without switching to it.
- `setTheme(theme: string | Theme)` — Set the current theme by name or Theme object.
- `getToolsExpanded()` — Get current tool output expansion state.
- `setToolsExpanded(expanded: boolean)` — Set tool output expansion state.

<!-- END GENERATED -->






