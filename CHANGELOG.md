# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **context-files:** `@import` directives — parse `@path/to/file.md` in context
  files with recursive resolution, circular import detection, and depth limiting
- **context-files:** scan `.tallow/rules/`, `.claude/rules/`, and `~/.tallow/rules/`
  for .md/.txt rule files
- **health:** `/doctor` validation — 7 diagnostic checks (model, auth, context,
  tools, Node version, settings, project context) with actionable suggestions
- **sdk:** inject model identity into system prompt so non-Claude models don't
  confabulate their identity
- **core:** PID file manager for orphan process cleanup on startup and shutdown
- **background-task-tool:** track spawned PIDs via shared registry for orphan cleanup
- **core:** unconditional fatal error handlers (uncaughtException, unhandledRejection)

### Changed

- **deps:** upgrade pi framework 0.52.9 → 0.52.12
- **deps:** bump `@biomejs/biome` 2.3.14 → 2.3.15, `@types/node` 25.2.2 → 25.2.3
- **tallow-tui:** replace `inputMiddleware` with upstream `inputListeners` API
- **tallow-tui:** adopt upstream crash logging for width overflow

### Fixed

- **tui:** stop horizontal compression when height-clamping images — keep full
  width and clip at the bottom instead
- **tui:** remove artificial max width cap on images
- **background-task-tool:** clean up stream listeners on task completion to
  prevent memory leaks
- **lsp:** send proper shutdown/exit sequence before killing language servers
- **mcp-adapter-tool:** shorten init timeout 30s → 10s with improved error messages
- **hooks:** surface hook blocks with visible error notifications
- **plan-mode-tool:** add user feedback when commands are blocked, plan is kept,
  or refinement editor is dismissed
- **core:** handle SIGTERM/SIGINT and EIO/EPIPE for clean shutdown
- **health:** handle nullable `ContextUsage.tokens` and `.percent` after pi 0.52.12
- **context-usage:** guard against null `usage.tokens` in arithmetic calculations
- **lint:** resolve all pre-existing biome warnings across the codebase

### Documentation

- **hooks:** document `shell:true` injection risk and mitigation plan
- **AGENTS.md:** prefer rebase merge for PRs

## [0.5.0](https://github.com/dungle-scrubs/tallow/compare/v0.4.0...v0.5.0) (2026-02-14)

### Added

- **subagent-tool:** model inheritance — subagents inherit the parent session model
  by default (per-call > agent frontmatter > parent model)
- **subagent-tool:** missing-agent recovery — unknown agent names resolve via
  fuzzy best-match or ephemeral fallback instead of hard errors
- **subagent-tool:** `_defaults.md` frontmatter files in agent directories for
  configurable fallback `tools`, `maxTurns`, `mcpServers`, and
  `missingAgentBehavior`
- **subagent-tool:** `resolveProjectRoot()` anchors project agent discovery to
  git root (falls back to cwd), replacing the previous ancestor-walk behavior
- **tool-display:** `wrap` option on `renderLines` — expanded tool output now
  soft-wraps long lines instead of truncating
- **wezterm-pane-control:** WezTerm pane management tool (split, close, focus,
  zoom, resize, send/read text, spawn tabs)
- **tallow-tui:** alternate screen terminal support
- **teams:** dashboard workspace with live task/teammate/message view,
  `/team-dashboard` command, `Ctrl+X` toggle, and keyboard navigation
- **shell-policy:** centralized shell execution policy with audit trail, trust
  levels, and allowlist enforcement
- **shell:** enforce high-risk confirmation for interactive bash tool calls
- **interop:** typed cross-extension event contracts (`interop.v1.*`) with
  schema-versioned payload validation
- **auth:** secure credential storage with environment variable references,
  replacing `--api-key` CLI flag
- **ci:** docs-drift checker in CI pipeline
- **tests:** 160+ new tests across high-risk extensions (shell-policy, interop,
  tasks, teams, architecture guards)

### Changed

- **subagent-tool:** project-local agents now run without confirmation prompts;
  `confirmProjectAgents` parameter deprecated (kept for compatibility, ignored)
- **extensions:** replace cross-extension `globalThis` state coupling with typed
  `pi.events` contracts and schema-versioned payload validation
- **tasks/teams-tool:** split oversized `index.ts` modules into thin composition
  roots with extracted domain modules
- **shell-interpolation:** require explicit opt-in by default
- **teams:** refine dashboard visuals with per-team personality markers, model
  labels, and live per-agent token meters
- Bun is now the canonical package manager

### Fixed

- **tallow-tui:** truncation ellipsis (`…`) now inherits ANSI styling instead of
  resetting to default background
- **shell-policy:** harden confirmation handling for high-risk commands;
  interrupted/canceled dialogs correctly treated as denied
- **ci:** stabilize workflows — build tallow-tui before typecheck/tests, make
  nested guard tests deterministic in headless environments

## [0.4.0](https://github.com/dungle-scrubs/tallow/compare/v0.3.0...v0.4.0) (2026-02-13)

### Added

