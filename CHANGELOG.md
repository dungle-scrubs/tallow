# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 (2026-02-15)


### Features

* add rewind extension and PDF support for read tool ([7479265](https://github.com/dungle-scrubs/tallow/commit/747926525d5d26e682ac1e3b7f6d79d72119e830))
* add wrap option to shared renderLines helper ([b32efc2](https://github.com/dungle-scrubs/tallow/commit/b32efc2f56559194276e3c14b36c3662f605f72f))
* **ask-user:** hide Working... loader during question prompt ([eb23d41](https://github.com/dungle-scrubs/tallow/commit/eb23d41e72baa50dc8415920aa8505e56f4bb4b2))
* **auth:** add secure auth storage with credential references ([df233be](https://github.com/dungle-scrubs/tallow/commit/df233be630df65f3e8df997ce51fb5adad2891d0))
* **auth:** remove --api-key CLI flag, use env vars instead ([a5edecf](https://github.com/dungle-scrubs/tallow/commit/a5edecf84a00aba2f52b38a3f4a2be60a2f3e2e8))
* **cli:** add --provider, --api-key flags and headless install setup ([941d281](https://github.com/dungle-scrubs/tallow/commit/941d281fe8697b73b5f0893ab3ab70d1e2279f0b))
* **cli:** guard against nested interactive sessions ([5e49980](https://github.com/dungle-scrubs/tallow/commit/5e49980112a76658037de5d2ce7894476be925f6))
* **context-fork:** add extension for context: fork frontmatter ([14d0824](https://github.com/dungle-scrubs/tallow/commit/14d0824470b5204f47773481a997ded7c4db4f6e))
* **custom-footer:** display session name as right-aligned 3rd row ([31b346d](https://github.com/dungle-scrubs/tallow/commit/31b346d2e2ba95e23c8949fb43499dc90864bc2e))
* **debug:** add structured diagnostic logging extension ([f9de8dd](https://github.com/dungle-scrubs/tallow/commit/f9de8dd2a7df8966dc25e9ae0c255967c7ebdc1a))
* **docs:** add favicon from logo ([1112730](https://github.com/dungle-scrubs/tallow/commit/11127305d97fd0461b342c593134e1cb99f741aa))
* **docs:** add interactive theme preview on landing page ([bbd54d2](https://github.com/dungle-scrubs/tallow/commit/bbd54d2beba364417a47db6150ff404764aa678e))
* **edit-tool-enhanced:** add clickable diff link to edit footer ([3c10c1b](https://github.com/dungle-scrubs/tallow/commit/3c10c1bfbb1b41409bdf8504c07f4eca95af5a99))
* **extensions:** agent sandboxing, .claude/ bridging, MCP scoping ([d4543dd](https://github.com/dungle-scrubs/tallow/commit/d4543dd0892c1cf0c463079a96a3bef11586a658))
* **file-reference:** expand [@path](https://github.com/path) patterns in input ([890470b](https://github.com/dungle-scrubs/tallow/commit/890470b36b78e143c0794a1ab0beaaa88615ff33))
* **footer:** move agent bar from stats line to footer line 3 ([1351384](https://github.com/dungle-scrubs/tallow/commit/13513844dd9a40d8d2f4059ab5725ae5680c99e6))
* **health:** wrap diagnostic output in rounded border box ([75a1096](https://github.com/dungle-scrubs/tallow/commit/75a1096d59e33f60ce67061384c97fb8b2b22d59))
* **icons:** add icon registry and settings schema ([d1ef9b8](https://github.com/dungle-scrubs/tallow/commit/d1ef9b818878fa6d551841fdfef78e41bd7ccbad))
* **icons:** integrate cli-spinners with random and named presets ([5a4f5a9](https://github.com/dungle-scrubs/tallow/commit/5a4f5a9aac78b4e4b59173c52cd242292ea4b09f))
* initial commit ([7f6ccac](https://github.com/dungle-scrubs/tallow/commit/7f6ccacd36798c0f1a904e05a6b9fc4d2f5abd59))
* **init:** offer .claude/ → .tallow/ rename during init ([3cc72f4](https://github.com/dungle-scrubs/tallow/commit/3cc72f4cc54ff4ac60d6613b1a90b07a865c5ce7))
* **interop:** add typed cross-extension event contracts ([0bea701](https://github.com/dungle-scrubs/tallow/commit/0bea701853f2dbd08303900d1f50936c2a614bff))
* **random-spinner:** add extension manifest and centipede spinner ([26edf73](https://github.com/dungle-scrubs/tallow/commit/26edf735c2f117bdcf1cf6b16d9d13783ea83a17))
* **session-namer:** auto-generate session names via Haiku after first response ([750543e](https://github.com/dungle-scrubs/tallow/commit/750543e5fa1aad31ac2edc1263cf71cd5d666edc))
* **sessions:** add per-cwd session migration module ([8358055](https://github.com/dungle-scrubs/tallow/commit/8358055835b486934d9eebe4fc376f0a3a7fa338))
* **shell-interpolation:** expand \!`cmd` patterns in input ([f9d236e](https://github.com/dungle-scrubs/tallow/commit/f9d236ee5a91233604802417fea52a1ab69b30c0))
* **shell-interpolation:** require explicit opt-in by default ([95b6df4](https://github.com/dungle-scrubs/tallow/commit/95b6df4d72dcaca847b755434a16eee4189d9aa8))
* **shell-policy:** add centralized policy and audit trail ([2407014](https://github.com/dungle-scrubs/tallow/commit/2407014ee3db34b21bfd589348ea539c0d57a561))
* **shell:** enforce high-risk confirmation for bash tools ([a06222d](https://github.com/dungle-scrubs/tallow/commit/a06222d4f7c0437a0a66100b0ea8a0d88617a119))
* **subagent-tool:** model inheritance, ephemeral recovery, defaults ([b3d435b](https://github.com/dungle-scrubs/tallow/commit/b3d435b51176838a350f8b6c06deedb6777698b6))
* **subagent:** add animated progress indicators to chain mode ([bb9680e](https://github.com/dungle-scrubs/tallow/commit/bb9680e4a8ef00cdac1645a7c5a9e66e8c8017c4))
* **subagent:** expand shell commands and file refs in task prompts ([b0fa788](https://github.com/dungle-scrubs/tallow/commit/b0fa7881b22cae6ee330de9d51b5204b314c1e50))
* support icon field in skill frontmatter ([5d46375](https://github.com/dungle-scrubs/tallow/commit/5d46375dbf5d5be903125c8d7dccec6e2ea5bf61))
* **tallow-tui:** add alternate screen terminal support ([23e1006](https://github.com/dungle-scrubs/tallow/commit/23e10065512c4173605ec703648dbc2ec28c268a))
* **tasks:** clear task list when agent is cancelled mid-work ([d9d5356](https://github.com/dungle-scrubs/tallow/commit/d9d535666d7c14d270ff5915fe206e665b431a4c))
* **teams-tool:** add live team dashboard workspace ([f89f337](https://github.com/dungle-scrubs/tallow/commit/f89f337d37d24b4f5d877b13e4c114c7fbb60670))
* **teams:** archive task lists on shutdown instead of deleting ([6a0cbaf](https://github.com/dungle-scrubs/tallow/commit/6a0cbafeb9f2a3a2a1bdadde0e0d3a9eda9397e1))
* **test:** add extension harness, mock model, and session runner ([2eff5a7](https://github.com/dungle-scrubs/tallow/commit/2eff5a76de2730be9f397ec457a9ae112301f72e))
* **theme-selector:** add randomThemeOnStart config ([d6147a9](https://github.com/dungle-scrubs/tallow/commit/d6147a9cee31d7bc8bec87d0606f8a376716a9be))
* **tools:** add clickable file paths via OSC 8 hyperlinks ([e269a34](https://github.com/dungle-scrubs/tallow/commit/e269a34addd705ccdd700f41394576137df73ffb))
* tui fork, cli-spinners, loader hide, health border, upstream check ([b251617](https://github.com/dungle-scrubs/tallow/commit/b25161759ccc2b54a4e191e1a07a54d114fe3e44))
* **tui:** add hide/show and HIDE sentinel to Loader ([8898850](https://github.com/dungle-scrubs/tallow/commit/8898850ed91d7930be2a1609bd86b11ed7679171))
* **tui:** add OSC 8 hyperlink utilities ([855a015](https://github.com/dungle-scrubs/tallow/commit/855a015dcd7a3f273da3a464c43b79e2c26d7ba4))
* **tui:** cap image height, fix warping, add optional borders ([a5fa048](https://github.com/dungle-scrubs/tallow/commit/a5fa048abcd1a18166fcc68fcdb3b9396167888a))
* **tui:** clickable images via OSC 8 file:// links ([73a151a](https://github.com/dungle-scrubs/tallow/commit/73a151a7774ed911ed5b92c610c10d4bb019f0ba))
* **tui:** fork pi-tui as local package ([404531a](https://github.com/dungle-scrubs/tallow/commit/404531a17702e7bf11c12a9173d2fa94b3538388))
* **tui:** make image area itself clickable via OSC 8 ([1a5cd2c](https://github.com/dungle-scrubs/tallow/commit/1a5cd2c917462b7eb612453f21cf9c5cad782b93))
* **wezterm-pane-control:** add WezTerm pane management tool ([e4fa920](https://github.com/dungle-scrubs/tallow/commit/e4fa9208e0094b56519f126c17479adfea5def95))
* wrap long lines in expanded tool output ([459c920](https://github.com/dungle-scrubs/tallow/commit/459c920f6ca3b3b82333b0c53bc307bd7c38a4e8))


### Bug Fixes

* **ask-user-question:** restore loader after user answers ([744299e](https://github.com/dungle-scrubs/tallow/commit/744299e5ea1f87a8ed56dd6c4299882eb9f7d6bb))
* **ci:** build tallow-tui before typecheck and repair context-fork tests ([3adfe95](https://github.com/dungle-scrubs/tallow/commit/3adfe95e0c806adcb570688c722ff3577bcfee7a))
* **ci:** build tallow-tui before unit tests ([15cc68b](https://github.com/dungle-scrubs/tallow/commit/15cc68b12d1490dbfb1e2f794ee8d4cb4e57aef3))
* **ci:** resolve biome lint errors in test files ([edf70b0](https://github.com/dungle-scrubs/tallow/commit/edf70b0d7cc6dd82703c42b5256fc873185191d8))
* **ci:** stabilize workflows and make tests CI-safe ([d7e9ca1](https://github.com/dungle-scrubs/tallow/commit/d7e9ca1236375c881cf71c06f84d6bfdcd4f21db))
* **ci:** use workspace protocol for tallow-tui fork ([0434ca8](https://github.com/dungle-scrubs/tallow/commit/0434ca869582122b62f37d70bd2478d1030fa5cb))
* **claude-bridge:** package-aware collision detection and SKILL.md paths ([2b7181c](https://github.com/dungle-scrubs/tallow/commit/2b7181ce4a080dfd33bff661281dd1e3fa5b0446))
* **claude-bridge:** skip .claude/skills/ entries that collide with tallow skills ([473cdb2](https://github.com/dungle-scrubs/tallow/commit/473cdb280a9f978d0901704452b8ca2130b672bf))
* **cli:** declare -y flag on install command ([2c1c167](https://github.com/dungle-scrubs/tallow/commit/2c1c1670c62a44606234020be3229d3471d13699))
* **cli:** prefer session name over truncated first message in --list ([5e7f028](https://github.com/dungle-scrubs/tallow/commit/5e7f028850a315291073fc03e558155a8780c8a0))
* **docs:** prevent theme swatch labels from wrapping ([ab0fb85](https://github.com/dungle-scrubs/tallow/commit/ab0fb85074bec8f2044363bd7e77f520f6b35d2c))
* **docs:** skip _icons from sidebar auto-generation ([1db0426](https://github.com/dungle-scrubs/tallow/commit/1db04262174e6131be84653a6ab6392e3c2fc47a))
* double-guard build step with tsconfig check ([4480d88](https://github.com/dungle-scrubs/tallow/commit/4480d8883c4a3ab470116e959537d61919d011eb))
* **extensions:** show full relative path in file tool headers ([351f483](https://github.com/dungle-scrubs/tallow/commit/351f4830dd60edfa813f09a992e3d3211bb5f11d))
* **install:** remove all build/link calls from installer ([31a2954](https://github.com/dungle-scrubs/tallow/commit/31a29541068dbd6961c10c1444df72fee33a72a2))
* **plan-mode:** preserve extension tools across mode transitions ([7fbd0b5](https://github.com/dungle-scrubs/tallow/commit/7fbd0b58a31d76e82ab3bfcc0674c0793275ebaf))
* preserve ANSI styling through truncation ellipsis ([dc22181](https://github.com/dungle-scrubs/tallow/commit/dc22181dbf0ed80a749980de50d494572fde08c0))
* **sdk:** normalize skill names to directory name ([2dd300b](https://github.com/dungle-scrubs/tallow/commit/2dd300be15e88f1178f14c0b3e9865179656c0a0))
* **security:** move shell interpolation to load-time boundary ([8ebf275](https://github.com/dungle-scrubs/tallow/commit/8ebf27500d39114a51818400bb3e636569f8ed5b))
* **sessions:** scope /resume and --list to current project ([6cce7f3](https://github.com/dungle-scrubs/tallow/commit/6cce7f34aab5f928aeaddb307318ce77eff75b96))
* **shell-policy:** harden confirmation handling and risk matching ([76882f3](https://github.com/dungle-scrubs/tallow/commit/76882f3b76bbfaf5c4466fca536a4402bc255a0f))
* **skill-commands:** validate and normalize skill names before registration ([9abec23](https://github.com/dungle-scrubs/tallow/commit/9abec23d70e91cf3b16f500c9b7dc1688ea74d91))
* skip build and npm link for npm installs ([473ebda](https://github.com/dungle-scrubs/tallow/commit/473ebdacc60e870014856f41324f415ac4d28dee))
* strip all OSC sequences in visibleWidth ([058d17f](https://github.com/dungle-scrubs/tallow/commit/058d17fea7fb61629fb85815845b31cdbc1b4b61))
* **tasks:** animate spinner for team teammate-owned tasks ([6c7a4ea](https://github.com/dungle-scrubs/tallow/commit/6c7a4ea9044cd8662315ab2d62e0bbfdbdb12461))
* **tasks:** clear footer and refresh widget on team state changes ([0ca5f28](https://github.com/dungle-scrubs/tallow/commit/0ca5f28c067d03f9ef7c6a07ac247481c5bd92a5))
* **tasks:** fallback spinner frames when getSpinner returns null ([3d116be](https://github.com/dungle-scrubs/tallow/commit/3d116bed5f2ad5333cd353deb33cd21018c04047))
* **tasks:** sharpen task completion instruction ([982296c](https://github.com/dungle-scrubs/tallow/commit/982296c7c05c719bb8755ae0364b0a5c0e99e37c))
* **tasks:** validate index param before using it ([f563aab](https://github.com/dungle-scrubs/tallow/commit/f563aab12f9bab8d6a2e50bd7d7587569e3e9c00))
* **teams:** race team_send wait=true against abort signal ([301e263](https://github.com/dungle-scrubs/tallow/commit/301e263bfb9f2c5f97bca2d0060f5c5811383bfb))
* **tui:** clamp content and fix title width in BorderedBox ([2e182dc](https://github.com/dungle-scrubs/tallow/commit/2e182dca37fd1aae247f2405bc580b882fd54edc))
* **tui:** handle unterminated OSC sequences and clamp over-wide lines ([6c538c2](https://github.com/dungle-scrubs/tallow/commit/6c538c24486c790043d5234dd18b243bd207c97a))
* **tui:** override pi-tui to use tallow fork for all packages ([a54874c](https://github.com/dungle-scrubs/tallow/commit/a54874c812b0925ef7ca16d0238b8cc7ad02d9d0))
* **upstream:** check devDependencies and combine notifications ([e11dd7d](https://github.com/dungle-scrubs/tallow/commit/e11dd7d7e78279dfded75323bc35ea2377505b73))
* wrap long question text in ask-user-question tool ([d129f98](https://github.com/dungle-scrubs/tallow/commit/d129f98db988afa494de22c5720052397405c210))

## [0.5.0](https://github.com/dungle-scrubs/tallow/compare/v0.4.0...v0.5.0) (2026-02-15)


### Features

* add wrap option to shared renderLines helper ([1f855bc](https://github.com/dungle-scrubs/tallow/commit/1f855bc771fbc003d61c7ff87be9ad2756c79681))
* **auth:** add secure auth storage with credential references ([bcdd4dc](https://github.com/dungle-scrubs/tallow/commit/bcdd4dc85160758c6e05d16de01db05678453a04))
* **auth:** remove --api-key CLI flag, use env vars instead ([87f656e](https://github.com/dungle-scrubs/tallow/commit/87f656ef86753e6c144f9acbffb763f8e152ad5c))
* **interop:** add typed cross-extension event contracts ([6f3896b](https://github.com/dungle-scrubs/tallow/commit/6f3896b2b2891b051c1f8a13487c93b429023346))
* **shell-interpolation:** require explicit opt-in by default ([94c62b0](https://github.com/dungle-scrubs/tallow/commit/94c62b0922c2123038c15dd73bb2ca8314d53fe3))
* **shell-policy:** add centralized policy and audit trail ([fe336b6](https://github.com/dungle-scrubs/tallow/commit/fe336b6775fbeab8912b025aba608bca6a94646e))
* **shell:** enforce high-risk confirmation for bash tools ([50d1e10](https://github.com/dungle-scrubs/tallow/commit/50d1e1001b0c7989c9c9ff08e3ba082b68f031c2))
* **subagent-tool:** model inheritance, ephemeral recovery, defaults ([400b634](https://github.com/dungle-scrubs/tallow/commit/400b634ad90e80d75ccd5c2315d3a845749db16b))
* **tallow-tui:** add alternate screen terminal support ([d310cf4](https://github.com/dungle-scrubs/tallow/commit/d310cf49174709eac8ec8501e33eb305bc5f23e3))
* **teams-tool:** add live team dashboard workspace ([f28e2ce](https://github.com/dungle-scrubs/tallow/commit/f28e2ce619233aad3a1b2db1fc63fa139f7fe320))
* **wezterm-pane-control:** add WezTerm pane management tool ([902f2c6](https://github.com/dungle-scrubs/tallow/commit/902f2c6d80e7f4428c6151ce9b8d65ea3bf4c165))
* wrap long lines in expanded tool output ([5709755](https://github.com/dungle-scrubs/tallow/commit/5709755b6404cb21331dd592717e5865d754ad46))


### Bug Fixes

* **ci:** build tallow-tui before typecheck and repair context-fork tests ([4e2cf60](https://github.com/dungle-scrubs/tallow/commit/4e2cf60922580133843382f5e7413acb569af7d2))
* **ci:** build tallow-tui before unit tests ([046a1c8](https://github.com/dungle-scrubs/tallow/commit/046a1c879f8a3d2f359b6163417d6cc32d08209b))
* **ci:** resolve biome lint errors in test files ([490a20b](https://github.com/dungle-scrubs/tallow/commit/490a20ba524921b38f14ba7301db02a38750512e))
* **ci:** stabilize workflows and make tests CI-safe ([b548de7](https://github.com/dungle-scrubs/tallow/commit/b548de716d09ec426f0db73d1e83bd231f91c3b5))
* **ci:** use workspace protocol for tallow-tui fork ([5ed1440](https://github.com/dungle-scrubs/tallow/commit/5ed14405dd2713bd571deb87a824804c28027f5a))
* preserve ANSI styling through truncation ellipsis ([d9e075e](https://github.com/dungle-scrubs/tallow/commit/d9e075ec30aa3e23766fa1bb090a77e3fca18297))
* **shell-policy:** harden confirmation handling and risk matching ([744ce07](https://github.com/dungle-scrubs/tallow/commit/744ce078c1165a49f075e3a4b1d5ec3193038873))

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
- **wezterm-pane-control:** add WezTerm pane management tool (split, close, focus,
  zoom, resize, send/read text, spawn tabs)
- **tallow-tui:** alternate screen terminal support
- **teams:** add dashboard workspace with live task/teammate/message view,
  `/team-dashboard` command, `Ctrl+X` toggle, and keyboard navigation controls
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
- **tasks:** migrate widget/agent-bar consumers to typed interop snapshots with
  load-order-safe state requests
- **tasks/teams-tool:** split oversized `index.ts` modules into thin composition
  roots with extracted domain modules (`state`, `parsing`, `agents`, `ui`,
  `commands`, `dispatch`, `sessions`, `tools`, `dashboard`)
- **shell-interpolation:** require explicit opt-in by default
- **teams:** refine dashboard visuals with per-team personality markers, model
  labels in the left tree, and live per-agent token meters
- **chore:** make bun the canonical package manager (CI and contributor commands)

### Fixed

- **tallow-tui:** truncation ellipsis (`…`) now inherits ANSI styling of the
  truncated line instead of resetting to default background
- **shell-policy:** harden confirmation handling for high-risk explicit commands;
  interrupted/canceled dialogs correctly treated as denied
- **ci:** stabilize workflows — build tallow-tui before typecheck/tests, make
  nested guard tests deterministic in headless environments

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
