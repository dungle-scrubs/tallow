# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **teams:** add dashboard workspace with live task/teammate/message view,
  `/team-dashboard` command, `Ctrl+X` toggle, and keyboard navigation controls
- **tests:** add interop integration coverage for cross-extension state requests,
  typed snapshot delivery, and schema-version rejection behavior

### Changed

- **extensions:** replace cross-extension `globalThis` state coupling with typed
  `pi.events` contracts (`interop.v1.*`) and schema-versioned payload validation
- **tasks:** migrate widget/agent-bar consumers to typed interop snapshots with
  load-order-safe state requests and a temporary legacy bridge adapter
- **shell-policy:** fix confirmation handling for high-risk explicit commands,
  treating interrupted/canceled dialogs as denied while allowing confirmed
  commands and reducing quoted-string false positives in risk matching
- **teams:** refine dashboard visuals with per-team personality markers, subdued divider colors,
  5-line output previews, model labels in the left tree, and live per-agent token meters
  (`↑` input, `↓` output)
- **teams:** drop `Ctrl+Y` dashboard toggle to avoid conflict with editor yank
- **docs:** sync keyboard shortcut reference for teams dashboard toggles and controls in extension docs

## [0.4.0](https://github.com/dungle-scrubs/tallow/compare/v0.3.0...v0.4.0) (2026-02-13)


### Features