- **rewind:** `/rewind` extension for undoing file changes to a previous turn
- **read tool:** PDF support via page range parameter
- **context-fork:** `context: fork` frontmatter for context branching
- **tui:** fork `pi-tui` as local package for direct modification
- **tui:** cap image height, fix Kitty warping, add optional rounded borders
- **tui:** clickable images and file paths via OSC 8 hyperlinks
- **tui:** Loader hide/show with HIDE sentinel
- **health:** wrap `/health` output in rounded border box
- **icons:** cli-spinners integration with random and named presets
- **init:** offer `.claude/` → `.tallow/` rename during `tallow init`
- **session-namer:** auto-generate session names via Haiku after first response
- **sessions:** per-cwd session migration module
- **custom-footer:** display session name as right-aligned 3rd row
- **footer:** move agent bar from stats line to footer line 3
- **ask-user:** hide Working... loader during question prompt
- **edit-tool-enhanced:** clickable diff link in edit footer
- **extensions:** agent sandboxing, `.claude/` bridging, MCP scoping
- **cli:** guard against nested interactive sessions
- **theme-selector:** `randomThemeOnStart` config option
- **test:** extension harness, mock model, and session runner
- **tasks:** clear task list when agent is cancelled mid-work
- Support icon field in skill frontmatter

### Fixed

- **tui:** clamp content and fix title width in BorderedBox
- **tui:** handle unterminated OSC sequences and clamp over-wide lines
- **tui:** override pi-tui to use tallow fork for all packages
- **claude-bridge:** package-aware collision detection and SKILL.md paths
- **cli:** prefer session name over truncated first message in `--list`
- **sessions:** scope `/resume` and `--list` to current project
- **sdk:** normalize skill names to directory name
- **skill-commands:** validate and normalize skill names before registration
- **security:** move shell interpolation to load-time boundary
- **tasks:** animate spinner for team teammate-owned tasks
- **tasks:** clear footer and refresh widget on team state changes
- **tasks:** fallback spinner frames when getSpinner returns null
- **tasks:** validate index param before using it
- **teams:** race `team_send` wait=true against abort signal
- **upstream:** check devDependencies and combine notifications
- **ask-user-question:** restore loader after user answers
- Strip all OSC sequences in `visibleWidth`
- Wrap long question text in ask-user-question tool

## [0.3.0](https://github.com/dungle-scrubs/tallow/compare/v0.2.0...v0.3.0) (2026-02-11)

### Added

- **Debug mode** — structured JSONL diagnostic logging to `~/.tallow/debug.log`
  - Activate via `--debug` flag, `TALLOW_DEBUG=1` env, or `NODE_ENV=development`
  - Logs tool timings, turn boundaries, model changes, subagent events, errors
  - `/diag` command for status, toggling, tailing, and clearing the log
  - Zero-cost when disabled — no file I/O or object allocation
- **Shell interpolation** — expand `` !`command` `` patterns in input by executing
  shell commands and inlining stdout. CC-compatible syntax. 5s timeout, 1MB max
  output, non-recursive
- **File references** — expand `@path/to/file` patterns in input by reading files
  and inlining contents in fenced code blocks. CC-compatible syntax. Skips emails,
  fenced code blocks, directories, and binary files. 100KB truncation
- **Subagent input expansion** — subagent task prompts now expand both `` !`cmd` ``
  and `@file` patterns before spawning
- **Team archive and resume** — `team_shutdown`, Escape, and session end now archive
  teams instead of deleting them. `team_resume` restores archived teams with their
  full task board, results, and messages
- **User-configurable icons** — override TUI glyphs via `icons` in settings.json
  - 13 icon keys with `getIcon()` and `getSpinner()` helpers
  - Migrated all 17 extensions from hardcoded literals to registry lookups
  - JSON Schema for settings.json with `$schema` for IDE autocompletion

### Changed

- **Subagent UI** — animated progress indicators for chain mode (spinner while
  running, checkmark/X on completion). Agent prose uses subdued color to recede
  behind structural elements.

## [0.2.0](https://github.com/dungle-scrubs/tallow/compare/v0.1.0...v0.2.0) (2026-02-11)

### Added

- **CLI flags** — `--provider` and `--api-key` for headless startup without
  interactive prompts. Install command gains `--default-provider`, `--default-model`,
  `--api-key`, `--theme`, and `--thinking` flags.

### Fixed

- **Plan mode** — extension tools now preserved across mode transitions instead
  of being dropped when toggling plan mode on/off.

## [0.1.0](https://github.com/dungle-scrubs/tallow/releases/tag/v0.1.0) (2026-02-11)

### Added

- Initial release
- 30+ bundled extensions (enhanced tools, hooks, tasks, teams, LSP, themes, and more)
- 34 terminal color themes
- 8 slash commands (`/implement`, `/review`, `/fix`, `/test`, `/scout-and-plan`,
  `/scaffold`, `/question`)
- 8 specialized agents (architect, debug, planner, refactor, reviewer, scout,
  worker, tallow-expert)
- Multi-agent teams with task boards and messaging
- SDK for programmatic usage (`createTallowSession`)
- Interactive installer (`tallow install`)
- CLI with print mode, RPC mode, and session management
