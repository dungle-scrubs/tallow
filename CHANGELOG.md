# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Session naming** — new `session-namer` extension auto-generates a descriptive
  3–8 word name for each session using Haiku after the first response. Names display
  as a right-aligned third row in the footer, appear in `tallow --list`, and set
  the terminal tab title. Use `/name` to view or override, `--no-session-name` to
  disable.
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
- **TUI fork** — `@mariozechner/pi-tui` forked as `packages/tallow-tui` for
  direct control over TUI primitives
  - `BorderedBox` component with configurable border styles (single, double,
    rounded, heavy, double-single, single-double)
  - `Loader` hide/show support with `HIDE` sentinel for suppressing spinners
  - OSC 8 hyperlink utilities for clickable terminal links
- **Random spinner** — new `random-spinner` extension picks a random spinner
  preset from 56 curated cli-spinners on each session start. Pin a specific
  spinner via `{ "spinner": "arc" }` in `settings.json`, or disable the
  extension to use the default dots
- **Clickable file paths** — tool output headers (read, edit, write) now emit
  OSC 8 hyperlinks, making file paths clickable in supported terminals
- **Health bordered output** — `/health` diagnostics wrapped in a rounded
  border box for cleaner visual separation
- **Upstream check** — dev-only `upstream-check` extension with `/upstream`
  command. Compares pinned versions of pi-coding-agent and pi-tui against the
  npm registry. Only loads inside the tallow dev checkout

### Changed

- **Session namer** — `/name` is now a built-in pi command; removed the
  duplicate registration from the session-namer extension
- **Session memory** — replaced `better-sqlite3` native addon with a pure
  JavaScript sqlite adapter for lighter installation

### Fixed

- **Tasks** — fallback spinner frames when `getSpinner()` returns null; validate
  `index` param before using it
- **Ask-user-question** — hide "Working..." loader during question prompt and
  restore it after the user answers
- **Claude bridge** — package-aware collision detection for SKILL.md paths; skip
  `.claude/skills/` entries that collide with tallow skills
- **SDK** — normalize skill names to directory name (e.g. `my-skill/SKILL.md` →
  `my-skill`)
- **Skill commands** — validate and normalize skill names before registration
- **CLI** — prefer session name over truncated first message in `--list` output
- **TUI fork** — override pi-tui to use tallow fork for all packages; clamp
  content and fix title width in BorderedBox
- **Upstream check** — check devDependencies in addition to dependencies;
  combine multiple version notifications into a single message
- **File tool headers** — show full relative path instead of truncated basename

## [0.3.0] - 2026-02-11

### Added

- **Debug mode** — structured JSONL diagnostic logging to `~/.tallow/debug.log`
  - Activate via `--debug` flag, `TALLOW_DEBUG=1` env, or `NODE_ENV=development`
  - Logs tool timings, turn boundaries, model changes, subagent events, errors
  - `/diag` command for status, toggling, tailing, and clearing the log
  - Zero-cost when disabled — no file I/O or object allocation
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
- **Team archive and resume** — `team_shutdown`, Escape, and session end now archive
  teams instead of deleting them. New `team_resume` tool restores archived teams
  with their full task board, results, and messages. Claimed tasks reset to pending
  on restore.
- **User-configurable icons** — override TUI glyphs via `icons` in settings.json
  - 13 icon keys: success, error, pending, in\_progress, idle, waiting, active,
    blocked, unavailable, spinner, plan\_mode, task\_list, comment
  - Icon registry extension (`_icons`) with `getIcon()` and `getSpinner()` helpers
  - Migrated all 17 extensions from hardcoded literals to registry lookups
  - JSON Schema for settings.json with `$schema` for IDE autocompletion
  - Installer injects `$schema` reference on `tallow install`

### Changed

- **Subagent UI** — animated progress indicators for chain mode (spinner while
  running, checkmark/X on completion). Agent prose uses subdued color to recede
  behind structural elements.

## [0.2.0] - 2026-02-11

### Added

- **CLI flags** — `--provider` and `--api-key` for headless startup without
  interactive prompts. Install command gains `--default-provider`, `--default-model`,
  `--api-key`, `--theme`, and `--thinking` flags.

### Fixed

- **Plan mode** — extension tools now preserved across mode transitions instead
  of being dropped when toggling plan mode on/off.

## [0.1.0] - 2026-02-11

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