* add rewind extension and PDF support for read tool ([f15732d](https://github.com/dungle-scrubs/tallow/commit/f15732d2e07ea39b7fb7a94721b3387d04861557))
* **ask-user:** hide Working... loader during question prompt ([dc83b93](https://github.com/dungle-scrubs/tallow/commit/dc83b9346657b3879a8a30be23322afbead3f54c))
* **cli:** guard against nested interactive sessions ([843dc05](https://github.com/dungle-scrubs/tallow/commit/843dc05b80bb59c1fd4db8064074a76057218da6))
* **context-fork:** add extension for context: fork frontmatter ([8ff4be6](https://github.com/dungle-scrubs/tallow/commit/8ff4be6ea295eaf2252bab77e0b05d740b755a2e))
* **custom-footer:** display session name as right-aligned 3rd row ([7db0643](https://github.com/dungle-scrubs/tallow/commit/7db0643f0d0b0d6dfbd0927e0f28257a0050f350))
* **docs:** add favicon from logo ([11b321c](https://github.com/dungle-scrubs/tallow/commit/11b321c5a6a33b53b029a677ee29f1cc0b0d4259))
* **docs:** add interactive theme preview on landing page ([0a79b09](https://github.com/dungle-scrubs/tallow/commit/0a79b094f70a217ebc4e2ff7b5e2db0fdb4843ad))
* **edit-tool-enhanced:** add clickable diff link to edit footer ([fe02c45](https://github.com/dungle-scrubs/tallow/commit/fe02c4566a4014dfcab478a14c1bd45b12f85f92))
* **extensions:** agent sandboxing, .claude/ bridging, MCP scoping ([b863494](https://github.com/dungle-scrubs/tallow/commit/b86349417cb1602a45f0f37cf438b3f5bc0c6293))
* **footer:** move agent bar from stats line to footer line 3 ([b44c474](https://github.com/dungle-scrubs/tallow/commit/b44c4745ace88201e354cbb3348a1e9acb6ad878))
* **health:** wrap diagnostic output in rounded border box ([761dd14](https://github.com/dungle-scrubs/tallow/commit/761dd14fb14377990d7d917d3c9fcfe03b23b34c))
* **icons:** integrate cli-spinners with random and named presets ([73fcbf2](https://github.com/dungle-scrubs/tallow/commit/73fcbf209ce5436fac63faf6ebda3edb901fe6a5))
* **init:** offer .claude/ → .tallow/ rename during init ([a695254](https://github.com/dungle-scrubs/tallow/commit/a695254c851e6e0950576c967653b98a29463fe4))
* **random-spinner:** add extension manifest and centipede spinner ([dc59333](https://github.com/dungle-scrubs/tallow/commit/dc59333540c7d539b03f0bc0a617e9773b8e0a67))
* **session-namer:** auto-generate session names via Haiku after first response ([6f4a11f](https://github.com/dungle-scrubs/tallow/commit/6f4a11fa5dc6ff67d4c9833da7a071a2ee017e3e))
* **sessions:** add per-cwd session migration module ([e6f5a27](https://github.com/dungle-scrubs/tallow/commit/e6f5a27be6758cdf65bcedb83e618720c6893568))
* support icon field in skill frontmatter ([6fcfd3b](https://github.com/dungle-scrubs/tallow/commit/6fcfd3bb2e613bb925f7ff8ec90104f66044b344))
* **tasks:** clear task list when agent is cancelled mid-work ([9ac9564](https://github.com/dungle-scrubs/tallow/commit/9ac9564b26ede2d8854430b7456604bf6ffbe4c1))
* **test:** add extension harness, mock model, and session runner ([68fd1fa](https://github.com/dungle-scrubs/tallow/commit/68fd1faaee86e96321c75c37c6379b11e2c2238a))
* **theme-selector:** add randomThemeOnStart config ([87d67bb](https://github.com/dungle-scrubs/tallow/commit/87d67bb024a19abf003cc9a12db9942257f7d1dc))
* **tools:** add clickable file paths via OSC 8 hyperlinks ([c0aeeee](https://github.com/dungle-scrubs/tallow/commit/c0aeeee231a2efffd775c1428ab7e7337fd1c1b9))
* tui fork, cli-spinners, loader hide, health border, upstream check ([81bff21](https://github.com/dungle-scrubs/tallow/commit/81bff21f4a60eb87919c46fe3d2781106153419b))
* **tui:** add hide/show and HIDE sentinel to Loader ([fd6b714](https://github.com/dungle-scrubs/tallow/commit/fd6b7142dcd0aed562d5165287aaffea71b827e9))
* **tui:** add OSC 8 hyperlink utilities ([aa64271](https://github.com/dungle-scrubs/tallow/commit/aa64271017b90b8f07f7f6eb785144cd7e0abe9b))
* **tui:** cap image height, fix warping, add optional borders ([366d05e](https://github.com/dungle-scrubs/tallow/commit/366d05e404de13d0d7dbb5c2c364b58fc6049b04))
* **tui:** clickable images via OSC 8 file:// links ([6dc038b](https://github.com/dungle-scrubs/tallow/commit/6dc038be9f7f4675daaf4477222e64fb3034699b))
* **tui:** fork pi-tui as local package ([b347a9b](https://github.com/dungle-scrubs/tallow/commit/b347a9b70ef6a515080008beb421ca729844bcd8))
* **tui:** make image area itself clickable via OSC 8 ([36bf9a2](https://github.com/dungle-scrubs/tallow/commit/36bf9a2591cc21c1b64f03962f6ac0ceaa7af64d))


### Bug Fixes

* **ask-user-question:** restore loader after user answers ([f456175](https://github.com/dungle-scrubs/tallow/commit/f456175b33fea8b7f4c7b26dccdd0e6810d4a224))
* **claude-bridge:** package-aware collision detection and SKILL.md paths ([90af498](https://github.com/dungle-scrubs/tallow/commit/90af4986878cf191665542848f6317557630aeb3))
* **claude-bridge:** skip .claude/skills/ entries that collide with tallow skills ([a45fbae](https://github.com/dungle-scrubs/tallow/commit/a45fbae1845e1075eea65272e7bf7ad4425f8761))
* **cli:** prefer session name over truncated first message in --list ([4f87c06](https://github.com/dungle-scrubs/tallow/commit/4f87c066f9427be4900512194c36858c9bc21afa))
* **docs:** skip _icons from sidebar auto-generation ([a85e19b](https://github.com/dungle-scrubs/tallow/commit/a85e19b998e8f1ee7e139cbe27537783612f9fc2))
* **extensions:** show full relative path in file tool headers ([c5f6b3a](https://github.com/dungle-scrubs/tallow/commit/c5f6b3ad157e4d906b2dc5736c9959f8487ec40a))
* **sdk:** normalize skill names to directory name ([bd38b31](https://github.com/dungle-scrubs/tallow/commit/bd38b31fffd019ab5cfc9a7c654d4f4f834c75f6))
* **security:** move shell interpolation to load-time boundary ([78800e9](https://github.com/dungle-scrubs/tallow/commit/78800e986d1afd5eb45558910d99e4e791ac4fc4))
* **sessions:** scope /resume and --list to current project ([a1ebe2f](https://github.com/dungle-scrubs/tallow/commit/a1ebe2fdf1b9092ddc48e498ea22707fe1d0d083))
* **skill-commands:** validate and normalize skill names before registration ([7671be5](https://github.com/dungle-scrubs/tallow/commit/7671be5a5393b994db5d5095e4babc78c4e54e61))
* strip all OSC sequences in visibleWidth ([8a19dc8](https://github.com/dungle-scrubs/tallow/commit/8a19dc85519820239d4a32e1f239e83a980bb2f6))
* **tasks:** animate spinner for team teammate-owned tasks ([05ca7e8](https://github.com/dungle-scrubs/tallow/commit/05ca7e8e79f9fb6ce5dd853a769b4c7ab35f18e7))
* **tasks:** clear footer and refresh widget on team state changes ([4df6a3e](https://github.com/dungle-scrubs/tallow/commit/4df6a3e394cab68b2ffb01a1adee9b9172d71130))
* **tasks:** fallback spinner frames when getSpinner returns null ([925d842](https://github.com/dungle-scrubs/tallow/commit/925d842ed3958abe544c3f8e02b1a9682819595e))
* **tasks:** sharpen task completion instruction ([a3f0889](https://github.com/dungle-scrubs/tallow/commit/a3f08890f9778ec60a2dc1f123bf129f8b7c291e))
* **tasks:** validate index param before using it ([46b8f13](https://github.com/dungle-scrubs/tallow/commit/46b8f135f20d9aeb4d297fea79fd55aac1bdffce))
* **teams:** race team_send wait=true against abort signal ([7d9acfb](https://github.com/dungle-scrubs/tallow/commit/7d9acfb1893bf6a2207b2e340ed795a6a2c9353f))
* **tui:** clamp content and fix title width in BorderedBox ([69a6ee9](https://github.com/dungle-scrubs/tallow/commit/69a6ee96f2cde3f669096ef94811c81f1d82db8a))
* **tui:** handle unterminated OSC sequences and clamp over-wide lines ([af54eab](https://github.com/dungle-scrubs/tallow/commit/af54eabd023d5929fbe428ce2544811bde253083))
* **tui:** override pi-tui to use tallow fork for all packages ([61e071b](https://github.com/dungle-scrubs/tallow/commit/61e071bcfaa1c00608cfe1f7523a6bb9082ac469))
* **upstream:** check devDependencies and combine notifications ([3c2de41](https://github.com/dungle-scrubs/tallow/commit/3c2de4126992e4bf2351980a56def091f7657213))
* wrap long question text in ask-user-question tool ([794265e](https://github.com/dungle-scrubs/tallow/commit/794265e069891ef421adf868d8772a1d42b20118))

## [0.3.0](https://github.com/dungle-scrubs/tallow/compare/v0.2.0...v0.3.0) (2026-02-11)

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
- 8 slash commands (`/implement`, `/review`, `/fix`, `/test`, `/scout-and-plan`, `/scaffold`, `/question`)
- 8 specialized agents (architect, debug, planner, refactor, reviewer, scout, worker, tallow-expert)
- Multi-agent teams with task boards and messaging
- SDK for programmatic usage (`createTallowSession`)
- Interactive installer (`tallow install`)
- CLI with print mode, RPC mode, and session management
