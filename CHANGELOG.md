# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.25](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.24...tallow-v0.8.25) (2026-03-18)


### Fixed

* **ci:** resolve workspace:* references before npm publish ([1bc8bdb](https://github.com/dungle-scrubs/tallow/commit/1bc8bdb0ad25e2d725bec5a67ac3303e590601e8))
* **skill-commands:** register slash commands for sharedSkillsDirs skills ([905e3b7](https://github.com/dungle-scrubs/tallow/commit/905e3b752954298198eac8d1bb5cb94aa0f8096c))


### Documentation

* changelog entries for skill-commands fix and tui sync ([999fe8e](https://github.com/dungle-scrubs/tallow/commit/999fe8e48e252ebb0e430da6dfdcf3ca0796ce09))


### Maintenance

* remove dead plan-rejection-feedback tests ([c65670f](https://github.com/dungle-scrubs/tallow/commit/c65670fd6cf17450198776be1c5c487598cfe19e))
* **tui:** sync forked pi-tui to upstream v0.60.0 ([4f44580](https://github.com/dungle-scrubs/tallow/commit/4f445801a16a8653e92ff565283ccbca9f1c5534))

## [Unreleased]

### Added

- **sdk:** `sharedSkillsDirs` global setting — load skills from cross-app
  directories (e.g. `~/.skills`) shared between tallow and other tools.
  Paths must be absolute or `~/`-prefixed; project settings cannot override.
  Non-existent directories are silently skipped
- **otel:** opt-in OpenTelemetry distributed tracing via `telemetry` option
  in `TallowSessionOptions`. Emits `tallow.*` spans for session lifecycle,
  prompt turns, tool calls, and model invocations. All span attributes are
  metadata-only — no prompt text, tool payloads, or secrets are captured.
  Zero-cost no-op when disabled
- **otel:** W3C `traceparent`/`tracestate` propagation through CLI env and
  subagent child processes for cross-process trace continuity
- **otel:** safe attribute builders (`sessionAttributes`, `promptAttributes`,
  `modelAttributes`, `toolAttributes`, `subagentAttributes`,
  `teammateAttributes`) with CWD hashing and redaction guarantees
- **otel:** event bus telemetry handle sharing so extensions can access trace
  context without direct coupling
- **loop:** `/loop` command — run a prompt or slash command on a recurring
  interval (e.g. `/loop 5m check deploy`). Uses post-completion delay to
  prevent overlapping runs, with live countdown in the status bar
- **shell-policy:** "Always Allow" option for high-risk shell command
  confirmations — persists `Bash(pattern)` rules to
  `~/.tallow/settings.json` so matching commands skip confirmation in
  future sessions

### Changed

- **tui:** sync forked pi-tui to upstream v0.60.0 — adds tmux xterm
  `modifyOtherKeys` matching for Backspace, Escape, and Space, and
  resolves raw `\x08` backspace ambiguity with Windows Terminal heuristic
- **install:** use `@dungle-scrubs/tallow` as the canonical published package
  name in installer guidance and upgrade commands
- **tui:** global select cursor changed from → to ↗

### Fixed

- **skill-commands:** register `/slash-commands` for skills loaded from
  `sharedSkillsDirs` (e.g. `~/dev/skills`). Previously only `.claude/skills/`
  paths were scanned, so shared skills appeared in the system prompt but had
  no corresponding slash command
- **hooks:** don't block input when workspace directory is renamed or deleted
  externally — infrastructure errors (missing cwd, spawn failures) are now
  distinguished from policy blocks and never freeze the session
- **packaging:** make the published tarball self-contained by switching
  bundled extensions off repo-only `src/` imports, including the local
  `packages/tallow-tui` workspace in the packlist, and degrading prompt
  suggestions safely when ghost-text editor support is unavailable
- **slash-command-bridge:** move model-invoked `/compact` deferral to the
  proven post-response `turn_end` boundary, add deterministic lifecycle
  regression coverage, and stop stale `agent_end` races from dropping
  compaction or resumption
- **background-task-tool,tasks:** suppress the duplicate live background-task
  widget when the shared tasks dashboard is active, keeping `Background Tasks`
  as the single surface and stopping above-editor row jitter
- **tui:** fix streaming ghost empty spaces caused by stale `maxLinesRendered`
  high-water mark, missing `extraLines > height` safety guard in the diff
  cleanup path, and viewport drift correction firing one render cycle late
- **rewind:** windowed turn selector using `ctx.ui.custom()` — `/rewind`
  with 35+ turns no longer overflows the terminal viewport. The list is
  now windowed with scroll indicators and keyboard navigation wrapping
- **health:** show runtime provenance for the active CLI, including
  install mode, build freshness, executable path, and resolved package
  path
- **startup:** auto-rebuild stale linked/source-checkout `dist/` output on
  CLI launch before restarting into the fresh build
- **trust:** migrate legacy project trust entries so previously trusted
  folders do not false-positive as stale after trust fingerprint upgrades
- **workspace-transition:** use Windows named pipes for the child-process relay
  and degrade gracefully when relay startup is unavailable
- **subagent:** use `--model` instead of `--models` for forked subprocesses
- **teams-tool:** use tallow auth and model config in team spawns

### Documentation

- **docs:** align README/docs agent-template counts, bundled template lists,
  and `/agent:<name>` invocation examples with shipped templates
- **docs:** rename the homepage extension section to featured extensions and
  refresh docs metadata counts
- **context-fork:** document the correct `--model` subprocess flag

### Maintenance

- **deps:** bump pi-* dependencies
- **tests:** exclude `_defaults.md` from agent-template drift counts and verify
  scoped package links plus key docs metadata

## [0.8.24](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.23...tallow-v0.8.24) (2026-03-18)


### Added

* **tui:** add requestScrollbackClear() for session-level resets ([ecf4559](https://github.com/dungle-scrubs/tallow/commit/ecf4559f9b66abe24f9575a33344097eb0c4fe36))


### Fixed

* **hooks:** don't block input when cwd is renamed or deleted ([feba24d](https://github.com/dungle-scrubs/tallow/commit/feba24d9987ed7c30afd3a520176761ebc7d2a52))
* **packaging:** bundle forked pi-tui for npm consumers ([64a996c](https://github.com/dungle-scrubs/tallow/commit/64a996cdd804104f09879b6fd0ee5f011531b8c0))
* **plan-mode:** remove execution tracking that caused infinite loop ([d3cccad](https://github.com/dungle-scrubs/tallow/commit/d3cccad23a6ab3bb4833e7b1d46de6618db44b18))
* **shell-policy:** remove rm -r from high-risk confirmation prompts ([40c3e01](https://github.com/dungle-scrubs/tallow/commit/40c3e016c859f5bc5091c2d1b206678ddced02ce))
* **workspace-transition:** clear scrollback on session swap ([19560f7](https://github.com/dungle-scrubs/tallow/commit/19560f741c4c7743efe9f9ec7ea4523ad700406f))


### Changed

* bump pi framework to 0.58.3, update transitive deps ([3d65c7d](https://github.com/dungle-scrubs/tallow/commit/3d65c7dd93ad0ad4c7a2a66cd38eb71f561214d6))


### Documentation

* move [Unreleased] above latest release, add hooks fix entry ([cf95d36](https://github.com/dungle-scrubs/tallow/commit/cf95d364153879095787587175ff137745760439))


### Maintenance

* **deps:** bump pi-* dependencies ([26cb037](https://github.com/dungle-scrubs/tallow/commit/26cb03780fb4cf3e3b3977bacfb65a08e1c21e08))
* **hooks:** add stale-cwd unit tests ([6aef56d](https://github.com/dungle-scrubs/tallow/commit/6aef56d64af954644ef392de8e6c8e18a9eb03c8))

## [0.8.23](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.22...tallow-v0.8.23) (2026-03-15)


### Added

* **loop:** add max iterations (x&lt;N&gt;) and stop conditions (until) ([d56866e](https://github.com/dungle-scrubs/tallow/commit/d56866ebb3822b8b8791e7ecbe4c3e24b4738753))
* **plan-mode:** render plan steps in bordered widget ([64b9ad9](https://github.com/dungle-scrubs/tallow/commit/64b9ad90ce319b3a43595ac14f450d390ed3034a))
* **slash-command-bridge:** show compact progress as inline widget instead of footer status ([d43ec56](https://github.com/dungle-scrubs/tallow/commit/d43ec56743136a2b7cccc9c0a7322b9f48ec56f3))


### Fixed

* **extensions:** harden packaged ui runtime ([a319a87](https://github.com/dungle-scrubs/tallow/commit/a319a87052847e6c8cad22ca15938bfae6d8e806))
* **packaging:** add publish-safe runtime bridges ([3346f75](https://github.com/dungle-scrubs/tallow/commit/3346f7550cc9d2c659b36fcc907cd92d66ccf423))
* **packaging:** ship published runtime dependencies ([966e218](https://github.com/dungle-scrubs/tallow/commit/966e218618b0e51a603e99452cb2b6669baff389))
* **plan-mode:** show action menu when execution ends with incomplete steps ([55b3820](https://github.com/dungle-scrubs/tallow/commit/55b3820a7ddd2c2a837753d3ce46f76570dd4335))
* **slash-command-bridge:** repair model-invoked compact lifecycle ([e93923e](https://github.com/dungle-scrubs/tallow/commit/e93923e99dc4dfe2887bbe59bdad10e2cc787d73))
* **tasks:** suppress duplicate background task widget ([28609d4](https://github.com/dungle-scrubs/tallow/commit/28609d40d212d9436f410dc1b416c28f461c79c7))
* **teams:** deliver messages to working teammates via followUp ([1215bb5](https://github.com/dungle-scrubs/tallow/commit/1215bb5a257b4a2720ce31ca1466843bd28acbd7))
* **tui:** prevent differential rendering ghosting on content shrink ([87b7529](https://github.com/dungle-scrubs/tallow/commit/87b7529ce4ee667adaaf1c9e79fedbc45721b700))
* **tui:** resolve streaming ghost empty spaces between content and bottom UI ([5c0ec0b](https://github.com/dungle-scrubs/tallow/commit/5c0ec0bb22add9782850124a66bb92204c9f0247))
* **wezterm:** remove TTY exception and add tool_call guardrail hook ([7fde09d](https://github.com/dungle-scrubs/tallow/commit/7fde09d7aa0de47ddb1f56069fe84806f51fce45))
* **workspace-transition:** support Windows relay pipes ([bfcf25f](https://github.com/dungle-scrubs/tallow/commit/bfcf25f94103a773927a996a916681afa749b63e))


### Documentation

* add changelog entry for streaming ghost gap fix ([cb69101](https://github.com/dungle-scrubs/tallow/commit/cb69101d67a29842e8a4075aa71de5a68a711831))


### Maintenance

* **cli:** relax spawned process timeouts ([50b7cab](https://github.com/dungle-scrubs/tallow/commit/50b7cab31546bfb68ee9761351afa6e35bf3d1b1))
* **deps:** bump pi-* dependencies ([34af276](https://github.com/dungle-scrubs/tallow/commit/34af27670fce4e50aa6d65ade08ee19600337daa))
* **packaging:** cover packed tarball runtime ([c508157](https://github.com/dungle-scrubs/tallow/commit/c508157502455caea201cdd61444227095cd9eae))
* **slash-command-bridge:** update compact tests for widget-based progress ([c884e35](https://github.com/dungle-scrubs/tallow/commit/c884e355c4e09eeefcdeb72b29bbc68015b92c39))
* **teams:** update peer-messaging tests for working-teammate delivery ([717e465](https://github.com/dungle-scrubs/tallow/commit/717e465e1130250864a391ad8a2ed4c8d23e32f4))
* **tui:** add regression tests for shrink ghosting fixes ([93ffc90](https://github.com/dungle-scrubs/tallow/commit/93ffc9013c143ce32a135e36b429414340e3ccda))
* **tui:** add regression tests for streaming ghost gap fixes ([9c65b20](https://github.com/dungle-scrubs/tallow/commit/9c65b20449128091462cd5a97cd69ae3fc8a3f7d))
* **wezterm:** add guardrail helper unit tests ([cf03acb](https://github.com/dungle-scrubs/tallow/commit/cf03acb5b3908cb8a58bc1407616e4819ace8d93))

## [0.8.22](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.21...tallow-v0.8.22) (2026-03-10)


### Added

* **background-task-tool:** make bg_bash always non-blocking with bottom widget ([d51c5c1](https://github.com/dungle-scrubs/tallow/commit/d51c5c14c28eb48d38cfb67d63641293a633810f))
* **cli:** add --system-prompt and --append-system-prompt flags ([85ec58e](https://github.com/dungle-scrubs/tallow/commit/85ec58e01705d258acf303bb93e72a7cb99395df))
* **sdk:** add sharedSkillsDirs setting for cross-app skill sharing ([dd8e451](https://github.com/dungle-scrubs/tallow/commit/dd8e451374c7fa40bd68b0a25ddf4cef3baf0427))


### Fixed

* **bash-tool-enhanced:** remove setWorkingMessage dual-rendering ([0cd3d84](https://github.com/dungle-scrubs/tallow/commit/0cd3d84cde85ff3dddde60865a335de9919e8c36))
* **hooks:** translate Claude event names in package and extension hooks ([6966820](https://github.com/dungle-scrubs/tallow/commit/6966820b69b2e2c23c0ceb8bd155e458e9e66b32))
* **wezterm-pane-control:** rewrite pane guidance to bg_bash-first policy ([bdd502c](https://github.com/dungle-scrubs/tallow/commit/bdd502c6b71adf657b751edf7e15de00407a1067))


### Maintenance

* **background-task-tool:** update lifecycle tests for always-async bg_bash ([f4d541c](https://github.com/dungle-scrubs/tallow/commit/f4d541c881770ba90e4ebd2b50c1f8d2b99200a6))
* **deps:** bump pi-* dependencies ([84219ac](https://github.com/dungle-scrubs/tallow/commit/84219accc95ea78257e0dd45a32c468e9a31f04b))
* **wezterm-pane-control:** update guidance assertions for bg_bash-first policy ([1d04d16](https://github.com/dungle-scrubs/tallow/commit/1d04d16dd370465238f82066e110b574f1c119aa))

## [0.8.21](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.20...tallow-v0.8.21) (2026-03-09)


### Added

* **core:** add runtime-adaptive yield-to-io utility ([db796da](https://github.com/dungle-scrubs/tallow/commit/db796da423ad520ae401bc7246ee39d863c186b3))
* **loop:** add /loop command for recurring prompt execution ([4b2e55a](https://github.com/dungle-scrubs/tallow/commit/4b2e55a544d2350535fa56f97706517607fcee96))
* **otel:** opt-in OpenTelemetry distributed tracing for SDK consumers ([d5aab28](https://github.com/dungle-scrubs/tallow/commit/d5aab28088c7451d0f5db8cdaa45b9dc2376db86))


### Fixed

* **cli:** enforce explicit tool allowlists and stabilize integration checks ([a0e25df](https://github.com/dungle-scrubs/tallow/commit/a0e25dfae98f01b54b4ca451d6f09cf16feeb01c))
* **core:** honor session cwd across tool wrappers ([afd6750](https://github.com/dungle-scrubs/tallow/commit/afd6750918fe8aa973bd66bdf1f2e6fafbeb89fd))
* **health:** show runtime provenance for active cli ([5addf94](https://github.com/dungle-scrubs/tallow/commit/5addf94c69246e6f17062d3d5264d79d0cd05635))
* **rewind:** narrow rollback claims to tracked files ([7f0dcbd](https://github.com/dungle-scrubs/tallow/commit/7f0dcbda98b9f4ba9680992b7919d64be6d9377e))
* **rewind:** preserve staged work, skip clean turns, and windowed turn selector ([887ee6a](https://github.com/dungle-scrubs/tallow/commit/887ee6a5f2eeedddd30e3e4ed32631b0fd65a24b))
* **session-memory:** scope recall to current project by default ([02b08a7](https://github.com/dungle-scrubs/tallow/commit/02b08a7eab51a6baed5385898d351e6f38363e2d))
* **shell-policy:** use exact command in "Always allow" rules instead of wildcards ([fb225be](https://github.com/dungle-scrubs/tallow/commit/fb225bee48fe976de3c6d06ba31a48221e1631d1))
* **startup:** auto-rebuild stale local dist launches ([5843e74](https://github.com/dungle-scrubs/tallow/commit/5843e74fe5012324c4635d1c9b87de730a95f042))
* **streaming:** replace setImmediate with yield-to-io in patches ([fd35af4](https://github.com/dungle-scrubs/tallow/commit/fd35af4fe7c7144d40ad8b14615489e8a3498f26))
* **subagent:** use --model instead of --models in subprocess args ([f3de491](https://github.com/dungle-scrubs/tallow/commit/f3de49182987d04061dd5ca2cfcba79783ece5a9))
* **trust:** gate project-controlled prompt surfaces ([cb14242](https://github.com/dungle-scrubs/tallow/commit/cb142429b3d5518b0032ed78726d07a90686fb05))
* **trust:** migrate legacy project approvals ([e6ac776](https://github.com/dungle-scrubs/tallow/commit/e6ac776e21274028b4ffe636f8259b0be1b449ae))
* **tui:** replace setImmediate with setTimeout(0) in scheduleRender ([5b336ac](https://github.com/dungle-scrubs/tallow/commit/5b336ac140418f637587e0cd8a9f661ecd3a2435))
* use @dungle-scrubs/tallow in install docs and revert dual-publish ([4e43ee0](https://github.com/dungle-scrubs/tallow/commit/4e43ee09a24be787cfb4a703622996078acd9295))
* **web-fetch:** block private network targets ([64863d7](https://github.com/dungle-scrubs/tallow/commit/64863d73d51cec4bcab2dd5815a191b2afee9d1a))
* **web-fetch:** pin direct requests and record redirect telemetry ([4eec297](https://github.com/dungle-scrubs/tallow/commit/4eec2975b9c5d6dc957a94166e544b9f45a43474))
* **web-fetch:** require explicit opt-in for scraper fallback ([b723144](https://github.com/dungle-scrubs/tallow/commit/b723144c84c1955f9dd7bae41bb0b18fff30e965))
* **web-fetch:** stop buffering entire responses ([bdaa305](https://github.com/dungle-scrubs/tallow/commit/bdaa305da44fb3576b61daf98ede70a2ed464852))


### Documentation

* fix docs and changelog drift ([a52932a](https://github.com/dungle-scrubs/tallow/commit/a52932ac914d6a6fc56e8333961fdb45a27de81a))
* **installation:** use bun global install commands ([18b8a40](https://github.com/dungle-scrubs/tallow/commit/18b8a4012b557f2c485815dec05318a84c627605))
* **loop:** add extension docs page and update counts (51→52) ([b77d719](https://github.com/dungle-scrubs/tallow/commit/b77d719f3c6fdc7c05f38e0327bcbadd8738cf2e))


### Maintenance

* add docs and changelog validation scripts ([17d88f8](https://github.com/dungle-scrubs/tallow/commit/17d88f827002a40ed36fc3355c086f8beaea5d7b))
* **context-budget:** tolerate first-call planner race ([ec7a2a5](https://github.com/dungle-scrubs/tallow/commit/ec7a2a58464400e7087550a4c9e62657a36298f9))
* **deps:** bump pi-* dependencies ([6fb8200](https://github.com/dungle-scrubs/tallow/commit/6fb8200a39f9b0d32bf73412699d6f4644de169a))
* **installer:** align upgrade guidance expectations ([4e31abe](https://github.com/dungle-scrubs/tallow/commit/4e31abe5ce94dc726a139a95bfe2f059e7ab3202))
* **loop:** add unit tests for interval parsing, countdown, and args ([b5c1eb2](https://github.com/dungle-scrubs/tallow/commit/b5c1eb2317658f37e47014ed953909e39fdbc38b))
* run docs validation checks in review workflows ([7882dd1](https://github.com/dungle-scrubs/tallow/commit/7882dd1e40d1f11abed498f78651c91fa11aaee9))
* **shell-policy:** update tests for exact-command allow patterns ([39b3be0](https://github.com/dungle-scrubs/tallow/commit/39b3be0aefa2963ec1661ad0bcc3a92933e43cbd))

## [0.8.20](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.19...tallow-v0.8.20) (2026-03-08)


### Fixed

* **streaming:** coalesce message_update events in handleEvent ([013eb1b](https://github.com/dungle-scrubs/tallow/commit/013eb1b9460b403faea94661b307ae37108d4ada))
* **streaming:** yield to I/O during EventStream iteration ([04a010f](https://github.com/dungle-scrubs/tallow/commit/04a010f9bad2e6be94881b06814aabdf7ab29e10))


### Documentation

* remove npx/bunx install instructions ([a26d670](https://github.com/dungle-scrubs/tallow/commit/a26d670da5f63154861568aa93f5aa276064baad))


### Maintenance

* dual-publish to both tallow and @dungle-scrubs/tallow ([8cc4d6d](https://github.com/dungle-scrubs/tallow/commit/8cc4d6dd5f1792f8671b3bf9b2aa18481768b7fe))

## [0.8.19](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.18...tallow-v0.8.19) (2026-03-07)


### Added

* **bash-tool:** use 3-option select for high-risk confirmations ([0229aa1](https://github.com/dungle-scrubs/tallow/commit/0229aa136382e164ef3abb4b539fc15135c2bb3b))
* **shell-policy:** add always-allow option for high-risk commands ([1780aa4](https://github.com/dungle-scrubs/tallow/commit/1780aa4f9f3479c6020880f96ee9a0c7de73ad7c))
* **workspace-transition:** add Unix-socket relay for child-process cd ([97f6a68](https://github.com/dungle-scrubs/tallow/commit/97f6a6811467f0c98bf24b61c078570b5f02b651))


### Fixed

* **cd-tool:** use ctx.cwd for path resolution and remap worktree paths ([7dfd7ea](https://github.com/dungle-scrubs/tallow/commit/7dfd7ea68a47b9391ee1b9d27ddf0bb6b0e6d86b))
* **teams-tool:** use tallow auth and model config in team spawns ([0f08485](https://github.com/dungle-scrubs/tallow/commit/0f0848526e465ff9f7d0f0096bf86a12932ac7e4))


### Documentation

* add missing changelog entries for 0.8.19 ([f0ea4a1](https://github.com/dungle-scrubs/tallow/commit/f0ea4a18f2754c201505986254aba93851f2fa57))


### Maintenance

* **shell-policy:** add always-allow tests and update callers ([19d66d2](https://github.com/dungle-scrubs/tallow/commit/19d66d22433d87232399516ac4c1b9f263309879))
* **teams-tool:** add spawn auth path resolution tests ([5ae804e](https://github.com/dungle-scrubs/tallow/commit/5ae804ea57832279421f60701fe21f2517575016))

## [0.8.18](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.17...tallow-v0.8.18) (2026-03-07)


### Maintenance

* **deps:** bump pi-* dependencies ([742f98c](https://github.com/dungle-scrubs/tallow/commit/742f98c93ff29531645a580cf2c8b086b6c47543))

## [0.8.17](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.16...tallow-v0.8.17) (2026-03-07)


### Added

* **context-files:** add path-scoped rule activation ([63dd5b7](https://github.com/dungle-scrubs/tallow/commit/63dd5b711bdee85531a623d011badd4c5754a3ad))
* **web-fetch-tool:** add dendrite fallback ([5129c48](https://github.com/dungle-scrubs/tallow/commit/5129c48584a939cdc17eac4fe20f2792ee9efb20))
* **wezterm:** intelligent pane use for TTY commands and secret privacy ([50971c8](https://github.com/dungle-scrubs/tallow/commit/50971c8d50b549b3fe61e1ff0a959561372ce413))
* **workspace-transition:** finish Plan B cd transitions ([87969d7](https://github.com/dungle-scrubs/tallow/commit/87969d75cf55b530aeb53b504a3e6706bebaef94))


### Fixed

* **context:** treat unknown usage as unavailable ([b0e70d2](https://github.com/dungle-scrubs/tallow/commit/b0e70d29941bde5b5b115e7e4e74a49f6a5aa4d5))
* **installer:** stop claiming binary self-upgrades ([6a818f4](https://github.com/dungle-scrubs/tallow/commit/6a818f46ac19331a85de538341552126cbe0e5bd))
* **interactive:** surface overflow and compaction retry failures ([11dfbd7](https://github.com/dungle-scrubs/tallow/commit/11dfbd756ab11374df356a0218e49bfd4f1bcb91))
* **sdk:** abort compaction before session resets ([b89238b](https://github.com/dungle-scrubs/tallow/commit/b89238b0561200e65d43a8e8249839e03871d29d))
* **slash-command-bridge:** add live compact heartbeat progress ([d2b0100](https://github.com/dungle-scrubs/tallow/commit/d2b010062dafccc3de09f513a50b14a4cd5d6d35))
* **tui:** yield render scheduling during streaming ([6e074bf](https://github.com/dungle-scrubs/tallow/commit/6e074bfb10dd2ab96a539fcbdf667cd6d79518ac))
* **wezterm:** unescape send_text and use --no-paste for execution ([994e5bc](https://github.com/dungle-scrubs/tallow/commit/994e5bcdc2b3ae5e8f3ed787cb49b8eed26bd1a2))


### Changed

* **background-task-tool:** collapse consecutive poll calls in-place ([a9a662f](https://github.com/dungle-scrubs/tallow/commit/a9a662fef99656a9a43ebf984bde65ad7599423c))
* **core:** harden trust-scoped workspace plumbing ([5292d63](https://github.com/dungle-scrubs/tallow/commit/5292d634390764040c8c01ac3fe174f57739f080))


### Documentation

* **changelog:** add scoped-rules release note ([806df99](https://github.com/dungle-scrubs/tallow/commit/806df9954d4438adb46afe3c0dd7a4a07cbede4d))
* **changelog:** note compact heartbeat progress feedback ([ba4248d](https://github.com/dungle-scrubs/tallow/commit/ba4248dbb48ed452438ce9a9e11dfabc016943e1))
* **changelog:** note streaming input scheduling fix ([e070755](https://github.com/dungle-scrubs/tallow/commit/e0707552e92b4bca4710e73ba820e9bd96a965c2))
* **context-files:** document scoped rule compatibility ([97abd74](https://github.com/dungle-scrubs/tallow/commit/97abd7488a7df1e0d1f70ff94b8b119f3d8dd1d5))
* **context:** document unknown-usage no-data behavior ([c954833](https://github.com/dungle-scrubs/tallow/commit/c954833567519a29e56f2ca9937659772d635b39))
* **installation:** clarify installer upgrade flows ([97db4df](https://github.com/dungle-scrubs/tallow/commit/97db4df234ec75d9ab107a350a36a6d9a3e42039))
* **web-fetch-tool:** document dendrite fallback ([608e672](https://github.com/dungle-scrubs/tallow/commit/608e672b64efd93647c5367beacd564707a9d553))


### Maintenance

* **background-task-tool:** add consecutive poll detection tests ([8910af9](https://github.com/dungle-scrubs/tallow/commit/8910af91299d19273df3eb6ec53ee9ec8b4191b2))
* **skills:** refresh tallow-expert reference ([f1ec89a](https://github.com/dungle-scrubs/tallow/commit/f1ec89ab70d4d7e51f37d45843ecbe9f41353342))
* **workspace-transition:** cover host orchestration ([8a773cc](https://github.com/dungle-scrubs/tallow/commit/8a773cc80e7f7640fc33fc38c5bf6635dfc77301))

## [0.8.16](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.15...tallow-v0.8.16) (2026-03-05)


### Fixed

* **tui:** guard image width math in narrow panes ([4b8f9a0](https://github.com/dungle-scrubs/tallow/commit/4b8f9a030aa9ab8af5aab82d0c218c162dcaf5d2))
* **tui:** improve terminal image layout quantization ([81fbc27](https://github.com/dungle-scrubs/tallow/commit/81fbc2785fb13b69fc309301cbedf4a22920ceb0))


### Maintenance

* **context-budget:** tolerate planner-unavailable fallback batch sizes ([b2479f4](https://github.com/dungle-scrubs/tallow/commit/b2479f45392e223cf5019c28ef95b88f49ba61a7))
* **deps:** bump pi-* dependencies ([3b19fa0](https://github.com/dungle-scrubs/tallow/commit/3b19fa088328329b28b7439e2a3c0100867f0285))
* **runner:** serialize prompt execution across integration sessions ([08d77a8](https://github.com/dungle-scrubs/tallow/commit/08d77a8604d6c51ef7c6ca05c314712d25484c68))
* **runner:** serialize TALLOW_HOME mutation across concurrent sessions ([7cdfb65](https://github.com/dungle-scrubs/tallow/commit/7cdfb6507b73b616384a015047aeba8fbb450385))
* **runner:** wait for session_start handlers before first prompt ([1fe50f1](https://github.com/dungle-scrubs/tallow/commit/1fe50f16a192ab975fd8775cc47e8b7b345a3b08))
* **tui:** deduplicate terminal capability env test helper ([ef0fc78](https://github.com/dungle-scrubs/tallow/commit/ef0fc785067bb62fd4e17da0128efee43b36e1ab))
* **tui:** move capability env helper to test-utils ([b336116](https://github.com/dungle-scrubs/tallow/commit/b336116c6dbdf29791ed5bf4ce26c000b6b8dee2))
* **utils:** wait for agent_end before unsubscribing runner ([350c848](https://github.com/dungle-scrubs/tallow/commit/350c8486e2973a94f6af315a8d248108116a3bcc))

## [0.8.15](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.14...tallow-v0.8.15) (2026-03-05)


### Added

* **context-budget:** add planner envelopes and ingestion guards ([a109c49](https://github.com/dungle-scrubs/tallow/commit/a109c49366e71050ee39a41350852580f1918421))
* **plan-mode:** auto-enable plan mode from natural language intent ([8a91fb0](https://github.com/dungle-scrubs/tallow/commit/8a91fb0bc1a0b840ad9f96b5478950575fee7eaa))


### Fixed

* **ask-user-question:** sanitize multiline option rendering ([265957a](https://github.com/dungle-scrubs/tallow/commit/265957adedbcb6ff7460651865c68f2732d53686))
* **ci:** add actions:write permission to dep-check workflow ([0b960ee](https://github.com/dungle-scrubs/tallow/commit/0b960eee2828b9eaa0b2b2819e4a800971d66ca2)), closes [#116](https://github.com/dungle-scrubs/tallow/issues/116)
* **interactive:** suppress overflow error payload before auto-compaction ([85da4cf](https://github.com/dungle-scrubs/tallow/commit/85da4cf19989bec18fce294e8b35a31117641fc2))
* **shell-policy:** show approval notice after confirmation ([844bc22](https://github.com/dungle-scrubs/tallow/commit/844bc227f347926d7f2e7866275838e6dd0ce939))
* **tui:** preserve scrollback during agent turns ([055f917](https://github.com/dungle-scrubs/tallow/commit/055f917f0bf379ffce133977cf902a3e40fed439))
* **wezterm-pane:** avoid unsolicited pane spawning for dev servers ([4baa9e8](https://github.com/dungle-scrubs/tallow/commit/4baa9e8bd874c5b9fe1711c10e2f2bae678506a3))
* **wezterm-pane:** block pane creation without explicit request ([57dc7f9](https://github.com/dungle-scrubs/tallow/commit/57dc7f9f6e921df671170e0b616495aa53a4cdc6))


### Documentation

* **context-budget:** document guardrails and adaptive caps ([423a46d](https://github.com/dungle-scrubs/tallow/commit/423a46d683fbe40e3e189f70c071af030604362a))


### Maintenance

* **ask-user-question:** add down-arrow render regression coverage ([6c9af0e](https://github.com/dungle-scrubs/tallow/commit/6c9af0e330b32f74e075a73650a0f9f9bb5f77f1))
* **deps:** bump pi-* dependencies ([7fea391](https://github.com/dungle-scrubs/tallow/commit/7fea39130e3df6f692178496d298f0fd366130db))
* **deps:** bump pi-* dependencies ([6db17c4](https://github.com/dungle-scrubs/tallow/commit/6db17c4e331e82b48379d1139a6279067a3fca4b))
* **plan-mode:** add plan intent detection test suite ([a88bd55](https://github.com/dungle-scrubs/tallow/commit/a88bd55d8ddb9307b46927cda36d6e18e8d8ccde))

## [0.8.14](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.13...tallow-v0.8.14) (2026-02-26)


### Fixed

* **ci:** add workflow to configure Sonar quality gate ([02e2f2a](https://github.com/dungle-scrubs/tallow/commit/02e2f2a6d3dc0599206404b94e4b0ce21d63e9d6))
* **ci:** stabilize Sonar baseline after releases ([828934f](https://github.com/dungle-scrubs/tallow/commit/828934f8a3b7402e6414c06928585f588ebf2131))


### Documentation

* **pr-template:** require explicit gh pr checks before merge ([65379ae](https://github.com/dungle-scrubs/tallow/commit/65379ae2b7191d6aeecbde0be32baba01dab8711))

## [0.8.13](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.12...tallow-v0.8.13) (2026-02-26)


### Fixed

* **ci:** resolve audit critical and lint formatting failure ([c661bc6](https://github.com/dungle-scrubs/tallow/commit/c661bc6397fe9de121fc00fb79de951fa17410e8))

## [0.8.12](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.11...tallow-v0.8.12) (2026-02-26)


### Fixed

* **sdk:** guard optional pi-tui image path helper ([05d5b96](https://github.com/dungle-scrubs/tallow/commit/05d5b967f727f1f7543f76c18be7df085c251110))


### Maintenance

* **core:** add unit tests for auth-hardening, config, process-cleanup, startup-timing ([ef6e91e](https://github.com/dungle-scrubs/tallow/commit/ef6e91eb916cd88b0a3494a833119ded56b6d3a6))
* **deps:** bump pi-* dependencies ([0b6099e](https://github.com/dungle-scrubs/tallow/commit/0b6099e4c3df1bd23d36109a48157a3a9168d629))

## [0.8.11](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.10...tallow-v0.8.11) (2026-02-25)


### Fixed

* **bash:** use process.cwd() at execution time instead of stale closure ([c57e731](https://github.com/dungle-scrubs/tallow/commit/c57e7317d770ab9989af6482b96dea36954e6659))

## [0.8.10](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.9...tallow-v0.8.10) (2026-02-25)


### Added

* **routing:** upgrade synapse to 0.1.6 and wire exclude patterns ([89f7669](https://github.com/dungle-scrubs/tallow/commit/89f76695775922991f5c47d88a88da86c83ba09d))
* **slash-command-bridge:** show resuming indicator after compaction ([58afb02](https://github.com/dungle-scrubs/tallow/commit/58afb02669091a306652886a0051a7b7cedc8b40))


### Fixed

* **compact:** narrow hasCompactionQueuedMessages to compaction-only queue ([9fadfdf](https://github.com/dungle-scrubs/tallow/commit/9fadfdfc564c3108427e9fc7b2430a0849d1b4fb))
* copy pi built-in themes during build to prevent /settings crash ([5014d18](https://github.com/dungle-scrubs/tallow/commit/5014d185a16491a083e7924df56ce712e4be5f90))
* **docs:** comprehensive light mode for docs site ([1fb71b9](https://github.com/dungle-scrubs/tallow/commit/1fb71b9b920b1e32e1f648a9d7eaf2395113cdd9))
* **init:** rewrite /init prompts around discovery-distance principle ([a65807f](https://github.com/dungle-scrubs/tallow/commit/a65807fabf71f746a3d3e84e4c72708b78838c00))
* **interactive-mode-patch:** fix stale UI patch interference with compaction ([08aee4c](https://github.com/dungle-scrubs/tallow/commit/08aee4c0d885f292626b124f83ecaabfe63b4a07))
* **slash-command-bridge:** always fire continuation timer after compact ([ec01d35](https://github.com/dungle-scrubs/tallow/commit/ec01d35de77bc871f4a120dcc2a1c30460205d1a))
* **slash-command-bridge:** eliminate race between queue flush and auto-continue ([70efcfc](https://github.com/dungle-scrubs/tallow/commit/70efcfc74e886042479ac2739ce1d07daaf30559))
* **tasks:** distinguish "agents" from "teammates" in footer bar ([202856b](https://github.com/dungle-scrubs/tallow/commit/202856b886f9bd91e7675a9b056bd4a76a30d0a6))
* **worktree:** restrict marker file permissions to owner-only ([5262dd8](https://github.com/dungle-scrubs/tallow/commit/5262dd8904e9f6fc66bd485e3994814975942b9b))


### Changed

* **lsp:** extract shared helpers to reduce code duplication ([a12eada](https://github.com/dungle-scrubs/tallow/commit/a12eadaf83675f3a42c4094dbde241366e1a610f))
* **subagent:** remove dead initial assignment ([d9b906f](https://github.com/dungle-scrubs/tallow/commit/d9b906f9e2f4aaecb74f4c8f3d33ecabb7cfdd0a))


### Documentation

* replace Aliases page with comprehensive Slash Commands reference ([56a328a](https://github.com/dungle-scrubs/tallow/commit/56a328adedf4e4b0063bf3c827c88d3fbcc5a6ad))
* **session-memory:** update roadmap — hippo for memories, QMD evaluation ([fb7218c](https://github.com/dungle-scrubs/tallow/commit/fb7218c4b0928fa68c1fb65ee17cd8f1ec054b98))


### Maintenance

* **dep-check:** scope permissions to job level ([0fe08b7](https://github.com/dungle-scrubs/tallow/commit/0fe08b7f0ed0afd23e28ec3f5b0eef73a358cba6))
* **slash-command-bridge:** add compaction race condition tests ([393fb2d](https://github.com/dungle-scrubs/tallow/commit/393fb2d8707e0fb20da60782d859958c30963353))
* **slash-command-bridge:** cover post-compaction resuming behavior ([ba6d423](https://github.com/dungle-scrubs/tallow/commit/ba6d423e35a54a85de5067499e7b2a2e17d3ee86))

## [0.8.9](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.8...tallow-v0.8.9) (2026-02-23)


### Fixed

* **slash-command-bridge:** auto-continue after model-triggered compaction ([9776a16](https://github.com/dungle-scrubs/tallow/commit/9776a1640f4be8d3c7140f305cba7bd9dd4198d4))


### Documentation

* **readme:** remove images for now ([f52a474](https://github.com/dungle-scrubs/tallow/commit/f52a474930cb21cb448c714ad5edad7da1164112))


### Maintenance

* add v1.md to gitignore ([d5cfaee](https://github.com/dungle-scrubs/tallow/commit/d5cfaee408561ca8dd0f45b45f6fac87cdba43eb))
* **deps:** bump pi-* dependencies ([29516b5](https://github.com/dungle-scrubs/tallow/commit/29516b5c53e28a358fee86de0985ddb911b96776))

## [0.8.8](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.7...tallow-v0.8.8) (2026-02-22)


### Added

* **context-usage,debug:** add tool-result memory telemetry ([2d50a19](https://github.com/dungle-scrubs/tallow/commit/2d50a193d3244654ccbea243cd46405ddb732de1))
* **hooks:** add worktree lifecycle event support ([15de3a9](https://github.com/dungle-scrubs/tallow/commit/15de3a98ffbf97ec3264f4b9b0e59e11be092763))
* **plugins:** load plugin commands and agents from sdk env ([846116e](https://github.com/dungle-scrubs/tallow/commit/846116eed13957d7b7129128ef6fa70c82e6a79a))
* **read-tool-enhanced:** add structured .ipynb reading support ([2fe8998](https://github.com/dungle-scrubs/tallow/commit/2fe89984fec25a410caf1992f773af089ca3e3b0))
* **sdk:** summarize oversized historical tool results ([79b66d7](https://github.com/dungle-scrubs/tallow/commit/79b66d7f8375507679369a4acaf46e85ad215bcf))
* **subagent-tool:** add worktree isolation mode ([630330e](https://github.com/dungle-scrubs/tallow/commit/630330e88c707b0075945b70819619238337a374))
* **worktree:** add session worktree lifecycle and CLI isolation ([0cc751a](https://github.com/dungle-scrubs/tallow/commit/0cc751a8c7740f7178bef511704a65acc21b27ea))


### Fixed

* **cli:** avoid logging raw session-id error text ([ea4b433](https://github.com/dungle-scrubs/tallow/commit/ea4b433a538a822fa631258ca1bfb117837ad897))
* **core:** harden session ids and rewind repository handling ([0c78e79](https://github.com/dungle-scrubs/tallow/commit/0c78e7971e90b80340a421cf6a6bb43721593e2c))
* **plan-mode:** add blocked-step guidance during execution ([14f119f](https://github.com/dungle-scrubs/tallow/commit/14f119fad989218718e770447e6b01f883d0142e))
* **subagent-tool:** auto-rerun stalled workers ([15e0827](https://github.com/dungle-scrubs/tallow/commit/15e0827acb8cb54a9517e941820b7e4a668baa54))
* **tasks:** keep foreground subagents inline-only ([ac2508d](https://github.com/dungle-scrubs/tallow/commit/ac2508d515cec9fb57ca9dcda99c011d859ee210))


### Changed

* **paths:** centralize tallow home and settings resolution ([188b47c](https://github.com/dungle-scrubs/tallow/commit/188b47c84b0b5b54ba12cb208751dff0dcdde51f))


### Documentation

* **context-usage:** document tool-result retention memory reporting ([1d10f18](https://github.com/dungle-scrubs/tallow/commit/1d10f18708c892c7ea2c1d8f3ca1263348005227))
* **plan-mode:** document execution guidance for blocked tools ([81b86db](https://github.com/dungle-scrubs/tallow/commit/81b86db17d818bebca3fddd02d19b71503595efa))
* **read-tool-enhanced:** document notebook support ([796ea55](https://github.com/dungle-scrubs/tallow/commit/796ea55dd9f79208d58ffbed727b4263b8b85878))
* **subagent-tool:** describe automatic stall reruns ([38a8b03](https://github.com/dungle-scrubs/tallow/commit/38a8b033f1e11969b2743d86139f820f48b8e73c))
* **tasks:** clarify widget shows background subagents only ([56bba02](https://github.com/dungle-scrubs/tallow/commit/56bba0232ed9fafd62f7addb55bbc58037748e80))
* **worktree:** add extension docs and update counts ([67896bb](https://github.com/dungle-scrubs/tallow/commit/67896bbb6ff92d0347d071ac9f45674e28d5b040))


### Maintenance

* **read-tool-enhanced:** cover notebook parsing and read integration ([2c6e95d](https://github.com/dungle-scrubs/tallow/commit/2c6e95d9e4ab3f2a4adffbda4de20850227017c0))

## [0.8.7](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.6...tallow-v0.8.7) (2026-02-22)


### Added

* **commands:** add --worktree workflow to implement template ([b4bbf92](https://github.com/dungle-scrubs/tallow/commit/b4bbf925fa968b7acd4f1cf24d865a7b793a251a))
* **core:** add extension catalog and exclusive loading ([b61e8b7](https://github.com/dungle-scrubs/tallow/commit/b61e8b7c03569793c5fa9b187fef155fd83ed19a))
* **debug:** rename /diag to /diagnostics ([3648538](https://github.com/dungle-scrubs/tallow/commit/36485386f26cf03481d1901ae9431679fa323052))
* **extensions:** add catalog metadata to bundled manifests ([680ca55](https://github.com/dungle-scrubs/tallow/commit/680ca556e784c3268de766c542b82dfe2c4fae16))
* **lsp:** add configurable startup timeout ([355c4f3](https://github.com/dungle-scrubs/tallow/commit/355c4f39b6f8b6942e7437018f9183b984ebbdc2))
* **startup:** add headless startup profile fast path ([8d676a1](https://github.com/dungle-scrubs/tallow/commit/8d676a1a1de6fe23ae6fbccaa4969b55bb4dd79a))
* **subagent-tool:** add routing mode and signals config support ([365c73a](https://github.com/dungle-scrubs/tallow/commit/365c73a6bcb0dc28a36a8dade0ec18cacd1512b6))
* **subagent-tool:** add stalled-worker watchdog and recovery flow ([adb97a9](https://github.com/dungle-scrubs/tallow/commit/adb97a93b9149eaaf61a99d3b2832eaa704b450b))
* **tasks:** surface stalled subagent status in widget ([5b8955b](https://github.com/dungle-scrubs/tallow/commit/5b8955bd9c773729fc594b97a3d6c8f6a9d594cb))
* **trust:** box project trust warning with clearer risk copy ([91af699](https://github.com/dungle-scrubs/tallow/commit/91af699c184bf61fc8c6583fe5505354ae0b2679))


### Fixed

* **core:** flush deferred bash output on interactive updates ([d4bee77](https://github.com/dungle-scrubs/tallow/commit/d4bee774a53bba51622c85ea277b834ad49c6a37))
* **core:** update fatal banner diagnostics hint ([32ef553](https://github.com/dungle-scrubs/tallow/commit/32ef5533fa8320f97c3f370822c93733c295b18a))
* **permissions:** clarify deny and ask reasons ([a671024](https://github.com/dungle-scrubs/tallow/commit/a671024f1b975851a0f158c587a1f11ba9b25a27))
* **subagent-tool:** align routing signal types with synapse ([3a49aaa](https://github.com/dungle-scrubs/tallow/commit/3a49aaa9db567541e1bd9612695fb9f74e429f3e))
* **subagent-tool:** relax truncation for parallel previews ([6dd6073](https://github.com/dungle-scrubs/tallow/commit/6dd607364a83056e88afb57728999d93d643d5fa))
* **subagent:** honor provider-scoped explicit model overrides ([2659853](https://github.com/dungle-scrubs/tallow/commit/265985374210d03fca406c8c1f1ec2e08046f9c9))
* **tasks:** split subagent widget by blocking mode ([7510cc2](https://github.com/dungle-scrubs/tallow/commit/7510cc2814b475dd259ffff596e1e971049bd3dd))
* **teams-tool:** dedupe noisy dashboard feed and refine dashboard rendering ([8dc97eb](https://github.com/dungle-scrubs/tallow/commit/8dc97eb1959274f9895a29eae108299589f67fe7))
* **tui:** realign diff viewport basis after shrink ([441f688](https://github.com/dungle-scrubs/tallow/commit/441f688b6691c8d0b9cbedbe778141cdc2125c10))
* **ui:** avoid duplicate Error prefix for icon-led extension notifications ([97811bc](https://github.com/dungle-scrubs/tallow/commit/97811bcc52bab8d6bf368eb1c3502b53edbb0f45))
* **wezterm-notify:** stabilize lifecycle signaling and spinner updates ([315a5f6](https://github.com/dungle-scrubs/tallow/commit/315a5f6ca19efb7d7abfcd40797baf6053f38f1c))


### Changed

* **commands:** lazy-load command expansion and fork indexes ([a5e4a54](https://github.com/dungle-scrubs/tallow/commit/a5e4a549d546d16804f8ca767591f30bd02445eb))
* **context-files:** defer context scan to first use ([e2a7f39](https://github.com/dungle-scrubs/tallow/commit/e2a7f39dc808eee857658db49bd2ce43e2f4249c))
* **mcp-adapter:** lazy-initialize server connections ([79d490b](https://github.com/dungle-scrubs/tallow/commit/79d490b64cafa918a0f4a51c0282f79006288e79))
* **shared:** add reusable lazy initializer helper ([4fdfea0](https://github.com/dungle-scrubs/tallow/commit/4fdfea021eb381b3d81c324e448cf2685c981d2f))
* **subagent,teams:** bound history retention and cleanup ([c0cb6e3](https://github.com/dungle-scrubs/tallow/commit/c0cb6e3f333c473cbf11fac1d53b56bcb75ceb19))
* **tasks-subagent:** share identity styling and model metadata ([21c5179](https://github.com/dungle-scrubs/tallow/commit/21c5179f5f545ba0b44db63e068e0106581c40d5))
* **tool-display:** add semantic presentation roles for tool output ([95bc7a5](https://github.com/dungle-scrubs/tallow/commit/95bc7a54cdb95ac060f997d6c7a28681efe7ab73))


### Documentation

* add autocomplete guide covering structural and LLM completions ([1b8d6fb](https://github.com/dungle-scrubs/tallow/commit/1b8d6fb99661dd0f751ad0767f5ff87d4aff2890))
* **changelog:** note tui border regression fix ([1d5e600](https://github.com/dungle-scrubs/tallow/commit/1d5e600447143947223108e153a029b16c28e87f))
* **changelog:** record lazy startup initialization refactor ([01c1ac9](https://github.com/dungle-scrubs/tallow/commit/01c1ac949548af75e27f294eeb04375d042875a7))
* **debug:** clarify diagnostics vs /debug usage ([0a2261f](https://github.com/dungle-scrubs/tallow/commit/0a2261fa4e9b9bc8ea295284bb90e34cf3077be8))
* enrich prompt-suggestions with model fallback chain and context details ([45f0d0e](https://github.com/dungle-scrubs/tallow/commit/45f0d0e26b9451952cf704f7fe8d5a2093f38710))
* **extensions:** document catalog commands and metadata fields ([38f1c13](https://github.com/dungle-scrubs/tallow/commit/38f1c13b3e1a449cf965d80f0f383d415ba82a8e))
* **extensions:** document shared presentation roles ([a9f3925](https://github.com/dungle-scrubs/tallow/commit/a9f392561610ca924459a393353eff99d4693e58))
* **permissions:** add reason clarity examples ([31b516f](https://github.com/dungle-scrubs/tallow/commit/31b516fe4700bba041144bafa6ab8234503d8660))
* **readme:** add annotated screenshot asset ([faae932](https://github.com/dungle-scrubs/tallow/commit/faae9323639b0e3d2dc5bd982f3a4f2f728979c7))
* **wezterm-notify:** update working-session lifecycle guide ([7b17c12](https://github.com/dungle-scrubs/tallow/commit/7b17c1256bb22ba4e9f651c19a67ad9ff5054ffa))


### Maintenance

* **dep-check:** add failure notification on build break ([2ab2063](https://github.com/dungle-scrubs/tallow/commit/2ab206372e67e5bed7b0086cc3860cea902ce83e))
* **deps:** bump @dungle-scrubs/synapse to 0.1.4 ([8740bdc](https://github.com/dungle-scrubs/tallow/commit/8740bdca689289b8874494a753d1d7eb78c63788))
* **deps:** bump pi-* dependencies to 0.54.0 ([c5ad469](https://github.com/dungle-scrubs/tallow/commit/c5ad469397d4b1fac8d793d43babbc567b8a5c47))
* **permissions:** cover reason metadata and messaging ([eaff3a0](https://github.com/dungle-scrubs/tallow/commit/eaff3a0ae13f068c32c39bfd8889cebf4e769d7a))
* **startup:** add startup benchmark scripts ([21f3a76](https://github.com/dungle-scrubs/tallow/commit/21f3a766f15aa7585983f52e5751c938bf5e14db))
* **startup:** add startup profile regression coverage ([c59f40e](https://github.com/dungle-scrubs/tallow/commit/c59f40efa6d88bd8c1df3e533838fc5adda213b5))
* **subagent-tool:** cover routing config and selection options ([4950d58](https://github.com/dungle-scrubs/tallow/commit/4950d587975cfc621d6a7bc50dc02f6a020319f1))
* **subagent:** fix auto-cheap routing determinism in CI ([f3d9a8d](https://github.com/dungle-scrubs/tallow/commit/f3d9a8dfe458bb760fb2c139d46725e21a6457e2))
* **subagent:** isolate auto-cheap routing tests from home config ([29288cd](https://github.com/dungle-scrubs/tallow/commit/29288cdc571550f747dbb1cd7ff3d1d5fe3497bc))
* **subagent:** relax auto-cheap assertions across provider prefs ([49946d8](https://github.com/dungle-scrubs/tallow/commit/49946d8ff778fe66045fcdca8bcedca1063bdd2e))
* **trust:** cover boxed project trust banner and payload ([8dc3878](https://github.com/dungle-scrubs/tallow/commit/8dc38781adad6df55618e53529eddd5b4a1a9c3f))
* **tui:** add border and shrink-regression coverage ([f946979](https://github.com/dungle-scrubs/tallow/commit/f946979a3fd543723e84833e3f5811bed7133f88))

## [0.8.6](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.5...tallow-v0.8.6) (2026-02-20)


### Added

* **wezterm-notify:** add WezTerm turn-status integration ([5d0e671](https://github.com/dungle-scrubs/tallow/commit/5d0e6717e5bfea3caeed5b0b90d8635e56ef99ae))


### Fixed

* stabilize claude bridge skill path ordering ([608afd0](https://github.com/dungle-scrubs/tallow/commit/608afd09a613fa01ce10a9aeb86f7d831e418a7c))


### Documentation

* refine README structure and clarity ([0a2920b](https://github.com/dungle-scrubs/tallow/commit/0a2920b07d9f1ae1a0cfa79fa30386605c0416c1))
* **wezterm:** add setup guide and extension docs ([8326aec](https://github.com/dungle-scrubs/tallow/commit/8326aec8acb9f227673bac9ba67bd81eb537d0a7))

## [0.8.5](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.4...tallow-v0.8.5) (2026-02-20)


### Added

* **core:** add project trust store and fingerprinting primitives ([27429aa](https://github.com/dungle-scrubs/tallow/commit/27429aada21e2ccc322b4dd2e5d673cdf06ebd33))
* **trust:** enforce project trust gate across extension surfaces ([07e0618](https://github.com/dungle-scrubs/tallow/commit/07e0618009b003ef1c605ff94ae040ab17786c40))
* **trust:** resolve project trust state and startup controls ([4e501b0](https://github.com/dungle-scrubs/tallow/commit/4e501b0dbcb0c22306042d72b154c80e64bba289))


### Fixed

* **core:** clear stale interactive UI state between turns ([31dbd29](https://github.com/dungle-scrubs/tallow/commit/31dbd29156949ca6f4e9e10b8f2f130b5a11b2e6))
* **debug:** redact sensitive fields in debug logger ([43d6c59](https://github.com/dungle-scrubs/tallow/commit/43d6c5939aa00121d334696187954adce8712e76))
* **deps:** remediate advisory paths with targeted overrides ([1ff39e9](https://github.com/dungle-scrubs/tallow/commit/1ff39e907736ad87bacabd7f6c2481d1c23b1f66))
* guard bg_bash unref for nonstandard child processes ([3e91c98](https://github.com/dungle-scrubs/tallow/commit/3e91c9873ad76142302fbcaa7146894a3c4215a8))
* harden plugin ref parsing and cache path safety ([d49c01a](https://github.com/dungle-scrubs/tallow/commit/d49c01a5bd8c5c6ef45e0fa2814b35edebbb7989))
* **hooks:** harden subprocess timeout and output buffering ([116ff7e](https://github.com/dungle-scrubs/tallow/commit/116ff7e0cd0e14940febfa6ca3edbd17c67e5d3c))
* isolate lsp test mocks across suites ([4c703dd](https://github.com/dungle-scrubs/tallow/commit/4c703ddd73c05525ab68c7e66ab532d796a4253b))
* **lint:** resolve biome warnings in docs, tests, and subagent ([1c9674d](https://github.com/dungle-scrubs/tallow/commit/1c9674d4c6bc3d908aebdfe8ff39a8271d732622))
* **lsp:** add timeout and abort guards ([04dc838](https://github.com/dungle-scrubs/tallow/commit/04dc83814d702e1c112942010e9a8d00eedfabc0))
* make pid registry lock contention fail-safe ([690ffb5](https://github.com/dungle-scrubs/tallow/commit/690ffb59c46a67ffc2a2218ea2af4dd8cb502e10))
* **mcp-adapter:** abort timed-out SSE requests ([83d68e7](https://github.com/dungle-scrubs/tallow/commit/83d68e74b5b25da346a50aa0ceb3e9d634f714b9))
* **mcp-adapter:** gate project MCP servers by trust ([a0f7130](https://github.com/dungle-scrubs/tallow/commit/a0f713033129e82da3a4269e5c256f6ea4a688f5))
* **pid-cleanup:** verify process identity before signaling ([5989864](https://github.com/dungle-scrubs/tallow/commit/5989864d2290928f1c93a449f4dfc1bf1ae0741c))
* **plan-mode:** enforce strict readonly tool allowlist ([c58a50e](https://github.com/dungle-scrubs/tallow/commit/c58a50e0c8a48f14af84c0ace9f00bdb6edd081c))
* **plugins:** contain github plugin subpaths to clone root ([e58b206](https://github.com/dungle-scrubs/tallow/commit/e58b206eec35f6e1b19b98be9da9db021347cac7))
* prevent cross-session pid cleanup termination ([3f56f37](https://github.com/dungle-scrubs/tallow/commit/3f56f376c7c4d9d7b860f73af3c44bfdb17fec75))
* resolve hook agent runner without hardcoded pi binary ([8805e9f](https://github.com/dungle-scrubs/tallow/commit/8805e9fb5ca970ad816d3631f0415e9d8676c47a))
* resolve pid manager paths from runtime TALLOW_HOME ([9e24032](https://github.com/dungle-scrubs/tallow/commit/9e240326198c1aa6879719527411ac18c9bb4eb6))
* **subagent-tool:** show routed model during parallel execution ([7045ef4](https://github.com/dungle-scrubs/tallow/commit/7045ef42f5ebf07b6f0ced31bf0716d73e4bc802))
* **tests:** make trust-gated package/plugin specs deterministic ([b96ce22](https://github.com/dungle-scrubs/tallow/commit/b96ce22c9146e56476c4c60d11493d555263a853))


### Changed

* add runtime path provider with pid injection hooks ([9de6745](https://github.com/dungle-scrubs/tallow/commit/9de6745946ff40b1c5b61b67f8a9360f6061ad7b))
* add shared mock-scope harness for isolated tests ([357aa6d](https://github.com/dungle-scrubs/tallow/commit/357aa6dafdc927eeb6586de7543fd36555f4e9df))
* centralize agent runner resolution policy ([86cf33a](https://github.com/dungle-scrubs/tallow/commit/86cf33a758d03a3f68475e3a6f881956b836c153))
* extract background task process lifecycle manager ([8be74d7](https://github.com/dungle-scrubs/tallow/commit/8be74d77f1fe33db4f898f8a9afda95682d984e4))
* extract shared file lock utility for pid registry ([e4e3d3b](https://github.com/dungle-scrubs/tallow/commit/e4e3d3bcc34be2c842118bf7ff64f686d2903896))
* move pid tracking to session-scoped files ([93e150b](https://github.com/dungle-scrubs/tallow/commit/93e150b3426927fbef994dbb9d53f51d9a94b0a3))
* normalize plugin specs and harden cache keys ([3b57b5c](https://github.com/dungle-scrubs/tallow/commit/3b57b5c5586909872b4de7dcde5a759b201ac0c1))


### Documentation

* **changelog:** note dependency advisory remediation ([6dbe154](https://github.com/dungle-scrubs/tallow/commit/6dbe1548bbca577e3075e310ddf93e0cfe2bd7a1))
* **changelog:** note PID reuse safety cleanup guard ([b664614](https://github.com/dungle-scrubs/tallow/commit/b66461495d17c3c07ac0dd9203f99788288071fd))
* **debug:** document redaction behavior and changelog ([317b2a3](https://github.com/dungle-scrubs/tallow/commit/317b2a392593cfd797cc4979948a27e8c71ec416))
* **hooks:** document subprocess safety defaults ([aae3825](https://github.com/dungle-scrubs/tallow/commit/aae3825155d20db168c86f57668322b3455bff17))
* **lsp:** note fail-fast timeout behavior ([6023157](https://github.com/dungle-scrubs/tallow/commit/602315732fd411ce099cb21006ba7c8d64869bd6))
* **mcp-adapter:** clarify trust-gated config loading ([06b9401](https://github.com/dungle-scrubs/tallow/commit/06b940162f249290f64324d13804b69b5043e416))
* **mcp-adapter:** document SSE cancellation semantics ([7835871](https://github.com/dungle-scrubs/tallow/commit/7835871a38cb7abd0296e909514b64a7cb85585d))
* **plan-mode:** document strict readonly behavior ([6767926](https://github.com/dungle-scrubs/tallow/commit/6767926975bac9038f40025ae166365282fa621f))
* **trust:** document trust-gated project execution surfaces ([75b22c4](https://github.com/dungle-scrubs/tallow/commit/75b22c4cdda113a76fe160425f6f29881d84181a))


### Maintenance

* **dev:** add pre-pr script that mirrors CI ([4a07276](https://github.com/dungle-scrubs/tallow/commit/4a0727621df29ff3a5e5277522224d93663a927c))
* **hooks:** cover timeout escalation and output truncation ([0bb3490](https://github.com/dungle-scrubs/tallow/commit/0bb3490d2c747897194f3a0e5cf88b3e71f3b8ff))
* **lsp:** add timeout and abort coverage ([18728a5](https://github.com/dungle-scrubs/tallow/commit/18728a569b8f1f89bef6d93ec08bf2a4e0804e6f))
* **pid-cleanup:** cover PID reuse safety and metadata fallback ([57fe0fc](https://github.com/dungle-scrubs/tallow/commit/57fe0fc4f587874cbde8dbfff78b5959bd0dd241))
* **plan-mode:** add strict gating coverage ([e1bb73e](https://github.com/dungle-scrubs/tallow/commit/e1bb73eb09c9c0ba4412bb1515f3b0ea2e3f4dcd))

## [0.8.4](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.3...tallow-v0.8.4) (2026-02-19)


### Added

* **subagent:** surface routing defaults in settings ([ddbfc68](https://github.com/dungle-scrubs/tallow/commit/ddbfc68792b4df81ed871fe2c47f2febf24f3370))
* **wezterm-pane:** auto-run prefilled commands by default ([4d6b9bd](https://github.com/dungle-scrubs/tallow/commit/4d6b9bd68927f8d516c0814aa180a83892b0420c))


### Fixed

* **hooks:** add Claude Code hook compatibility layer ([d14dba8](https://github.com/dungle-scrubs/tallow/commit/d14dba8e41da32a26b0bc9d581e75fb25cfc1277))
* **slash-command-bridge:** show compacting progress feedback ([f368a64](https://github.com/dungle-scrubs/tallow/commit/f368a646b2eb15fe657dc50e79cb6fb9d5bde14d))
* **tui:** relax default image height clamp ([8f2b191](https://github.com/dungle-scrubs/tallow/commit/8f2b191c61c8f38ffbfd923283282fcc330c6b1d))


### Documentation

* **compat:** clarify hook event key expectations ([55dc312](https://github.com/dungle-scrubs/tallow/commit/55dc3124682954ff1546636caa87c71004f9ba2c))
* **guides:** add Claude Code compatibility guide ([1802f17](https://github.com/dungle-scrubs/tallow/commit/1802f173593f252a89838bc812846cb70f3a0103))
* **guides:** correct Claude compatibility details for hooks and frontmatter ([59d2003](https://github.com/dungle-scrubs/tallow/commit/59d2003a6bbfed2cada6fa8fda9ace93214efd29))
* **readme:** emphasize core differentiators and spare-time support ([ca06d98](https://github.com/dungle-scrubs/tallow/commit/ca06d98e81f7beea9a3993f0c2f66125ebccb2f9))


### Maintenance

* **deps:** bump synapse to 0.1.2 ([df65b9f](https://github.com/dungle-scrubs/tallow/commit/df65b9feb5805d480c133ba4968e1007c88b20de))
* **deps:** bump synapse to 0.1.3 ([269cb2f](https://github.com/dungle-scrubs/tallow/commit/269cb2fae0743d1c407413f6308439fdb2473386))

## [0.8.3](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.2...tallow-v0.8.3) (2026-02-18)


### Fixed

* address remaining CodeQL alerts ([c7e8259](https://github.com/dungle-scrubs/tallow/commit/c7e8259cf01a01cda386a63808f337096bf1e611))
* reject shell metacharacters in command references ([b178d23](https://github.com/dungle-scrubs/tallow/commit/b178d232427272a58b38b8b7d8d52105af2a7b2a))

## [0.8.2](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.1...tallow-v0.8.2) (2026-02-18)


### Fixed

* resolve CodeQL security alerts ([5d52f1d](https://github.com/dungle-scrubs/tallow/commit/5d52f1d55f817891b24be5d6f1bf961f6c6cb205))
* resolve remaining CodeQL warnings ([1421691](https://github.com/dungle-scrubs/tallow/commit/1421691453052411a26d746f235bea6169c85b9d))


### Maintenance

* **codeql:** exclude test directories from analysis ([9c102eb](https://github.com/dungle-scrubs/tallow/commit/9c102eb4d0bd5cb6cf5bfe7b3540fc02d16b1fe8))

## [0.8.1](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.8.0...tallow-v0.8.1) (2026-02-18)


### Fixed

* **ci:** only fail audit on critical vulnerabilities ([94505a3](https://github.com/dungle-scrubs/tallow/commit/94505a344a42e89ef36923b415c2bd61aca44831))
* **ci:** remove SonarCloud workflow (use Automatic Analysis), relax audit to critical-only ([a2222f6](https://github.com/dungle-scrubs/tallow/commit/a2222f6d41d0c2dc52f7128de93767329d5faf8f))
* **config:** remove op:// secret cache to prevent plaintext secrets on disk ([d48ec89](https://github.com/dungle-scrubs/tallow/commit/d48ec89794ff0f43daeaf40567c49ee9c8c668d6))


### Maintenance

* **security:** add Semgrep, CodeQL, SonarCloud, and dependency audit ([e0c3548](https://github.com/dungle-scrubs/tallow/commit/e0c3548473d3ba943cc9565e86cbdb0b1ca32cea))

## [0.8.0](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.7.7...tallow-v0.8.0) (2026-02-18)


### ⚠ BREAKING CHANGES

* namespace package as @dungle-scrubs/tallow

### Added

* namespace package as @dungle-scrubs/tallow ([310af1d](https://github.com/dungle-scrubs/tallow/commit/310af1d7dd612e0142d91b9b4c107cbcc26184ba))


### Fixed

* **core:** revert package name to unscoped 'tallow' ([e6caff6](https://github.com/dungle-scrubs/tallow/commit/e6caff66c29803ddfbfba7b41fbb8eb1ff722b3c))

## [0.7.7](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.7.6...tallow-v0.7.7) (2026-02-18)


### Added

* **context-files:** discover nested subdirectory rule files ([34058bd](https://github.com/dungle-scrubs/tallow/commit/34058bd41d4387a63cd45c79c2d7c82779c740ca))
* **core:** add demo mode for recordings and streaming ([232ba79](https://github.com/dungle-scrubs/tallow/commit/232ba796c8c352f7b91b0a109f622b76fbd60ac0))
* **init:** support nested .claude/ rename and CLAUDE.md migration ([18b1ad4](https://github.com/dungle-scrubs/tallow/commit/18b1ad41dd75123e2f6b66247f2cf8606baa89d5))
* **plugins:** add plugin resolver, cache, and format detection ([e7937cb](https://github.com/dungle-scrubs/tallow/commit/e7937cbbe9a0cf30f38fc69733aeb61063dc56ab))
* **plugins:** integrate plugin resolution into session startup ([e87e191](https://github.com/dungle-scrubs/tallow/commit/e87e191008cdd1c1501a97ebec50a3522ddfbfe0))
* remove image-gen extension ([85e01de](https://github.com/dungle-scrubs/tallow/commit/85e01de374f60ef0773d713c556a06833ba3a77c))


### Fixed

* **ci:** add NODE_AUTH_TOKEN for npm OIDC publish ([814ec12](https://github.com/dungle-scrubs/tallow/commit/814ec12c5875ac28706320a6fd7482b083a1ca6c))
* **test:** increase timeout for shell-spawning tests ([b28263c](https://github.com/dungle-scrubs/tallow/commit/b28263cb56acdcc7ecf30954b36317c6801495af))
* **tools:** add missing isError flag to error responses in lsp, read, and ask-user-question ([49bb21d](https://github.com/dungle-scrubs/tallow/commit/49bb21d5056f4042ddf75cc8a6f48373a5f18f31))


### Changed

* **subagent:** extract model resolver, router, and matrix to @dungle-scrubs/synapse ([61932f2](https://github.com/dungle-scrubs/tallow/commit/61932f25ec4ff6b050aef8e5db208992f7647fb2))
* **web-fetch:** remove Firecrawl fallback and JS detection ([8fa22c7](https://github.com/dungle-scrubs/tallow/commit/8fa22c7e026e033ffc19803c324ab1f2d2b4001b))


### Documentation

* add demo mode changelog entry ([9a36522](https://github.com/dungle-scrubs/tallow/commit/9a36522ad667b23a5d29038aa83b43e5f8afc0bc))
* update unreleased changelog for 0.7.7 ([6f7628f](https://github.com/dungle-scrubs/tallow/commit/6f7628f8d7996b9bc298b13db4f8bdb36fb28638))


### Maintenance

* **ci:** remove redundant publish.yml — release.yml handles OIDC publish ([07f7110](https://github.com/dungle-scrubs/tallow/commit/07f71109015bc37c090e7568adfceb179a8828dc))

## [0.7.6](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.7.5...tallow-v0.7.6) (2026-02-17)


### Added

* **slash-command-bridge:** show command name in tool call header ([f447aad](https://github.com/dungle-scrubs/tallow/commit/f447aad83cec20c2c7a4ff038cdf5d0490f9ccc6))


### Fixed

* **ci:** restore registry-url for npm OIDC publish ([bda9b03](https://github.com/dungle-scrubs/tallow/commit/bda9b033a7870ffa9c84b56df66533c20ee06b5b))
* **slash-command-bridge:** defer compact to agent_end to prevent spinner hang ([27b3edd](https://github.com/dungle-scrubs/tallow/commit/27b3edde127694d76f7bb20aafe7dbf9e7d58b5b))


### Changed

* **tool-display:** use raw snake_case for all tool display names ([de31c08](https://github.com/dungle-scrubs/tallow/commit/de31c08a25e12fbf7ee0f6dd6d7ebb055ae7fd4a))


### Documentation

* update roadmap — mark teams dashboard shipped, rules mostly shipped ([7f15de4](https://github.com/dungle-scrubs/tallow/commit/7f15de4030eed26e312ac967b551cd28366948cf))


### Maintenance

* **deps:** bump biome 2.3.15→2.4.2, vscode-jsonrpc 8.2.0→8.2.1 ([37f7652](https://github.com/dungle-scrubs/tallow/commit/37f76526d89e40f9d6cf7e6749a2d7bece2db7b4))

## [0.7.5](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.7.4...tallow-v0.7.5) (2026-02-17)


### Fixed

* **ci:** move publish job into release workflow to fix GITHUB_TOKEN event propagation ([80e0f78](https://github.com/dungle-scrubs/tallow/commit/80e0f78e0544b8f0324fde56a16750789272d6fa))
* **rewind:** use temp GIT_INDEX_FILE to avoid nuking staging area ([59e8a23](https://github.com/dungle-scrubs/tallow/commit/59e8a2352574e21bb1aa97be37734b0ed6ac2e75))

## [0.7.4](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.7.3...tallow-v0.7.4) (2026-02-17)


### Added

* **image-gen:** unified image generation tool with auto-routing across OpenAI,
  Google (Gemini/Imagen), xAI, Black Forest Labs (Flux), and Fal via Vercel AI
  SDK ([7a7a35d](https://github.com/dungle-scrubs/tallow/commit/7a7a35dce5faf9561e02a8d00263765d6f96358a))
* **image-gen:** quality-based model selection from Arena leaderboard ELO ratings
  with eco/balanced/premium cost preferences
* **image-gen:** dual invocation paths — dedicated image APIs (`generateImage`) and
  hybrid LLMs (`generateText` with image output) handled transparently
* **permissions:** Claude Code-compatible `Tool(specifier)` permission rules with
  `allow`/`deny`/`ask` tiers, `{cwd}`/`{home}`/`{project}` variable expansion,
  gitignore-style path conventions, shell operator awareness, and symlink/traversal
  defense ([51ac5dd](https://github.com/dungle-scrubs/tallow/commit/51ac5dd798b00b1ebf823aab3c42ce1d7b9062dd))
* **permissions:** `/permissions` command for viewing, testing, and reloading
  rules ([f1c79ea](https://github.com/dungle-scrubs/tallow/commit/f1c79eaf60de7a02e0ae8fbb3e52e72e736e11ad))
* **permissions:** `--allowedTools` and `--disallowedTools` CLI flags at CLI
  precedence tier ([3f63765](https://github.com/dungle-scrubs/tallow/commit/3f63765e4503753c1dc9f3320c85f2bb54863c6b))
* **permissions:** reads `.claude/settings.json` permission rules for drop-in
  Claude Code compatibility
* **sdk:** load AGENTS.md from installed npm
  packages ([81ceb16](https://github.com/dungle-scrubs/tallow/commit/81ceb169e4801be7f0d75c1ca3c27d72f33ad478))


### Fixed

* **hooks:** hook shell commands now respect permission
  rules ([424714b](https://github.com/dungle-scrubs/tallow/commit/424714b006f3b691c5330a12b1c03d9a672dcb3f))
* **tui:** use full terminal width for inline
  images ([a19ca62](https://github.com/dungle-scrubs/tallow/commit/a19ca6266a6ffd3a74c2b7f5e9e051d565de824b))
* **tui:** remove hardcoded text truncation in
  renderCall ([594a0d8](https://github.com/dungle-scrubs/tallow/commit/594a0d8e97ca40b9f90854e6a5bfd05e4c0cf145))


### Changed

* **tool-display:** prefix tool verbs with display
  label ([6acc227](https://github.com/dungle-scrubs/tallow/commit/6acc227d50df52642a60a489dc6aded3e0b9a860))

## [0.7.3](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.7.2...tallow-v0.7.3) (2026-02-17)


### Fixed

* **ci:** add registry-url for npm OIDC publish ([207d9c6](https://github.com/dungle-scrubs/tallow/commit/207d9c68fe498b49f410ca546dc0af410369ac12))
* **ci:** add workflow_dispatch to publish for manual retrigger ([2b6f8bd](https://github.com/dungle-scrubs/tallow/commit/2b6f8bd394a2364b42acf551bcdcee866dc2a90e))

## [0.7.2](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.7.1...tallow-v0.7.2) (2026-02-17)


### Added

* **context-fork:** auto-route model when no explicit model specified ([6835e22](https://github.com/dungle-scrubs/tallow/commit/6835e22ce29b49fdec8a82006059afb034962fe8))
* **subagent-tool:** add Arena leaderboard refresh script ([e7d1cdc](https://github.com/dungle-scrubs/tallow/commit/e7d1cdcfe32b0f9b2a29a5b59fd8f42658e317ba))
* **subagent-tool:** add modelScope for scoped auto-routing ([8d884af](https://github.com/dungle-scrubs/tallow/commit/8d884af5cca71da36e35e431a076d02845774c71))
* **teams-tool:** use full model routing for teammate spawning ([cb81ecd](https://github.com/dungle-scrubs/tallow/commit/cb81ecda3bf399a13bcf5e575320f14e074f1d10))


### Fixed

* address bugs found by bones agent hunt ([b33a1c6](https://github.com/dungle-scrubs/tallow/commit/b33a1c61e16a4a6e48db2022d23ff95a053bc48a))
* **bash:** auto-backgrounded tasks invisible to task_output ([e086369](https://github.com/dungle-scrubs/tallow/commit/e0863692ffeeffc4e36b3dc77989431cc80f3083))
* **subagent-tool:** show error details in failed parallel results ([1170038](https://github.com/dungle-scrubs/tallow/commit/11700385aefbebf2ffbffb3a13b98bfcd063f73b))
* sync TALLOW_VERSION with package.json (0.7.1) ([5bb1afc](https://github.com/dungle-scrubs/tallow/commit/5bb1afc9d6e33be994a3a13afd1c411ff89a203a))


### Changed

* **subagent-tool:** improve resolver tiebreaking with capability scoring ([5951541](https://github.com/dungle-scrubs/tallow/commit/5951541b6024519e901d35ada469f2bb1f4ddcfe))


### Maintenance

* add dep-check and matrix-refresh workflows ([cdf4726](https://github.com/dungle-scrubs/tallow/commit/cdf4726b42d891ae906b83e99ff843f41c72d963))
* **main:** release tallow 0.7.1 ([a1104bd](https://github.com/dungle-scrubs/tallow/commit/a1104bdfc59f86c95c9a5cec9e679c9f76bb1f29))
* stop tracking AGENTS.md (user-local file) ([7591e7f](https://github.com/dungle-scrubs/tallow/commit/7591e7fadd32bda8cd9bf9c2ecbe33f3cf93ddb7))
* **subagent-tool:** add gpt-5.3-codex, spark, and 5.1-codex-max to matrix ([11d30a9](https://github.com/dungle-scrubs/tallow/commit/11d30a9cee00080160a9d570beb031c206b0b64e))
* treat feat as patch bump while pre-1.0 ([646cd71](https://github.com/dungle-scrubs/tallow/commit/646cd71687213dd40d093a6615505ead1b8f8bdf))

## [0.7.1](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.7.0...tallow-v0.7.1) (2026-02-17)


### Added

* **context-fork:** auto-route model when no explicit model specified ([6835e22](https://github.com/dungle-scrubs/tallow/commit/6835e22ce29b49fdec8a82006059afb034962fe8))
* **subagent-tool:** add Arena leaderboard refresh script ([e7d1cdc](https://github.com/dungle-scrubs/tallow/commit/e7d1cdcfe32b0f9b2a29a5b59fd8f42658e317ba))
* **subagent-tool:** add modelScope for scoped auto-routing ([8d884af](https://github.com/dungle-scrubs/tallow/commit/8d884af5cca71da36e35e431a076d02845774c71))
* **teams-tool:** use full model routing for teammate spawning ([cb81ecd](https://github.com/dungle-scrubs/tallow/commit/cb81ecda3bf399a13bcf5e575320f14e074f1d10))
* **test:** add E2E profile runner and extension profile definitions ([3db96f3](https://github.com/dungle-scrubs/tallow/commit/3db96f3963acc85b95516e2adf6549d403863892))


### Fixed

* address bugs found by bones agent hunt ([b33a1c6](https://github.com/dungle-scrubs/tallow/commit/b33a1c61e16a4a6e48db2022d23ff95a053bc48a))
* **bash:** auto-backgrounded tasks invisible to task_output ([e086369](https://github.com/dungle-scrubs/tallow/commit/e0863692ffeeffc4e36b3dc77989431cc80f3083))
* resolve 10 bugs found by bones game d3a57b9e0f07 ([4de12fb](https://github.com/dungle-scrubs/tallow/commit/4de12fb7ea7bd9b07c1b9935df95005171e36ded))
* **subagent-tool:** show error details in failed parallel results ([1170038](https://github.com/dungle-scrubs/tallow/commit/11700385aefbebf2ffbffb3a13b98bfcd063f73b))
* sync TALLOW_VERSION with package.json (0.7.1) ([5bb1afc](https://github.com/dungle-scrubs/tallow/commit/5bb1afc9d6e33be994a3a13afd1c411ff89a203a))
* **test:** clean up tmpHome on error, track session for disposal ([bd5ee96](https://github.com/dungle-scrubs/tallow/commit/bd5ee96ceb9acfbd332df6b60734581186cbecb6))


### Changed

* **config:** parallelize op:// secret resolution with local cache ([aeff46d](https://github.com/dungle-scrubs/tallow/commit/aeff46d81884f10902dc5e8b86145a3b7f4d76d2))
* **subagent-tool:** improve resolver tiebreaking with capability scoring ([5951541](https://github.com/dungle-scrubs/tallow/commit/5951541b6024519e901d35ada469f2bb1f4ddcfe))
* **subagent-tool:** split 2967-line index.ts into 6 focused modules ([80316f2](https://github.com/dungle-scrubs/tallow/commit/80316f2b8dbdb57bd81534b578046faa17950e64))


### Maintenance

* add dep-check and matrix-refresh workflows ([cdf4726](https://github.com/dungle-scrubs/tallow/commit/cdf4726b42d891ae906b83e99ff843f41c72d963))
* **e2e:** add extension profile boot, conflict, interop, install, and override tests ([c55f369](https://github.com/dungle-scrubs/tallow/commit/c55f3699f9d6fcf68b2262648efee06597272747))
* release 0.7.1 ([f819e0b](https://github.com/dungle-scrubs/tallow/commit/f819e0b5c87dd6178edbc683612587de3df0ed71))
* stop tracking AGENTS.md (user-local file) ([7591e7f](https://github.com/dungle-scrubs/tallow/commit/7591e7fadd32bda8cd9bf9c2ecbe33f3cf93ddb7))
* **subagent-tool:** add gpt-5.3-codex, spark, and 5.1-codex-max to matrix ([11d30a9](https://github.com/dungle-scrubs/tallow/commit/11d30a9cee00080160a9d570beb031c206b0b64e))
* treat feat as patch bump while pre-1.0 ([646cd71](https://github.com/dungle-scrubs/tallow/commit/646cd71687213dd40d093a6615505ead1b8f8bdf))

## [0.7.1] - 2026-02-16

### Added

- **test:** E2E profile runner and extension profile definitions — creates
  headless sessions with real bundled extensions loaded by path, matching
  the production loading path
- **test:** 39 E2E tests across 7 files covering profile boot, tool/command
  conflict detection, EventBus interop wiring, headless install, and user
  extension override mechanism

### Changed

- **subagent-tool:** split 2967-line index.ts into 6 focused modules
  (agents, formatting, widget, process, schema) — largest file reduced
  to 1297 lines with no behavioral changes

### Fixed

- **core:** startup with `op://` secrets in `~/.tallow/.env` reduced from
  ~9s to ~2s by resolving references in parallel with a local cache
  (`~/.tallow/.env.cache`, 1h TTL) instead of sequential synchronous calls
- **extension-harness:** EventBus emit now catches per-listener exceptions
  instead of aborting the entire emit chain
- **extension-harness:** sendMessage merges options instead of overwriting
- **extension-harness:** getTheme() throws consistently with theme getter
- **extension-harness:** replace `as never` cast with typed
  `as ExtensionAPI['events']`
- **tui:** fix isKeyRelease/isKeyRepeat docs to match behavior
- **tui:** resolve Ctrl+C binding conflict (copy → Ctrl+Shift+C)
- **pid-registry:** add file locking around read-modify-write to prevent races
- **mcp-adapter-tool:** parseSseResponse now matches response ID to request ID
- **init:** wrap renameSync in try-catch for TOCTOU resilience
- **test:** clean up tmpHome on error, track session for disposal to prevent
  resource leaks

### Documentation

- **core:** document `.env.cache` and two-phase secret loading architecture
  in AGENTS.md and installation guide

## [0.7.0](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.6.1...tallow-v0.7.0) (2026-02-16)


### Added

* **bash-tool:** detect ripgrep and inject rg preference into system prompt ([e42fa01](https://github.com/dungle-scrubs/tallow/commit/e42fa01c8fc9347b07937a2708c6b0b6c451c172))
* **bash:** surface output tail in working message during execution ([5108631](https://github.com/dungle-scrubs/tallow/commit/5108631a2717fb7012652cf4ddd61c907f5af365))
* **cli:** add --debug flag for debug mode activation ([2d1fc32](https://github.com/dungle-scrubs/tallow/commit/2d1fc32366c0cdc4ce68f205a93e5c4fd5566dc0))
* **core:** add algorithm-over-LLM guideline to system prompt ([984f2aa](https://github.com/dungle-scrubs/tallow/commit/984f2aa80de32d28c112edc4a7690ecadeb421b9))
* **core:** add atomic file write utility ([fca06fd](https://github.com/dungle-scrubs/tallow/commit/fca06fd991b572d2d4fbcdf220ab653b7d3edffb))
* **core:** detect output truncation and instruct proactive strategy communication ([1da56ab](https://github.com/dungle-scrubs/tallow/commit/1da56ab651869c3cf40ba17677d1aaf842905c8d))
* **debug:** interactive troubleshooting with debug_inspect tool ([4f207bb](https://github.com/dungle-scrubs/tallow/commit/4f207bb6ef03cd584e104966dc6844d31c92d65f))
* **hooks:** add `once: true` option for run-once hooks ([f961701](https://github.com/dungle-scrubs/tallow/commit/f9617011b58d92d23c94c7a0489bee6b36fa5fb4))
* **hooks:** wire all declared-but-unwired lifecycle events ([e32e821](https://github.com/dungle-scrubs/tallow/commit/e32e8213ff2d47f9222f99d9fb19a3ecc431fe93))
* **mcp-adapter-tool:** add SSE and Streamable HTTP transport support ([d3e0055](https://github.com/dungle-scrubs/tallow/commit/d3e0055e96f082fd3f301fd816be06d7b3c86ff3))
* **prompt-suggestions:** feed conversation history into autocomplete ([677fcd7](https://github.com/dungle-scrubs/tallow/commit/677fcd7435f78846015674662176932e08bc19c0))
* **stats:** add per-session and aggregate usage statistics extension ([d2e2742](https://github.com/dungle-scrubs/tallow/commit/d2e27427104f0315b8aa1adf8b545b4ff9a44bfc))
* **subagent-tool:** detect and surface tool permission denials ([5c42c43](https://github.com/dungle-scrubs/tallow/commit/5c42c437074f25bb9107af81620ec35969e93d7e))
* **tallow-expert:** auto-regenerate skill reference on pre-commit ([5d8a37c](https://github.com/dungle-scrubs/tallow/commit/5d8a37ca6b0476d66a978890302a0a27e8663d66))


### Fixed

* **ci:** remove dead MODEL_ALIASES import, fix model-dependent tests ([235270e](https://github.com/dungle-scrubs/tallow/commit/235270e4a38c6d9069745bb643512848065d99b9))
* **ci:** remove leaking mock.module for model-resolver and task-classifier ([f0882de](https://github.com/dungle-scrubs/tallow/commit/f0882de9b93a4b5245a9e5d44edbd0748e3c8070))
* **ci:** remove leaking node:fs mock, fix test assertions ([1531d79](https://github.com/dungle-scrubs/tallow/commit/1531d794f902ddbc6e9d25d3dd7192a3291b2585))
* **core:** use atomic writes for config and state files ([86c68ee](https://github.com/dungle-scrubs/tallow/commit/86c68eee16ec3f927ec34f38723e89414c499637))
* **extensions:** use atomic writes for config and state files ([5cf61a9](https://github.com/dungle-scrubs/tallow/commit/5cf61a9013aa72f00c62ba71e6598a11e3c33036))
* **tui:** reduce columns proportionally when height-clamping images ([0fbb547](https://github.com/dungle-scrubs/tallow/commit/0fbb547705c8ce1717c1ac2cca699cac4dbdfa72))


### Changed

* **random-spinner:** remove scramble-decrypt reveal animation ([ce74277](https://github.com/dungle-scrubs/tallow/commit/ce742775c61b86f757c9b33a98b2e732de5e863e))


### Documentation

* add changelog entries for atomic writes ([41ddf56](https://github.com/dungle-scrubs/tallow/commit/41ddf56c0efdbaf3418426f9224450c935407b0a))
* bump extension count to 48 ([08ab0d0](https://github.com/dungle-scrubs/tallow/commit/08ab0d0591f7e2dba36d371bfd75af7036e165cf))
* **hooks:** document once-hook behavior ([33124fe](https://github.com/dungle-scrubs/tallow/commit/33124feec7c1732e21c7a3db8e5258e69959e161))
* **hooks:** update event tables, examples, and changelog ([2c50e4a](https://github.com/dungle-scrubs/tallow/commit/2c50e4a998c7794d6c1546139caa595f03a7458b))
* **mcp-adapter-tool:** update changelog, version, and roadmap ([4613a43](https://github.com/dungle-scrubs/tallow/commit/4613a43f1184dbab8f9928701486877e0fc26537))


### Maintenance

* **bash:** add unit tests for progress message helpers ([c2ca29f](https://github.com/dungle-scrubs/tallow/commit/c2ca29fa0fadf2b645f5ac6fa7d80b4c66870d70))
* bump version to 0.7.0 ([9ce4afc](https://github.com/dungle-scrubs/tallow/commit/9ce4afc38d6530be12e371ab3e2c83d2d8e7cb98))
* **debug:** add tests for queryLog and analysis utilities ([0792afd](https://github.com/dungle-scrubs/tallow/commit/0792afd74b86393ceff5b25e74ff436b0f6981ad))
* **hooks:** add once-hook state manager tests ([c4f5e1d](https://github.com/dungle-scrubs/tallow/commit/c4f5e1db6bced33a6ebbefc1e5b7f64417df94b0))
* lint autofix formatting ([809e7c6](https://github.com/dungle-scrubs/tallow/commit/809e7c6bcda54316e90141aa0bb7889f9062279c))
* **mcp-adapter-tool:** add transport, config, and reconnect tests ([af60bc4](https://github.com/dungle-scrubs/tallow/commit/af60bc4e1c7a57a624456519b3595e9f956a9460))
* **prompt-suggestions:** add conversation context tests ([27edefd](https://github.com/dungle-scrubs/tallow/commit/27edefd2416e9d6eac4374f17c803aa57817fe93))
* **subagent-tool:** add denial detection unit tests ([2c8d686](https://github.com/dungle-scrubs/tallow/commit/2c8d68618428884ba61b9e4d770fae9afbff70fa))

## [0.7.0] - 2026-02-16

### Added

- **hooks:** `once: true` option for hook handlers — runs exactly once then
  auto-disables, with state persisted to `~/.tallow/hooks-state.json`
- **stats:** `/stats` command for per-session and aggregate usage statistics
  with token counts, costs, tool usage bar charts, model breakdowns, and
  usage streaks — persisted to `~/.tallow/stats.jsonl`
- **core:** `atomicWriteFileSync` utility with write-tmp-then-rename pattern,
  optional fsync, file mode, and `.bak` backup support
- **core:** `restoreFromBackup` utility for startup recovery from `.bak` files
  with optional content validation
- **core:** automatic backup recovery for `settings.json` and `auth.json` when
  primary file is corrupt

### Fixed

- **core:** config/state file writes (`settings.json`, `auth.json`,
  `keybindings.json`, session headers) are now atomic — interrupted writes
  can no longer corrupt files
- **extensions:** theme-selector, skill-commands, pid-registry, and
  output-styles-tool writes are now atomic
- **tasks:** refactored inline write-tmp-then-rename to use shared
  `atomicWriteFileSync` utility

### Added

- **hooks:** wire all declared-but-unwired pi events — `before_agent_start`,
  `agent_start`, `turn_end`, `session_shutdown`, `session_before_compact`,
  `session_compact`, `session_before_switch`, `session_switch`,
  `session_before_fork`, `session_fork`, `session_before_tree`,
  `session_tree`, `context`, `model_select`, and `user_bash`
- **hooks:** `subagent_start` and `subagent_stop` events via EventBus, with
  `agent_type` matcher field for filtering by agent name
- **hooks:** `notification` event via EventBus for observing notifications
- **hooks:** blocking support for `session_before_compact`,
  `session_before_switch`, `session_before_fork`, and `session_before_tree`
  events — hooks can cancel these operations
- **hooks:** matcher fields for `model_select` (`source`), `user_bash`
  (`command`), and `notification` (`type`)
- **mcp-adapter-tool:** SSE and Streamable HTTP transport support — connect to
  remote MCP servers via `{ "type": "sse", "url": "..." }` or
  `{ "type": "streamable-http", "url": "..." }` in settings.json
- **mcp-adapter-tool:** auto-reconnect with exponential backoff (1s/2s/4s, max
  3 attempts) for network transports on connection loss
- **mcp-adapter-tool:** `/mcp` command now shows transport type in server status
- **mcp-adapter-tool:** config validation for SSE/HTTP (url required) and STDIO
  (command required) with clear error messages
- **debug:** `/debug <query>` interactive troubleshooting command with
  `debug_inspect` tool for model-assisted log analysis
- **debug:** log query infrastructure (`queryLog()`) with category, event type,
  time range, and free-text search filters
- **debug:** analysis utilities — tool timing histograms, error grouping, and
  turn efficiency metrics

## [0.6.1](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.6.0...tallow-v0.6.1) (2026-02-15)


### Fixed

* **docs:** wrap extension badges, widen theme swatches on hover ([f59e833](https://github.com/dungle-scrubs/tallow/commit/f59e8334e3b85b27582fc0b10347e5d14b1209e5))

## [0.6.0](https://github.com/dungle-scrubs/tallow/compare/tallow-v0.5.0...tallow-v0.6.0) (2026-02-15)


### Added

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


### Fixed

* **ask-user-question:** restore loader after user answers ([744299e](https://github.com/dungle-scrubs/tallow/commit/744299e5ea1f87a8ed56dd6c4299882eb9f7d6bb))
* **bg:** force full re-render when dismissing /bg viewer ([7838f05](https://github.com/dungle-scrubs/tallow/commit/7838f054c5a2d6916914d153d8c2bbc8f7760dad))
* **ci:** build tallow-tui before typecheck and repair context-fork tests ([3adfe95](https://github.com/dungle-scrubs/tallow/commit/3adfe95e0c806adcb570688c722ff3577bcfee7a))
* **ci:** build tallow-tui before unit tests ([15cc68b](https://github.com/dungle-scrubs/tallow/commit/15cc68b12d1490dbfb1e2f794ee8d4cb4e57aef3))
* **ci:** bump feat commits to minor version, not patch ([c756410](https://github.com/dungle-scrubs/tallow/commit/c75641037718a4e8ae2bcaa3c60bb4d859eba1be))
* **ci:** remove inline release-type override, fix biome lint errors ([6c8b752](https://github.com/dungle-scrubs/tallow/commit/6c8b752fe639997266517488bbefdedff75659ad))
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


### Changed

* export internal pure functions for testing ([5d0f0cd](https://github.com/dungle-scrubs/tallow/commit/5d0f0cd5aca81bf090806d03a0f82c69262856db))
* export testable pure functions from extensions ([b21562f](https://github.com/dungle-scrubs/tallow/commit/b21562fd2a71bacfdc1fd860dbbe9a4b4142d435))
* **extensions:** migrate icons to registry ([fcdc2c5](https://github.com/dungle-scrubs/tallow/commit/fcdc2c56b67e3bfe84f8d77c9cfc764375a418ee))
* **icons:** extract random-spinner into standalone extension ([3422275](https://github.com/dungle-scrubs/tallow/commit/342227580e42bff080ea2406e94d9afc6140348b))
* rename web-fetch tool to web_fetch for snake_case consistency ([bfef264](https://github.com/dungle-scrubs/tallow/commit/bfef2642e1a00be384f988b78eadc5275855add0))
* **session-memory:** replace better-sqlite3 with sqlite adapter ([8d7c009](https://github.com/dungle-scrubs/tallow/commit/8d7c00992d9ee609b484d0efce3a6c32f08493c9))
* **session-namer:** remove /name command (now built-in) ([c750f8f](https://github.com/dungle-scrubs/tallow/commit/c750f8f095cdc3a13ebd0884084653b02e31368e))
* **shell:** route git helpers through policy wrapper ([22460ca](https://github.com/dungle-scrubs/tallow/commit/22460ca151f2ba9a5d63619c81a052fe607a1b06))
* **subagent:** rename chain mode to centipede ([3f91f91](https://github.com/dungle-scrubs/tallow/commit/3f91f91b0faf650ed394e19bf480796ed98861ec))
* **tasks:** consume typed interop snapshots ([96e66d6](https://github.com/dungle-scrubs/tallow/commit/96e66d697abb432cc0ef1cd09ec978d4ee39d218))
* **tasks:** split extension into domain modules ([b648dd7](https://github.com/dungle-scrubs/tallow/commit/b648dd78bfa6e46e07aa25505112faf7d5bd1c3d))
* **teams-tool:** replace hardcoded ANSI colors with theme tokens ([8e62cdc](https://github.com/dungle-scrubs/tallow/commit/8e62cdc67444858e79d56323b1d84ce2fc9f5cfc))
* **teams:** split runtime into domain modules ([f210fd7](https://github.com/dungle-scrubs/tallow/commit/f210fd79ac4dcc05a8d274dc82f658e353c5287b))


### Documentation

* add --tools flag to README, AGENTS.md, and changelog ([b6612af](https://github.com/dungle-scrubs/tallow/commit/b6612af94ef86a0ed4c89756f34ec6498d6ed8a0))
* add BASH_MAINTAIN_PROJECT_WORKING_DIR to changelog ([5676c90](https://github.com/dungle-scrubs/tallow/commit/5676c90687507955fd651bbf61a76c945da16878))
* add changelog page to docs site ([933e448](https://github.com/dungle-scrubs/tallow/commit/933e448985cd5a681e002f2168883b1413d430dc))
* add image metadata and format detection to changelog ([6f0f283](https://github.com/dungle-scrubs/tallow/commit/6f0f28325f409945e112d7c869615368757f9764))
* add inline agent results to changelog ([eb532d8](https://github.com/dungle-scrubs/tallow/commit/eb532d8510fd64ff2e1defd817129079b7df5077))
* add MCP server instructions to changelog ([3ee6b61](https://github.com/dungle-scrubs/tallow/commit/3ee6b615c7aeccd0833df9522ed3471e78177759))
* add MCP structured content to changelog ([315490c](https://github.com/dungle-scrubs/tallow/commit/315490c7b756920f581383e000a17326da599830))
* add npx as alternative install method ([170d83b](https://github.com/dungle-scrubs/tallow/commit/170d83b801626d91e8fb4b9a0d529e2806d96166))
* add piped stdin usage and examples ([3a5c80e](https://github.com/dungle-scrubs/tallow/commit/3a5c80ea40119d17dd17350db64b8ab92952a9b2))
* add pnpm/bun install alternatives ([11e4523](https://github.com/dungle-scrubs/tallow/commit/11e45237416606ab7675fe2d225ef088adfd4516))
* add project roadmap ([dadbaac](https://github.com/dungle-scrubs/tallow/commit/dadbaac5860695f7a5d5c21347ed2f5a11192931))
* add prompt-suggestions extension page, update extension counts ([4eca65d](https://github.com/dungle-scrubs/tallow/commit/4eca65d48df985505188ac09eeb9ea297cd7138f))
* add random-spinner and upstream-check pages, update extension docs ([c76dd8a](https://github.com/dungle-scrubs/tallow/commit/c76dd8aac0b87a0afda858e5138ff54e50235714))
* add resource_link support to changelog ([620e076](https://github.com/dungle-scrubs/tallow/commit/620e0763ca8ecc4a903375caf77f0f454cf9c5cd))
* add screenshot to README ([b880700](https://github.com/dungle-scrubs/tallow/commit/b8807009c483f087124b68dc9c98192596f5b620))
* add session-namer documentation and changelog entry ([4a272e8](https://github.com/dungle-scrubs/tallow/commit/4a272e8dc74ec0079ce6f3c2c3934e5e4856e8b2))
* add web-search-tool docs page and update extension count to 46 ([7de46bc](https://github.com/dungle-scrubs/tallow/commit/7de46bcb66314437b01400f7a65067d0e1befdaa))
* add wezterm pane control docs and refresh extension counts ([6f3d843](https://github.com/dungle-scrubs/tallow/commit/6f3d8433c01d7f7e18b35e8ffde49f310f78fb5e))
* **changelog:** add debug, shell interpolation, file reference entries ([09d7a9a](https://github.com/dungle-scrubs/tallow/commit/09d7a9aefd61e0d40e32f192e1b9ad1de9311c27))
* **changelog:** cut 0.2.0 and 0.3.0 release sections ([9742686](https://github.com/dungle-scrubs/tallow/commit/974268604552ddd0f46e1a1661089e7720463827))
* **changelog:** document shell-policy confirmation fix ([1a5f608](https://github.com/dungle-scrubs/tallow/commit/1a5f6088530da21c22753724340423d8a51e88a8))
* **changelog:** normalize release heading format ([aec44cf](https://github.com/dungle-scrubs/tallow/commit/aec44cfc3370f936a637dba8f0636c7795cd36e7))
* **changelog:** note interop events migration ([fa724c3](https://github.com/dungle-scrubs/tallow/commit/fa724c358d005d32834c7e824d0a3ad8ec690ad2))
* **changelog:** note tasks and teams module decomposition ([29c8434](https://github.com/dungle-scrubs/tallow/commit/29c8434bc3275fd2d7d3f3f61ffa499603fdb32d))
* clean changelog and refresh homepage feature listings ([42d1081](https://github.com/dungle-scrubs/tallow/commit/42d1081cc72eaf1f9995c9991174de76b86dc0ed))
* **edit-tool-enhanced:** document diff link and WezTerm handler ([bec58c7](https://github.com/dungle-scrubs/tallow/commit/bec58c7141f4876787202d0418d21d59e5c20363))
* fix /question description — introspection, not codebase Q&A ([5e52ec9](https://github.com/dungle-scrubs/tallow/commit/5e52ec920e6b987d435888e29856a4f9d369466d))
* fix drift across README, extension docs, and changelog ([87d830b](https://github.com/dungle-scrubs/tallow/commit/87d830b55704df93245238535e6f1fa005f2ce2a))
* fix drift across README, ROADMAP, and docs site ([1d67f81](https://github.com/dungle-scrubs/tallow/commit/1d67f81b540991172fe6df8185382aa13a9028d2))
* fix npm→bun drift and add docs impact checklist ([9848bed](https://github.com/dungle-scrubs/tallow/commit/9848bed940cbd0566b1bbba483d6a24e61e97a4b))
* fix stale counts in README and theme-selector metadata ([a323c0f](https://github.com/dungle-scrubs/tallow/commit/a323c0fe5a988ac474bd767489e9d253116675fb))
* **icons:** add icon configuration docs ([9587fe2](https://github.com/dungle-scrubs/tallow/commit/9587fe211cb2a8d1aac4544da839027331db27b5))
* **intro:** lead with tallow, update stale counts ([bc7a9b0](https://github.com/dungle-scrubs/tallow/commit/bc7a9b0cbcbac092fae9c0b679316db3f820b7b4))
* make extension chips fully clickable and non-wrapping ([e9f7971](https://github.com/dungle-scrubs/tallow/commit/e9f79713902918f86b00deb4550c159179a682b8))
* normalize changelog format and remove duplicate 0.5.0 entry ([f86a6d0](https://github.com/dungle-scrubs/tallow/commit/f86a6d088cec608cfdcbe138fa24fd44941916e7))
* prefer rebase merge for PRs ([78e725b](https://github.com/dungle-scrubs/tallow/commit/78e725b29ab13a13c9eec09a75d89c7998e96389))
* rewrite tallow-expert skill with accurate API surface ([3b213d5](https://github.com/dungle-scrubs/tallow/commit/3b213d53ed3333a21d7dff85ea9b0f6223c22056))
* **subagent-tool:** document inheritance, recovery, and defaults ([332051c](https://github.com/dungle-scrubs/tallow/commit/332051cd4e09933f52ab254a22375fdf58984d5f))
* sync changelog and docs with latest shipped features ([f0c3ccb](https://github.com/dungle-scrubs/tallow/commit/f0c3ccbc5875560a5a6daa69fb1b7053279e5fae))
* **teams-tool:** document dashboard controls and shortcuts ([496d0c4](https://github.com/dungle-scrubs/tallow/commit/496d0c49dd49b2b2a1cf4860bdf6bb41df9422d2))
* update changelog and extension counts for v0.2.0 ([045d661](https://github.com/dungle-scrubs/tallow/commit/045d66159f9c3e47a2f4dff8d719a2ac2192fbb5))
* update contributor commands to bun ([5ab760e](https://github.com/dungle-scrubs/tallow/commit/5ab760e1f5b68c1874682161e41d475278dc16f6))
* update documentation for plans 08-13 ([2160961](https://github.com/dungle-scrubs/tallow/commit/2160961c24cf9869f933a07fb3a1dc0837def9e1))
* update extension counts to 45 ([946a155](https://github.com/dungle-scrubs/tallow/commit/946a155a8fc2b9c6cde33e0b5131e122a002d14b))
* use npx tallow install in README ([2c8223a](https://github.com/dungle-scrubs/tallow/commit/2c8223a327d75b9b349e63a8a8650c1a31c3902f))


### Maintenance

* add 160 tests across high-risk extensions ([ae83713](https://github.com/dungle-scrubs/tallow/commit/ae8371331edb9ff8846bce7c1ddcad788349a718))
* add docs-drift checker to CI pipeline ([2e3b68a](https://github.com/dungle-scrubs/tallow/commit/2e3b68ab097b185a12b289908efb9632a21160b1))
* add integration and TUI snapshot tests ([ebe25ab](https://github.com/dungle-scrubs/tallow/commit/ebe25ab9cf49dbed76d32c37e88e7c09e3f42559))
* add justfile with common dev recipes ([20b1d54](https://github.com/dungle-scrubs/tallow/commit/20b1d547ad28f5cea5551a17ac199783b30880bd))
* add missing justfile recipes ([f2f4576](https://github.com/dungle-scrubs/tallow/commit/f2f4576b89efb14c67ff27edb54563691cd80ea3))
* **architecture:** add module boundary and size guards ([6a66dff](https://github.com/dungle-scrubs/tallow/commit/6a66dffbd2665d14ef43a135e842c03bf1661e63))
* bump version to 0.2.0 ([8354cd2](https://github.com/dungle-scrubs/tallow/commit/8354cd2a96177ab4cbee0316311894ae4ad043a8))
* bump version to 0.3.0 ([452df6c](https://github.com/dungle-scrubs/tallow/commit/452df6c73de1205d8e22481fd5adf4eac97a3f2c))
* **ci:** make nested guard test deterministic in headless envs ([c1e27f7](https://github.com/dungle-scrubs/tallow/commit/c1e27f78dcf6cb31d732fd26131037875a0de7a3))
* **cli:** add nested session guard integration tests ([1d810e6](https://github.com/dungle-scrubs/tallow/commit/1d810e694ccfc23b3dc883dde565bdcbbee804f1))
* **cli:** add piped stdin integration tests ([99a38a1](https://github.com/dungle-scrubs/tallow/commit/99a38a13ef5c460bd8a2ae5fa119dd982e564ef0))
* **docs:** add favicon, description, and og:image meta ([bb64725](https://github.com/dungle-scrubs/tallow/commit/bb647250918d890657ef1ca3b3ebbee9360ee0de))
* **edit-tool-enhanced:** add diff link unit tests ([357b3e2](https://github.com/dungle-scrubs/tallow/commit/357b3e2553af45c73adfb66a340095053f5576d5))
* **extensions:** add unit tests for pure functions ([d94c67f](https://github.com/dungle-scrubs/tallow/commit/d94c67fcf581d69f1f935730ba8798c0980621b2))
* gitignore .sidecar/ ([ce9fa00](https://github.com/dungle-scrubs/tallow/commit/ce9fa002b55d00642daac890814f1d69acf6d4f3))
* **git:** ignore ROADMAP.md ([aac90bd](https://github.com/dungle-scrubs/tallow/commit/aac90bd1e3bf647cf167c7765a9c3ec29f69fdc1))
* **gitignore:** ignore local keymap report ([d760bc5](https://github.com/dungle-scrubs/tallow/commit/d760bc54f82c80ebcadfc644641ee1585651a29a))
* **interop:** add cross-extension state-flow coverage ([aa040e8](https://github.com/dungle-scrubs/tallow/commit/aa040e8d8916b0ca78855f58238c6c638fdb60d7))
* **main:** release 0.4.0 ([#1](https://github.com/dungle-scrubs/tallow/issues/1)) ([259c9e2](https://github.com/dungle-scrubs/tallow/commit/259c9e2c6ee18dd060c4d10defb69fbaec582aa4))
* **main:** release 0.5.0 ([#2](https://github.com/dungle-scrubs/tallow/issues/2)) ([e969261](https://github.com/dungle-scrubs/tallow/commit/e969261c7e04c2845581d1d388194bdd83ad2075))
* make bun the canonical package manager ([d9f775a](https://github.com/dungle-scrubs/tallow/commit/d9f775ad540d58375a0f5bae0e37f3ab2e5c8f6d))
* migrate tallow-tui fork to workspace protocol ([03beed8](https://github.com/dungle-scrubs/tallow/commit/03beed8aef873893aaf377b3d10c8dc7af9b234b))
* **plan-mode:** add e2e for tool availability across mode transitions ([bfb812a](https://github.com/dungle-scrubs/tallow/commit/bfb812a4b8f1a7275ef11664b00c8c89a1bb63e3))
* **prompt-suggestions:** extract AutocompleteEngine, add 26 unit tests ([4bfa93e](https://github.com/dungle-scrubs/tallow/commit/4bfa93e0f07ec2c04782685f56d1b182421bd2f5))
* release v0.5.0 ([a65184f](https://github.com/dungle-scrubs/tallow/commit/a65184f992864623e3fe6ea3c2bd00aeb8ce9676))
* **release:** trigger release workflow ([1e3a1a8](https://github.com/dungle-scrubs/tallow/commit/1e3a1a8d43e48cb1b47f98f43da75c4537ce1fd6))
* run install and checks with bun only ([f7c5b16](https://github.com/dungle-scrubs/tallow/commit/f7c5b16270960f0543f26fa671f4148589950d88))
* **security:** verify shell commands not expanded on agent strings ([810120e](https://github.com/dungle-scrubs/tallow/commit/810120e0fe76316102c998d7dd31fc4288b93bbb))
* **shell-policy:** add confirmation flow integration coverage ([1ca275a](https://github.com/dungle-scrubs/tallow/commit/1ca275a1ec853907a38b59a5cf69e671f6ff4771))
* **tallow-tui:** add 7 tests for Editor.addChangeListener ([a785d97](https://github.com/dungle-scrubs/tallow/commit/a785d97eec6cb781739184f7cc69729c2cc86ecd))
* **tallow-tui:** add unit tests for core utilities ([159dd38](https://github.com/dungle-scrubs/tallow/commit/159dd38acdf04c1e4256c5a00c60a3313c9af4b2))
* **tasks:** add runtime and state/ui coverage ([0aa733c](https://github.com/dungle-scrubs/tallow/commit/0aa733c4290bb6df9dc307b7a30079dc211a70fd))
* **tasks:** add shouldClearOnAgentEnd unit tests ([528f8c6](https://github.com/dungle-scrubs/tallow/commit/528f8c6237390861a3939bedd014bed4c776fae7))
* **teams:** add runtime wiring integration coverage ([ec5d06e](https://github.com/dungle-scrubs/tallow/commit/ec5d06e3f1ba15ac2c1f33c03efe3e53f1ef6d6e))
* **teams:** add team_send wait=true cancellation tests ([91eede8](https://github.com/dungle-scrubs/tallow/commit/91eede88c50a2ec07549ef47f96a5e9bbb90a89e))

## [0.6.0-pre] - 2026-02-15

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
  - `/diagnostics` command for viewing, toggling, tailing, and clearing the log
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
