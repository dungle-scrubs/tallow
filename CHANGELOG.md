# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Shell interpolation** — expand `` !`command` `` patterns in input by executing
  shell commands and inlining stdout. CC-compatible syntax. 5s timeout, 1MB max
  output, non-recursive. Exported `expandShellCommands()` for use by other extensions.
- **File references** — expand `@path/to/file` patterns in input by reading files
  and inlining contents in fenced code blocks. CC-compatible syntax. Skips emails,
  fenced code blocks, directories, and binary files. 100KB truncation. Exported
  `expandFileReferences()` for use by other extensions.
- **Subagent input expansion** — subagent task prompts now expand both `` !`cmd` ``
  and `@file` patterns before spawning, so subagent tasks can reference files and
  shell output.
- **Debug mode** — structured JSONL diagnostic logging to `~/.tallow/debug.log`
  - Activate via `--debug` flag, `TALLOW_DEBUG=1` env, or `NODE_ENV=development`
  - Logs tool timings, turn boundaries, model changes, subagent events, errors
  - `/diag` command for status, toggling, tailing, and clearing the log
  - Zero-cost when disabled — no file I/O or object allocation
- **Team archive and resume** — `team_shutdown`, Escape, and session end now archive
  teams instead of deleting them. New `team_resume` tool restores archived teams
  with their full task board, results, and messages. Claimed tasks reset to pending
  on restore.
- **CLI flags** — `--provider` and `--api-key` for headless startup without
  interactive prompts. Install command gains `--default-provider`, `--default-model`,
  `--api-key`, `--theme`, and `--thinking` flags.
- **User-configurable icons** — override TUI glyphs via `icons` in settings.json
  - 13 icon keys: success, error, pending, in\_progress, idle, waiting, active,
    blocked, unavailable, spinner, plan\_mode, task\_list, comment
  - Icon registry extension (`_icons`) with `getIcon()` and `getSpinner()` helpers
  - Migrated all 17 extensions from hardcoded literals to registry lookups
  - JSON Schema for settings.json with `$schema` for IDE autocompletion
  - Installer injects `$schema` reference on `tallow install`
- **Context fork extension** — run skills and commands in isolated subprocesses
  with independent context windows via `context: fork` frontmatter
  - Model resolution: `sonnet` → claude-sonnet-4-20250514, `haiku` →
    claude-haiku-3-5-20241022, `opus` → claude-opus-4-20250514, `inherit` →
    parent model
  - `agent: <name>` frontmatter applies agent config (tools, skills, system prompt)
    to subprocess
  - `model: <alias>` frontmatter specifies model for forked context
  - `allowed-tools` frontmatter (no-op placeholder for future)
  - Compact display with 🔀 prefix and custom message renderer
- **Agent frontmatter extensions** — new control fields for agents, skills, and
  commands
  - `disallowedTools` frontmatter — denylist complement to `tools`. Effective tool
    list = (allowlist or PI\_BUILTIN\_TOOLS) minus denied tools
  - `maxTurns` frontmatter — caps agentic turns. Hard enforcement in subagent-tool
    via tool\_call\_start event counting. Soft enforcement in agent-commands-tool.
    System prompt budget hint injected
  - `computeEffectiveTools()` helper and `PI_BUILTIN_TOOLS` constant added
- **Claude directory bridging** — `.claude/` directories now bridged alongside
  `.tallow/` for cross-tool compatibility
  - New `claude-bridge` extension hooks `resources_discover` to inject `.claude/skills/`
    paths
  - `skill-commands` scans `.claude/skills/` alongside `.tallow/skills/`
  - `subagent-tool` scans `~/.claude/agents/` and `cwd/.claude/agents/`
  - `agent-commands-tool` scans `.claude/` directories (priority: bundled →
    packages → `.claude/user` → `.tallow/user` → `.claude/project` → `.tallow/project`)
  - `context-fork` loads agents from `.claude/` directories
  - `command-prompt` scans `.claude/commands/` at project and global levels
  - `.tallow/` always wins on name collision (last-wins semantics)
- **Agent-scoped MCP servers** — agents can declare which MCP servers they need
  - `mcpServers` frontmatter — comma-separated server name references
  - `PI_MCP_SERVERS` env var passed to subprocesses to filter which MCP servers
    connect
  - `mcp-adapter-tool` filters servers at session\_start based on PI\_MCP\_SERVERS
  - Inline MCP server definitions (objects) log warning and are skipped (v1 =
    reference mode only)
- **Co-located extension instructions** — instructions moved from AGENTS.md to
  their owning extensions
  - "Documentation Lookup", "MCP Server Policy", "Tool Proxy Modes" moved to
    `mcp-adapter-tool`'s `before_agent_start` hook
  - "Tallow Slash Commands" design constraints moved to `command-prompt`'s
    `before_agent_start` hook
  - Instructions now only appear when their owning extension is loaded

### Changed

- **Subagent UI** — animated progress indicators for chain mode (spinner while
  running, checkmark/X on completion). Agent prose uses subdued color to recede
  behind structural elements.

### Fixed

- **Plan mode** — extension tools now preserved across mode transitions instead
  of being dropped when toggling plan mode on/off.

## [0.1.0] - 2025-02-11

### Added

- Initial release
- 30+ bundled extensions (enhanced tools, hooks, tasks, teams, LSP, themes, and more)
- 34 terminal color themes
- 8 slash commands (`/implement`, `/review`, `/fix`, `/test`, `/scout-and-plan`, `/scaffold`, `/question`)
- 8 specialized agents (architect, debug, planner, refactor, reviewer, scout, worker, tallow-expert)
- Multi-agent teams with task boards and messaging
- SDK for programmatic usage (`createTallowSession`)
- Interactive installer (`tallow install`)
- CLI with print mode, RPC mode, and session management
