# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Commands

```bash
# Build (must build tallow-tui fork first)
bun run build

# Build tallow-tui fork only
cd packages/tallow-tui && bun run build

# Watch mode (core only — does NOT watch tallow-tui)
bun run dev

# Typecheck core
bun run typecheck

# Typecheck extensions (separate tsconfig)
bun run typecheck:extensions

# Lint + format
bun run lint
bun run lint:fix

# Tests (bun:test)
bun test                              # all tests
bun test extensions/tasks             # single extension's tests
bun test extensions/__integration__   # integration tests

# E2E: verify all slash commands register
node tests/e2e-commands.mjs

# Run from source
bun dist/cli.js
```

### Pre-commit hook

The husky hook runs `typecheck`, `typecheck:extensions`, and `lint-staged`
(biome check on staged files). All three must pass.

### CLI: `--tools` flag

Restrict which tools are available in a session. Accepts comma-separated
tool names or preset aliases.

**Individual tools:** `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

**Presets:**
- `readonly` → `read`, `grep`, `find`, `ls` (no file modifications, no shell)
- `coding` → `read`, `bash`, `edit`, `write` (default set)
- `none` → no tools (chat only)

```bash
tallow --tools readonly          # Safe exploration mode
tallow --tools read,grep,find    # Custom subset
tallow --tools none              # Pure conversation
```

When `--tools` is used, only the specified built-in tools are available.
Extension-registered tools (MCP adapters, enhanced versions, etc.) still
load normally — they wrap or extend the built-in tools that are present.

## Architecture

Tallow is a CLI coding agent built on the
[pi](https://github.com/nicobrinkkemper/pi-coding-agent) framework. The core
is thin — most functionality lives in bundled extensions.

### Core (`src/`)

| File | Role |
|------|------|
| `config.ts` | Identity constants, path resolution, env-var bootstrap. `TALLOW_HOME` resolves via `~/.config/tallow-work-dirs` overrides, falling back to `~/.tallow`. Env vars are set at **module scope** (not in `bootstrap()`) because ESM hoists imports — pi reads them before `bootstrap()` runs. `op://` secrets from `~/.tallow/.env` use a two-phase load: sync cache read in `bootstrap()`, then parallel async resolution in `resolveOpSecrets()` (called from `createTallowSession()`). Cache lives at `~/.tallow/.env.cache` with 1h TTL. |
| `sdk.ts` | `createTallowSession()` — the main entry point. Wires auth, models, settings, resource loading, session management, and extension discovery. Contains `rebrandSystemPrompt` (factory extension that rewrites pi → tallow in system prompts). |
| `cli.ts` | Commander CLI. Parses flags, calls `createTallowSession()`, dispatches to interactive/print/rpc mode. |
| `install.ts` | Interactive installer (clack prompts). Discovers bundled extensions/themes, copies templates to `~/.tallow/`. |
| `index.ts` | SDK public surface — re-exports from config, sdk, and pi framework. |

### Extension loading priority

`sdk.ts` discovers bundled extensions from `extensions/`, then checks
`~/.tallow/extensions/` for user overrides. If a user extension shares a
name with a bundled one, the bundled version is skipped and the user's
version loads instead. This is tracked in `extensionOverrides` and
surfaced to the user on startup.

### Extensions (`extensions/`)

Each extension is a directory with `extension.json` (metadata) and `index.ts`
(default export receiving `ExtensionAPI`). Extensions register tools, commands,
hooks, and event handlers through the pi framework API.

Extensions have a **separate tsconfig** (`tsconfig.extensions.json`) using
`moduleResolution: "bundler"` — different from core's `Node16`. Extension
tests use `bun:test` and live in `__tests__/` subdirectories. Integration
tests that need a full session use test-utils (`test-utils/session-runner.ts`,
`test-utils/mock-model.ts`).

Key patterns:
- Tools: `pi.registerTool({ name, parameters: Type.Object({...}), execute })` — uses `@sinclair/typebox` for schemas
- Commands: `pi.registerCommand("name", { description, handler })` — handler receives `(args, ctx)`
- Events: `pi.on("before_agent_start" | "context" | "turn_start" | ...)` — return mutations or void
- UI: `ctx.ui.notify()`, `ctx.ui.confirm()`, `ctx.ui.input()`, `ctx.ui.custom()`, `ctx.ui.setWorkingMessage()`

### Forked TUI (`packages/tallow-tui`)

`@mariozechner/pi-tui` is forked locally. Root `package.json` pins
`@mariozechner/pi-tui` to `file:packages/tallow-tui` in `devDependencies`.
Import paths stay the same — only the resolution target changes.

**You can modify TUI internals here.** After changes:
`cd packages/tallow-tui && bun run build`, then rebuild tallow.

Modified upstream files (conflict surface): `components/loader.ts`, `tui.ts`.
Added files (zero conflict): `border-styles.ts`, `components/bordered-box.ts`.

### Do NOT fork `pi-coding-agent`

