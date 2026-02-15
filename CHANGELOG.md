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
* **background-task-tool,subagent-tool:** inline completion notifications ([e73efe3](https://github.com/dungle-scrubs/tallow/commit/e73efe322ef43aa34e1746fad80d0e24e6306c1b))
* **bash-tool-enhanced,cd-tool:** BASH_MAINTAIN_PROJECT_WORKING_DIR setting ([58ea016](https://github.com/dungle-scrubs/tallow/commit/58ea016603384130ad9732bba281fe5dcf956b57))
* **bash-tool-enhanced:** auto-background long-running commands ([e51fa92](https://github.com/dungle-scrubs/tallow/commit/e51fa920cefb5659df5289c5bd706d216d4adf23))
* **cli:** add --provider, --api-key flags and headless install setup ([941d281](https://github.com/dungle-scrubs/tallow/commit/941d281fe8697b73b5f0893ab3ab70d1e2279f0b))
* **cli:** add piped stdin support ([807c08a](https://github.com/dungle-scrubs/tallow/commit/807c08a205dff393256a9251f93b392cb81afb27))
* **cli:** guard against nested interactive sessions ([5e49980](https://github.com/dungle-scrubs/tallow/commit/5e49980112a76658037de5d2ce7894476be925f6))
* **context-files:** add /add-dir and /clear-dirs commands ([aa4ab7d](https://github.com/dungle-scrubs/tallow/commit/aa4ab7d2a3bc920f01d4b3063621c28723164d1f))
* **context-fork:** add extension for context: fork frontmatter ([14d0824](https://github.com/dungle-scrubs/tallow/commit/14d0824470b5204f47773481a997ded7c4db4f6e))
* **core:** --tools flag to restrict available tools per session ([6b7c598](https://github.com/dungle-scrubs/tallow/commit/6b7c598ae1784ea9a89093f87bdc7f297213ede9))
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
* **mcp-adapter-tool:** capture and inject server instructions ([89819a6](https://github.com/dungle-scrubs/tallow/commit/89819a6a51c2d0082ae02e22f813852eacf1410d))
* **mcp-adapter-tool:** resource_link content type support ([ddde3b4](https://github.com/dungle-scrubs/tallow/commit/ddde3b494ce0a3b47103b022e916bc66d6207a70))
* **mcp-adapter-tool:** structured content support in MCP responses ([358c94b](https://github.com/dungle-scrubs/tallow/commit/358c94b891e9ec541defbbf7c716bb2f8cbe63e3))
* **progress-indicator:** add terminal progress bar extension ([173429c](https://github.com/dungle-scrubs/tallow/commit/173429c75ae4ac4398b0441de64a121f51e7c649))
* **prompt-suggestions:** idle ghost text and Groq inline autocomplete ([910afeb](https://github.com/dungle-scrubs/tallow/commit/910afeb3a461b0dfc7ddd20cc54718647441c55e))
* **random-spinner:** add extension manifest and centipede spinner ([26edf73](https://github.com/dungle-scrubs/tallow/commit/26edf735c2f117bdcf1cf6b16d9d13783ea83a17))
* **random-spinner:** scramble-decrypt reveal animation for spinner verbs ([b709758](https://github.com/dungle-scrubs/tallow/commit/b7097588541f51138e285c34ed25c633b843defe))
* **read-tool-enhanced:** byte-based image format detection ([f212b22](https://github.com/dungle-scrubs/tallow/commit/f212b22d2d65578b47473d5e6ba2cd7bf6c420b1))
* **read-tool-enhanced:** image dimension metadata in read results ([b9d8ec7](https://github.com/dungle-scrubs/tallow/commit/b9d8ec77212c38aaa0aec53273e4650b97daa316))
* **session-namer:** auto-generate session names via Haiku after first response ([750543e](https://github.com/dungle-scrubs/tallow/commit/750543e5fa1aad31ac2edc1263cf71cd5d666edc))
* **sessions:** add per-cwd session migration module ([8358055](https://github.com/dungle-scrubs/tallow/commit/8358055835b486934d9eebe4fc376f0a3a7fa338))
* **shared:** add extractPreview utility for inline result notifications ([8eecab3](https://github.com/dungle-scrubs/tallow/commit/8eecab32d6458e8fdd06d06c33b4ee7ea19f00f3))
* **shell-interpolation:** expand \!`cmd` patterns in input ([f9d236e](https://github.com/dungle-scrubs/tallow/commit/f9d236ee5a91233604802417fea52a1ab69b30c0))
* **shell-interpolation:** require explicit opt-in by default ([95b6df4](https://github.com/dungle-scrubs/tallow/commit/95b6df4d72dcaca847b755434a16eee4189d9aa8))
* **shell-policy:** add centralized policy and audit trail ([2407014](https://github.com/dungle-scrubs/tallow/commit/2407014ee3db34b21bfd589348ea539c0d57a561))
* **shell:** enforce high-risk confirmation for bash tools ([a06222d](https://github.com/dungle-scrubs/tallow/commit/a06222d4f7c0437a0a66100b0ea8a0d88617a119))
* **slash-command-bridge:** add slash command bridge extension ([4fc11f9](https://github.com/dungle-scrubs/tallow/commit/4fc11f95b15506b774cc3529603805c0c4ab43fe))
* **subagent-tool:** auto-cheap routing keywords and explore agent ([d815a44](https://github.com/dungle-scrubs/tallow/commit/d815a449bcd2b76f599c6099087a6688922cf19e))
* **subagent-tool:** fuzzy model name resolution ([880c6b2](https://github.com/dungle-scrubs/tallow/commit/880c6b2f3f033207640da9fa89fa44bc5dd5b139))
* **subagent-tool:** live token usage during execution ([5844125](https://github.com/dungle-scrubs/tallow/commit/5844125a04fae6605f1b5f8bd6485d31ba9962a0))
* **subagent-tool:** model capability matrix and task classifier ([fff5635](https://github.com/dungle-scrubs/tallow/commit/fff5635e3af74aaeb40d1a6fc1d20c831995dc63))
* **subagent-tool:** model inheritance, ephemeral recovery, defaults ([b3d435b](https://github.com/dungle-scrubs/tallow/commit/b3d435b51176838a350f8b6c06deedb6777698b6))
* **subagent-tool:** model router with auto-routing and fallback ([530ff3a](https://github.com/dungle-scrubs/tallow/commit/530ff3a3a0959f2a2eb68a69480517d2ebe0321f))
* **subagent-tool:** wire routing into spawn flow ([3c7b59d](https://github.com/dungle-scrubs/tallow/commit/3c7b59dfdadbd1d9eef525882a121ee98a6bb1d6))
* **subagent:** add animated progress indicators to chain mode ([bb9680e](https://github.com/dungle-scrubs/tallow/commit/bb9680e4a8ef00cdac1645a7c5a9e66e8c8017c4))
* **subagent:** expand shell commands and file refs in task prompts ([b0fa788](https://github.com/dungle-scrubs/tallow/commit/b0fa7881b22cae6ee330de9d51b5204b314c1e50))
* support icon field in skill frontmatter ([5d46375](https://github.com/dungle-scrubs/tallow/commit/5d46375dbf5d5be903125c8d7dccec6e2ea5bf61))
* **tallow-tui:** add alternate screen terminal support ([23e1006](https://github.com/dungle-scrubs/tallow/commit/23e10065512c4173605ec703648dbc2ec28c268a))
* **tallow-tui:** add OSC 9;4 progress bar support ([a8fbd73](https://github.com/dungle-scrubs/tallow/commit/a8fbd73d7ac822143468850a4f67cac34d181ab5))
* **tallow-tui:** addChangeListener API and darker ghost text ([2fade18](https://github.com/dungle-scrubs/tallow/commit/2fade183accba996de99755a237ee002cbe2d600))
* **tallow-tui:** ghost text rendering in Editor component ([68fcd63](https://github.com/dungle-scrubs/tallow/commit/68fcd6360fc77b724f09d015955532107233e2c8))
* **tasks:** clear task list when agent is cancelled mid-work ([d9d5356](https://github.com/dungle-scrubs/tallow/commit/d9d535666d7c14d270ff5915fe206e665b431a4c))
* **teams-tool:** add live team dashboard workspace ([f89f337](https://github.com/dungle-scrubs/tallow/commit/f89f337d37d24b4f5d877b13e4c114c7fbb60670))
* **teams:** archive task lists on shutdown instead of deleting ([6a0cbaf](https://github.com/dungle-scrubs/tallow/commit/6a0cbafeb9f2a3a2a1bdadde0e0d3a9eda9397e1))
* **test:** add extension harness, mock model, and session runner ([2eff5a7](https://github.com/dungle-scrubs/tallow/commit/2eff5a76de2730be9f397ec457a9ae112301f72e))
* **theme-selector:** add randomThemeOnStart config ([d6147a9](https://github.com/dungle-scrubs/tallow/commit/d6147a9cee31d7bc8bec87d0606f8a376716a9be))
* **tool-display:** add formatToolVerb utility for tense-aware rendering ([60a1e60](https://github.com/dungle-scrubs/tallow/commit/60a1e608b2d95eb03e123657dd30708f7b789277))
* **tools:** add clickable file paths via OSC 8 hyperlinks ([e269a34](https://github.com/dungle-scrubs/tallow/commit/e269a34addd705ccdd700f41394576137df73ffb))
* **tools:** use tense-aware verbs in tool headers and footers ([0a4364f](https://github.com/dungle-scrubs/tallow/commit/0a4364f5b80197ee35d3fe1754e6f2f180a33f12))
* tui fork, cli-spinners, loader hide, health border, upstream check ([b251617](https://github.com/dungle-scrubs/tallow/commit/b25161759ccc2b54a4e191e1a07a54d114fe3e44))
* **tui:** add detectImageFormat and imageFormatToMime utilities ([79b50ef](https://github.com/dungle-scrubs/tallow/commit/79b50efe416432cd75f06b5f2dc6f7ffe1e768b5))
* **tui:** add hide/show and HIDE sentinel to Loader ([8898850](https://github.com/dungle-scrubs/tallow/commit/8898850ed91d7930be2a1609bd86b11ed7679171))
* **tui:** add ImageMetadata type and dimension formatting ([d209b54](https://github.com/dungle-scrubs/tallow/commit/d209b544980ba55102aaf0b0a760a9d589a67360))
* **tui:** add OSC 8 hyperlink utilities ([855a015](https://github.com/dungle-scrubs/tallow/commit/855a015dcd7a3f273da3a464c43b79e2c26d7ba4))
* **tui:** cap image height, fix warping, add optional borders ([a5fa048](https://github.com/dungle-scrubs/tallow/commit/a5fa048abcd1a18166fcc68fcdb3b9396167888a))
* **tui:** clickable images via OSC 8 file:// links ([73a151a](https://github.com/dungle-scrubs/tallow/commit/73a151a7774ed911ed5b92c610c10d4bb019f0ba))
* **tui:** fork pi-tui as local package ([404531a](https://github.com/dungle-scrubs/tallow/commit/404531a17702e7bf11c12a9173d2fa94b3538388))
* **tui:** make image area itself clickable via OSC 8 ([1a5cd2c](https://github.com/dungle-scrubs/tallow/commit/1a5cd2c917462b7eb612453f21cf9c5cad782b93))
* **web-search-tool:** add web search via Brave Search API ([242c38d](https://github.com/dungle-scrubs/tallow/commit/242c38df66c9185de212c4ec57155d9ac3bab959))
* **wezterm-pane-control:** add WezTerm pane management tool ([e4fa920](https://github.com/dungle-scrubs/tallow/commit/e4fa9208e0094b56519f126c17479adfea5def95))
* wrap long lines in expanded tool output ([459c920](https://github.com/dungle-scrubs/tallow/commit/459c920f6ca3b3b82333b0c53bc307bd7c38a4e8))


### Bug Fixes

* **ask-user-question:** restore loader after user answers ([744299e](https://github.com/dungle-scrubs/tallow/commit/744299e5ea1f87a8ed56dd6c4299882eb9f7d6bb))
* **bg:** force full re-render when dismissing /bg viewer ([7838f05](https://github.com/dungle-scrubs/tallow/commit/7838f054c5a2d6916914d153d8c2bbc8f7760dad))
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
* **prompt-suggestions:** use CustomEditor, register Groq, fix autocomplete ([340c412](https://github.com/dungle-scrubs/tallow/commit/340c41257948584f17f6f3b11630efa397735f9e))
* **random-spinner:** stabilize centipede animation ([bc20443](https://github.com/dungle-scrubs/tallow/commit/bc20443921c079b9222c7028a28d8cb47ae777ae))
* **sdk:** normalize skill names to directory name ([2dd300b](https://github.com/dungle-scrubs/tallow/commit/2dd300be15e88f1178f14c0b3e9865179656c0a0))
* **security:** move shell interpolation to load-time boundary ([8ebf275](https://github.com/dungle-scrubs/tallow/commit/8ebf27500d39114a51818400bb3e636569f8ed5b))
* **session-namer:** reject LLM refusals as session names ([b096b12](https://github.com/dungle-scrubs/tallow/commit/b096b125134c6b9ecdccc5a132f655fae6bb91ed))
* **sessions:** scope /resume and --list to current project ([6cce7f3](https://github.com/dungle-scrubs/tallow/commit/6cce7f34aab5f928aeaddb307318ce77eff75b96))
* **shell-policy:** harden confirmation handling and risk matching ([76882f3](https://github.com/dungle-scrubs/tallow/commit/76882f3b76bbfaf5c4466fca536a4402bc255a0f))
* **skill-commands:** validate and normalize skill names before registration ([9abec23](https://github.com/dungle-scrubs/tallow/commit/9abec23d70e91cf3b16f500c9b7dc1688ea74d91))
* skip build and npm link for npm installs ([473ebda](https://github.com/dungle-scrubs/tallow/commit/473ebdacc60e870014856f41324f415ac4d28dee))
* **slash-command-bridge:** pass CompactOptions callbacks in compact tool ([d7d24af](https://github.com/dungle-scrubs/tallow/commit/d7d24af7ea1d53b9ad41cf20e8e8e14843e41696))
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

## [Unreleased]

### Added

- **prompt-suggestions:** ghost text suggestions in the editor — curated idle
  templates when input is empty (Enter to accept), plus LLM-powered inline
  autocomplete as you type (Tab to accept). Uses Groq Llama 3.1 8B by default
  ($0.05/M tokens). Configurable model, debounce, and per-session cost cap
- **tallow-tui:** `setGhostText()` / `getGhostText()` on Editor component for
  inline suggestion rendering; added to `EditorComponent` interface
- **core:** `--tools` CLI flag to restrict available tools per session — supports
  individual names (`read,bash,edit`), presets (`readonly`, `coding`, `none`),
  and validates with clear error messages
- **bash-tool-enhanced:** `BASH_MAINTAIN_PROJECT_WORKING_DIR` setting — resets
  bash execution to the project root before each command, preventing directory
  drift from `cd` tool calls
- **cd-tool:** warning when `BASH_MAINTAIN_PROJECT_WORKING_DIR` is enabled,
  noting that bash commands still run from the project root
- **mcp-adapter-tool:** server instructions support — captures `instructions`
  from MCP initialize responses and injects them into the system prompt before
  tool listings, giving servers a way to declare usage guidance
- **mcp-adapter-tool:** structured content support — handles `resource` and
  annotated content types from MCP servers, with safe fallback serialization
  for unknown types
- **mcp-adapter-tool:** `resource_link` content type — renders fetchable
  resource pointers with URI, MIME type, and description as readable text
  references
- **tui:** `ImageMetadata` type, `createImageMetadata()`, and
  `formatImageDimensions()` for tracking original vs display dimensions when
  images are resized before API upload
- **tui:** `detectImageFormat(buffer)` and `imageFormatToMime()` utilities for
  identifying PNG/JPEG/GIF/WebP from file header magic numbers without external
  dependencies
- **read-tool-enhanced:** image dimension metadata — captures original and
  display dimensions, format, and file size when reading images; shows compact
  summary like `image.png (PNG, 3840×2160 → 1920×1080, 245KB)`
- **read-tool-enhanced:** byte-based image format detection — reads first 12
  bytes to identify images regardless of file extension, complementing the base
  tool's `file-type` detection
- **background-task-tool:** inline completion notifications for fire-and-forget
  background tasks — shows status icon, exit code, duration, and 3-line output
  preview as a chat message when `background: true` tasks complete
- **subagent-tool:** inline completion notifications for background subagents —
  shows agent name, duration, and 3-line response preview when background
  subagents finish
- **background-task-tool:** `/toggle-inline-results` command to enable/disable
  inline result notifications (persists to settings.json, enabled by default)
- **core:** piped stdin support — `cat file.md | tallow` reads stdin and enters
  print mode automatically, combinable with `-p` for context + prompt workflows,
  with 10 MB size limit and JSON mode support
- **subagent-tool:** `auto-cheap`/`auto-premium` routing keywords for agent
  frontmatter — set `model: auto-cheap` to force eco routing without picking a
  specific model, integrates with existing cost preference and per-call hints
- **agents:** bundled `explore` agent for cheap codebase discovery — uses
  `auto-cheap` routing, read-only tools (read/grep/find/ls), and a 5-turn
  budget for economical exploration tasks
- **bash-tool-enhanced:** auto-background long-running commands after
  configurable timeout (default 30s) — promotes to background-task-tool
  with seamless output handoff and task_kill support
- **subagent-tool:** live token usage display during subagent execution —
  per-agent counters update in real-time for single, parallel, and centipede
  modes with 500ms throttled updates
- **context-files:** `/add-dir` command to register additional directories for
  context file discovery, with `/clear-dirs` to reset
- **progress-indicator:** terminal progress bar via OSC 9;4 during agent turns,
  with indeterminate mode for pulsing tab/title bar indicators
- **tallow-tui:** `setProgress(percent)` and `clearProgress()` methods on
  Terminal interface for OSC 9;4 progress bar support with 100ms throttling
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
