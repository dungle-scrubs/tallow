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

When `--tools` is used, the final active tool set is restricted to the
explicit allowlist.
Extension-registered tools still load, but any tool whose name is not in the
allowlist is deactivated and blocked at runtime.

## Architecture

Tallow is a CLI coding agent built on the
[pi](https://github.com/nicobrinkkemper/pi-coding-agent) framework. The core
is thin — most functionality lives in bundled extensions.

### Core (`src/`)

| File | Role |
|------|------|
| `config.ts` | Identity constants, path resolution, env-var bootstrap. `TALLOW_HOME` resolves via `~/.config/tallow-work-dirs` overrides, falling back to `~/.tallow`. Env vars are set at **module scope** (not in `bootstrap()`) because ESM hoists imports — pi reads them before `bootstrap()` runs. `op://` secrets from `~/.tallow/.env` use a two-phase load: sync plain-value parse in `bootstrap()`, then parallel async `opchain` resolution in `resolveOpSecrets()` (called from `createTallowSession()`). Resolved values are kept in `process.env` only — never persisted to disk. |
| `sdk.ts` | `createTallowSession()` — the main entry point (~2900 lines). Wires auth, models, settings, resource loading, session management, extension discovery, and plugin resolution. Also defines inline factory extensions for: system-prompt rebranding, context-budget planning, tool-result retention/guarding, output truncation detection, project trust management, telemetry instrumentation, image path injection, and explicit tool restrictions. These are extension-shaped but live in core because they need closure over session-scoped state. |
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

### Extension startup policy (lazy `session_start`)

- Keep `session_start` handlers minimal and non-blocking.
- Defer heavy work (network connects, deep filesystem scans, index builds) to first-use triggers like
  `before_agent_start`, `input`, command handlers, or tool execution.
- Use `extensions/_shared/lazy-init.ts` for one-time execution with in-flight dedupe.
- If deferred setup fails, surface a clear `ctx.ui.notify(..., "error")` and keep retries deterministic.
- For diagnosis, set `TALLOW_STARTUP_TIMING=1` to emit `extension_lazy_init` timing samples.

## Extension-first policy (TUI fork is last resort)

**Default rule:** implement behavior in extensions first. Treat
`packages/tallow-tui` changes as exceptional.

Before touching the TUI fork, exhaust extension-level options:
- extension tools/commands/hooks/events
- prompt/template adjustments
- session/editor composition via existing APIs
- local monkey-patches that do not fork upstream packages

TUI fork changes are allowed only when **all** are true:
1. The requirement is a rendering/input primitive that cannot be achieved
   through extension APIs.
2. There is no viable upstream API today (or an upstream PR is pending/blocked).
3. The change is minimal, isolated, and avoids behavioral drift in unrelated
   components.
4. Conflict surface is documented (which upstream files were touched) and tests/docs
   are updated in the same PR.
5. No fork of `@mariozechner/pi-coding-agent` is introduced.

If any criterion fails, do not modify `packages/tallow-tui`.

### Forked TUI (`packages/tallow-tui`)

`@mariozechner/pi-tui` is forked locally. Root `package.json` pins
`@mariozechner/pi-tui` to `file:packages/tallow-tui` in `devDependencies`.
Import paths stay the same — only the resolution target changes.

**You can modify TUI internals here, but the fork is under active
reduction.** Do not assume the current delta is intentionally permanent.
Use the audit script for the authoritative file-level inventory. The
canonical generated status document is `docs/research/pi-tui-fork-audit.md`.

```bash
node scripts/audit-pi-tui-fork.mjs
```

The long-term keep surface is intentionally narrow:
- border styles
- loader global defaults and hide sentinel
- editor ghost-text and change-listener APIs
- minimal reset/render primitives still required by tallow

Everything else is a revert/extract/upstream candidate until proven
necessary. After changes:
`cd packages/tallow-tui && bun run build`, then rebuild tallow.

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

## Known Issues and Workarounds

### MiniMax auto-compaction fails with "Reasoning is mandatory for this endpoint"

`pi-coding-agent`'s `generateTurnPrefixSummary()` (used during context overflow
auto-compaction) does not pass a `reasoning` parameter to the pi-ai OpenRouter
handler. pi-ai then defaults to `reasoning: { effort: "none" }`, which MiniMax
rejects: **"Reasoning is mandatory for this endpoint and cannot be disabled."**

`generateSummary()` at the same file has the correct guard (`model.reasoning
? reasoning: "high" : …`) but `generateTurnPrefixSummary()` was missing it.

**Fix:** `node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js`
is patched automatically by `scripts/patch-upstream-debug.mjs` (runs as postinstall).
The patch adds `const completionOptions = model.reasoning
    ? { maxTokens, signal, apiKey, reasoning: "high" }
    : { maxTokens, signal, apiKey };` and passes `completionOptions` instead
of bare `{ maxTokens, signal, apiKey }`.

If the error recurs after `pnpm install`, reapply with:
`bun run postinstall` or `node scripts/patch-upstream-debug.mjs`.

Note: `src/model-metadata-overrides.ts` also adds `model.reasoning = false`
for MiniMax models to prevent `generateSummary()` from passing `reasoning: "high"`
when `model.reasoning` is `true` — but `generateTurnPrefixSummary()` bypasses
`model.reasoning` entirely, so both patches are required.

## Content Boundaries

`~/.config/tallow-work-dirs` and `~/.config/claude-work-dirs` are the
maintainer's personal setup files. They are NOT a tallow feature and must
never appear in documentation, guides, or user-facing text. The WezTerm Lua
config that reads them (`status.lua`) is likewise personal — do not document
WORK-indicator functionality as a tallow feature.

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

Docs/changelog drift is guarded by three focused checks plus one combined command:

- `node tests/docs-drift.mjs` — docs counts, page coverage, metadata, package links, and key docs/code parity
- `node tests/changelog-structure.mjs` — exactly one `[Unreleased]`, kept at the top
- `node tests/changelog-sync.mjs` — docs changelog sync wiring and generated output parity
- `bun run test:docs` / `just validate-docs` — runs the full docs/changelog validation suite

CI runs these on every PR — fix drift before merging.

### When you add/remove an extension

1. Update extension count in: `README.md`, `docs/.../index.mdx`,
   `docs/.../extensions/overview.mdx`, `docs/.../introduction.md`
2. Create/remove the docs page: `docs/src/content/docs/extensions/<name>.mdx`
3. Run `bun run test:docs` (or `just validate-docs`) to verify

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
- Before merging, verify all required checks are green with `gh pr checks <number>`

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