`@mariozechner/pi-coding-agent` is consumed as a **published npm dependency**.
We forked `pi-tui` because TUI primitives needed direct extension — that is
the only fork we maintain and we do not plan another. Never fork or vendor
`pi-coding-agent`. Features that require framework changes go through
**upstream PRs**. If an upstream PR is blocked, work around it with extension
hooks, monkey-patches, or event listeners — not a local fork.

### Templates (`templates/`)

Markdown files for agents and slash commands, copied to `~/.tallow/` on install.
Users own these files and can edit them. These are NOT the bundled extensions —
they're user-facing prompt templates.

### Claude Code compatibility (`extensions/claude-bridge/`)

Tallow bridges `.claude/` directories so projects with Claude Code config
(skills, agents, commands in `.claude/`) work in tallow without changes.
Both `.tallow/` and `.claude/` are scanned; `.tallow/` takes precedence.

## Documentation Drift

When adding features, fixing bugs, or changing behavior, check all documentation
surfaces for consistency. These describe tallow's capabilities independently and
drift when updates touch one but not the others:

| Surface | Location | Owns |
|---------|----------|------|
| Docs website | `docs/` (Astro site — extension pages, guides, architecture) | Extension pages, guides, architecture |
| Docs website roadmap | `docs/src/content/docs/roadmap.mdx` | Planned/shipped features |
| ROADMAP.md | `ROADMAP.md` (root — planned/shipped features) | Planned/shipped features |
| README.md | `README.md` (root — feature list, extension count, overview) | Extension/theme/agent counts, feature list |
| Justfile | `justfile` (root — available commands/recipes) | Available dev commands |
| tallow-expert | `skills/tallow-expert/SKILL.md` + `~/.tallow/agents/tallow-expert.md` | Architecture knowledge |
| PR template | `.github/PULL_REQUEST_TEMPLATE.md` | Docs impact checklist |
| The codebase | Extensions, tools, commands, CLI flags — the source of truth | Everything |

The codebase is always authoritative. When in doubt, read the code and update
the docs to match — never the reverse.

### Automated drift detection

`node tests/docs-drift.mjs` verifies counts, docs page coverage, and
package-manager language. CI runs this on every PR — fix drift before merging.

### When you add/remove an extension

1. Update extension count in: `README.md`, `docs/.../index.mdx`,
   `docs/.../extensions/overview.mdx`, `docs/.../introduction.md`
2. Create/remove the docs page: `docs/src/content/docs/extensions/<name>.mdx`
3. Run `node tests/docs-drift.mjs` to verify

## Naming Conventions

### Tool names

Tool names registered via `pi.registerTool({ name })` use **snake_case**:
`web_fetch`, `web_search`, `ask_user_question`, `task_status`, `lsp_hover`.

The only exceptions are tools that shadow built-in pi framework tools and must
keep their original names: `bash`, `read`, `write`, `edit`, `cd`.

Extension *directory* names use kebab-case (`web-fetch-tool`, `bash-tool-enhanced`)
but the tool name inside is always snake_case.

## Code Style

- **Biome**: tabs, 100-char line width, double quotes, semicolons, ES5 trailing commas
- All functions require JSDoc with `@param` and `@returns`
- Commits use conventional commits (`feat:`, `fix:`, `docs:`, etc.)
- PRs use **rebase merge** (not squash) to preserve individual commits on main

### Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Release-please manages version bumps and PR creation, but **entries are
human-written** — never raw commit log dumps.

Entry format: `- **scope:** description of the change` (lowercase start, no period).
Multi-line entries indent continuation by 2 spaces. Group by: Added, Changed,
Fixed, Documentation, Deprecated, Removed, Security.

```markdown
## [Unreleased]

### Added

- **context-files:** `@import` directives with recursive resolution and
  circular import detection
- **health:** `/doctor` validation — 7 diagnostic checks with actionable
  suggestions

### Fixed

- **tui:** stop horizontal compression when height-clamping images
```

When updating the changelog:
- Add to `[Unreleased]` — release-please promotes it on release
- One bullet per logical change, not per commit
- Scope matches the extension or module name (`tui`, `sdk`, `core`, `deps`)
- Write for users reading release notes, not developers reading git log

Release-please (`release-please-config.json`) auto-generates entries from
conventional commits. Its output is a starting point — **clean up the release
PR's changelog edits** before merging to match this format. The GitHub Action
workflow is in `.github/workflows/release.yml`.

## Testing

Unit tests live in `extensions/<name>/__tests__/` and use `bun:test`.

Integration tests in `extensions/__integration__/` use `test-utils/session-runner.ts`
to create headless sessions with mock models (`test-utils/mock-model.ts`):

```typescript
import { createSessionRunner } from "../../test-utils/session-runner.js";
import { createScriptedStreamFn } from "../../test-utils/mock-model.js";

const runner = await createSessionRunner({
  extensionFactories: [myExtension],
  streamFn: createScriptedStreamFn([...]),
});
const result = await runner.prompt("test");
runner.dispose();
```
